//! Finite same-SID observation. Source credentials stay behind the existing
//! Worker gateway; the only decoder input is a bounded immutable byte pipe.
use super::*;
use anyhow::ensure;
use preview_input::hls_manifest::{Kind, Manifest};
use std::{process::Stdio, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
const MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_MANIFEST: usize = 256 * 1024;
const MAX_SEGMENTS: usize = 3;
const MAX_SECONDS: f64 = 24.0;

const AUTH_FROM: &str = "FROM playback_sessions p JOIN upstream_reservations u ON u.id=p.id JOIN rooms r ON r.id=p.room_id JOIN room_snapshots s ON s.room_id=p.room_id JOIN media_items mi ON mi.id=p.media_id";
const AUTH_ALLOWED: &str = "p.id=$1 AND NOT p.stopped AND p.expires_at>clock_timestamp() AND r.lifecycle='active' AND r.lifecycle_epoch=p.lifecycle_epoch AND (s.state->>'media_generation')::bigint=p.generation AND (p.viewer_id IS NULL OR EXISTS(SELECT 1 FROM playback_viewer_plans v WHERE v.user_id=p.user_id AND v.room_id=p.room_id AND v.viewer_id=p.viewer_id AND v.plan_generation=p.plan_generation AND v.auth_login_hash=p.auth_login_hash)) AND playback_source_allowed(p.media_id,p.resource,p.id) AND u.state='active' AND u.negotiation='received' AND u.play_session_id=$2 AND u.auth_login_hash IS NOT NULL AND ROW(p.user_id,p.room_id,p.media_id,p.generation,p.lifecycle_epoch,p.auth_login_hash,p.auth_membership_epoch) IS NOT DISTINCT FROM ROW(u.user_id,u.room_id,u.media_id,u.generation,u.lifecycle_epoch,u.auth_login_hash,u.auth_membership_epoch) AND mi.source_id=u.source_id AND p.resource->>'source_policy_revision'=u.source_policy_revision::text AND (p.resource->>'account_policy_generation')::bigint IS NOT DISTINCT FROM u.account_policy_generation AND playback_origin_allowed(u.user_id,u.room_id,u.auth_login_hash,u.auth_membership_epoch) AND source_account_policy_allowed(u.source_id,u.source_policy_revision,u.account_policy_generation)";
const SCOPE: &str = "jsonb_build_object('user',p.user_id,'room',p.room_id,'media',p.media_id,'generation',p.generation,'lifecycle',p.lifecycle_epoch,'login',p.auth_login_hash,'member',p.auth_membership_epoch,'viewer',p.viewer_id,'plan',p.plan_generation,'source',u.source_id,'source_revision',u.source_policy_revision,'account_generation',u.account_policy_generation,'device',u.device_id,'media_source',u.media_source_id,'live_stream',u.live_stream_id,'origin',u.origin_key,'negotiation_response',u.response_encrypted)";
struct Binding {
    resource: Value,
    scope: Value,
    digest: String,
}
fn frozen_sql() -> String {
    format!(
        "SELECT EXISTS(SELECT 1 {AUTH_FROM} WHERE {AUTH_ALLOWED} AND p.resource=$3 AND {SCOPE}=$4)"
    )
}
async fn bind_original(
    app: &App,
    id: Uuid,
    sid: &str,
    resource: &Value,
) -> anyhow::Result<Binding> {
    let row = sqlx::query(&format!(
        "SELECT p.resource,{SCOPE} AS scope {AUTH_FROM} WHERE {AUTH_ALLOWED}"
    ))
    .bind(id)
    .bind(sid)
    .fetch_optional(&app.db)
    .await?
    .ok_or_else(|| anyhow::anyhow!("upstream_output_authority_lost"))?;
    let outer: Value = row.get("resource");
    ensure!(
        decrypt(
            app,
            outer["encrypted"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("upstream_output_binding_invalid"))?
        )? == *resource,
        "upstream_output_resource_changed"
    );
    let scope: Value = row.get("scope");
    let digest = hash(&json!({"resource":outer,"scope":scope}).to_string());
    Ok(Binding {
        resource: outer,
        scope,
        digest,
    })
}
async fn authority(app: &App, id: Uuid, sid: &str, binding: &Binding) -> anyhow::Result<()> {
    let allowed: bool = sqlx::query_scalar(&frozen_sql())
        .bind(id)
        .bind(sid)
        .bind(&binding.resource)
        .bind(&binding.scope)
        .fetch_one(&app.db)
        .await?;
    ensure!(allowed, "upstream_output_authority_lost");
    Ok(())
}
async fn publish(
    app: &App,
    id: Uuid,
    sid: &str,
    owner: Uuid,
    binding: &Binding,
    value: &Value,
) -> anyhow::Result<()> {
    let mut tx = app.db.begin().await?;
    sqlx::query("SET LOCAL statement_timeout='750ms'")
        .execute(&mut *tx)
        .await?;
    let uuid = |name: &str| -> anyhow::Result<Uuid> {
        Ok(Uuid::parse_str(binding.scope[name].as_str().ok_or_else(
            || anyhow::anyhow!("upstream_output_binding_invalid"),
        )?)?)
    };
    persistence::room_lifecycle::lock_epoch(
        &mut tx,
        uuid("room")?,
        binding.scope["lifecycle"]
            .as_i64()
            .ok_or_else(|| anyhow::anyhow!("upstream_output_binding_invalid"))?,
    )
    .await?;
    let member = persistence::media_authorization::capture(
        &mut tx,
        uuid("user")?,
        uuid("room")?,
        binding.scope["login"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("upstream_output_binding_invalid"))?,
    )
    .await?;
    ensure!(
        member == Some(uuid("member")?),
        "upstream_output_authority_lost"
    );
    ensure!(
        persistence::source_account_policy::lock_session(&mut tx, id).await?,
        "upstream_output_authority_lost"
    );
    sqlx::query("SELECT id FROM playback_sessions WHERE id=$1 FOR SHARE")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query("SELECT id FROM upstream_reservations WHERE id=$1 FOR SHARE")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query("SELECT session_id FROM upstream_output_observations WHERE session_id=$1 AND owner_id=$2 FOR UPDATE").bind(id).bind(owner).fetch_one(&mut *tx).await?;
    let allowed: bool = sqlx::query_scalar(&frozen_sql())
        .bind(id)
        .bind(sid)
        .bind(&binding.resource)
        .bind(&binding.scope)
        .fetch_one(&mut *tx)
        .await?;
    ensure!(allowed, "upstream_output_authority_lost");
    let changed=sqlx::query("UPDATE upstream_output_observations SET state='measured',facts=$3,completed_at=clock_timestamp() WHERE session_id=$1 AND owner_id=$2 AND binding_sha256=$4 AND state='running'").bind(id).bind(owner).bind(value).bind(&binding.digest).execute(&mut *tx).await?.rows_affected();
    ensure!(changed == 1, "upstream_output_observation_lost");
    let allowed: bool = sqlx::query_scalar(&frozen_sql())
        .bind(id)
        .bind(sid)
        .bind(&binding.resource)
        .bind(&binding.scope)
        .fetch_one(&mut *tx)
        .await?;
    ensure!(allowed, "upstream_output_authority_lost");
    tx.commit().await?;
    Ok(())
}
fn gateway_child(base: &url::Url, reference: &str, id: Uuid) -> anyhow::Result<url::Url> {
    let target = base.join(reference)?;
    ensure!(
        target.origin() == base.origin()
            && target.path().starts_with(&format!("/media-delivery/{id}/"))
            && target.username().is_empty()
            && target.password().is_none()
            && target.fragment().is_none(),
        "upstream_output_gateway_required"
    );
    Ok(target)
}
async fn get(
    app: &App,
    id: Uuid,
    sid: &str,
    binding: &Binding,
    url: &url::Url,
    maximum: usize,
) -> anyhow::Result<Vec<u8>> {
    authority(app, id, sid, binding).await?;
    let response = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()?
        .get(url.clone())
        .header(header::ACCEPT_ENCODING, "identity")
        .send()
        .await?;
    ensure!(
        response.status() == StatusCode::OK
            && response
                .headers()
                .get_all(header::CONTENT_ENCODING)
                .iter()
                .all(|v| v.as_bytes().eq_ignore_ascii_case(b"identity"))
            && response
                .content_length()
                .is_none_or(|n| n <= maximum as u64),
        "upstream_output_response_bound"
    );
    let expected = response.content_length();
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        authority(app, id, sid, binding).await?;
        let chunk = chunk?;
        ensure!(
            bytes.len() + chunk.len() <= maximum,
            "upstream_output_bytes_bound"
        );
        bytes.extend_from_slice(&chunk);
    }
    ensure!(
        !bytes.is_empty() && expected.is_none_or(|n| n == bytes.len() as u64),
        "upstream_output_truncated"
    );
    Ok(bytes)
}
#[derive(Debug)]
struct Window {
    init: Option<String>,
    segments: Vec<(String, f64)>,
    format: &'static str,
}
fn window(text: &str) -> anyhow::Result<Window> {
    let parsed = Manifest::parse(text)?;
    parsed.require_continuous_timeline()?;
    ensure!(
        !parsed
            .references()
            .iter()
            .any(|r| matches!(r.kind, Kind::Key | Kind::Data | Kind::Playlist)),
        "upstream_output_single_muxed_playlist_required"
    );
    let mut init = None;
    let mut duration = None;
    let mut segments = Vec::new();
    let mut seconds = 0.0;
    for line in text.lines() {
        if line.starts_with("#EXT-X-BYTERANGE") || line.starts_with("#EXT-X-PART") {
            anyhow::bail!("upstream_output_range_unsupported");
        }
        if line.starts_with("#EXT-X-MAP:") {
            ensure!(init.is_none(), "upstream_output_single_init_required");
            let reference = parsed
                .references()
                .iter()
                .find(|r| r.kind == Kind::Initialization)
                .ok_or_else(|| anyhow::anyhow!("upstream_output_init_required"))?;
            ensure!(
                !line.contains("BYTERANGE="),
                "upstream_output_range_unsupported"
            );
            init = Some(reference.uri.to_owned());
        } else if let Some(raw) = line.strip_prefix("#EXTINF:") {
            let value = raw.split(',').next().unwrap_or("").parse::<f64>()?;
            ensure!(
                value.is_finite() && value > 0.0 && value <= MAX_SECONDS && duration.is_none(),
                "upstream_output_duration_bound"
            );
            duration = Some(value);
        } else if !line.is_empty() && !line.starts_with('#') {
            let value = duration
                .take()
                .ok_or_else(|| anyhow::anyhow!("upstream_output_duration_required"))?;
            if segments.len() < MAX_SEGMENTS && seconds + value <= MAX_SECONDS {
                seconds += value;
                segments.push((line.trim().to_owned(), value));
            } else {
                break;
            }
        }
    }
    ensure!(!segments.is_empty(), "upstream_output_empty_window");
    Ok(Window {
        format: if init.is_some() { "mp4" } else { "mpegts" },
        init,
        segments,
    })
}
fn number(value: &Value) -> Option<u32> {
    value
        .as_u64()
        .or_else(|| value.as_str()?.parse().ok())
        .and_then(|n| u32::try_from(n).ok())
        .filter(|n| *n > 0)
}
fn output_facts(
    probe: &Value,
) -> anyhow::Result<(
    protocol::UpstreamMeasuredVideo,
    Option<protocol::UpstreamMeasuredAudio>,
)> {
    let streams = probe["streams"]
        .as_array()
        .filter(|s| s.len() <= 2)
        .ok_or_else(|| anyhow::anyhow!("upstream_output_stream_bound"))?;
    let video: Vec<_> = streams
        .iter()
        .filter(|s| s["codec_type"] == "video")
        .collect();
    let audio: Vec<_> = streams
        .iter()
        .filter(|s| s["codec_type"] == "audio")
        .collect();
    ensure!(
        video.len() == 1 && audio.len() <= 1 && video.len() + audio.len() == streams.len(),
        "upstream_output_track_bound"
    );
    let v = video[0];
    media_core::capabilities::validate_source(probe)?;
    let (n, d) = v["avg_frame_rate"]
        .as_str()
        .and_then(|s| s.split_once('/'))
        .ok_or_else(|| anyhow::anyhow!("upstream_output_rate_unknown"))?;
    let rate = n.parse::<f64>()? / d.parse::<f64>()?;
    ensure!(
        v["codec_name"] == "h264"
            && matches!(
                v["profile"].as_str(),
                Some("Constrained Baseline" | "Baseline" | "Main" | "High")
            )
            && matches!(v["pix_fmt"].as_str(), Some("yuv420p" | "yuvj420p"))
            && rate.is_finite()
            && rate > 0.0
            && rate <= 60.0,
        "upstream_output_video_unsupported"
    );
    let video = protocol::UpstreamMeasuredVideo {
        codec: "h264".into(),
        profile: v["profile"].as_str().unwrap().into(),
        width: number(&v["width"])
            .filter(|n| *n <= 1920)
            .ok_or_else(|| anyhow::anyhow!("upstream_output_width_bound"))?,
        height: number(&v["height"])
            .filter(|n| *n <= 1080)
            .ok_or_else(|| anyhow::anyhow!("upstream_output_height_bound"))?,
        pixel_format: v["pix_fmt"].as_str().unwrap().into(),
        frame_rate: rate,
        decoded_frames: number(&v["nb_read_frames"])
            .filter(|n| *n <= 1440)
            .ok_or_else(|| anyhow::anyhow!("upstream_output_no_decoded_video"))?,
    };
    let audio = audio
        .first()
        .map(|a| -> anyhow::Result<_> {
            ensure!(
                a["codec_name"] == "aac" && a["profile"] == "LC",
                "upstream_output_audio_unsupported"
            );
            Ok(protocol::UpstreamMeasuredAudio {
                codec: "aac".into(),
                profile: "LC".into(),
                sample_rate: number(&a["sample_rate"])
                    .filter(|n| [44100, 48000].contains(n))
                    .ok_or_else(|| anyhow::anyhow!("upstream_output_audio_rate_unknown"))?,
                channels: number(&a["channels"])
                    .filter(|n| *n <= 2)
                    .ok_or_else(|| anyhow::anyhow!("upstream_output_audio_channels"))?,
                decoded_frames: number(&a["nb_read_frames"])
                    .filter(|n| *n <= 2300)
                    .ok_or_else(|| anyhow::anyhow!("upstream_output_no_decoded_audio"))?,
            })
        })
        .transpose()?;
    Ok((video, audio))
}
fn probe_command(format: &str) -> anyhow::Result<tokio::process::Command> {
    ensure!(matches!(format, "mp4" | "mpegts"), "upstream_output_format");
    let mut command = tokio::process::Command::new("ffprobe");
    crate::native_platform_transcode::clean_native_environment(&mut command);
    command
        .args([
            "-v",
            "error",
            "-max_alloc",
            "67108864",
            "-probesize",
            "16777216",
            "-analyzeduration",
            "5000000",
            "-threads",
            "1",
            "-protocol_whitelist",
            "pipe",
            "-format_whitelist",
            if format == "mp4" { "mov" } else { "mpegts" },
            "-f",
            format,
            "-i",
            "pipe:0",
            "-count_frames",
            "-show_streams",
            "-show_data",
            "-of",
            "json",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    media_core::bounded_decode::install(&mut command)?;
    Ok(command)
}
async fn probe(bytes: Vec<u8>, format: &str) -> anyhow::Result<Value> {
    let mut child = child_process::spawn(probe_command(format)?)?;
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let result = tokio::time::timeout(Duration::from_secs(20), async {
        let (_, out, err, status) = tokio::try_join!(
            async {
                stdin.write_all(&bytes).await?;
                stdin.shutdown().await?;
                Ok::<_, anyhow::Error>(())
            },
            async {
                let mut b = Vec::new();
                stdout.take(2 * 1024 * 1024 + 1).read_to_end(&mut b).await?;
                ensure!(b.len() <= 2 * 1024 * 1024, "upstream_output_probe_bound");
                Ok::<_, anyhow::Error>(b)
            },
            async {
                let mut b = Vec::new();
                stderr.take(65537).read_to_end(&mut b).await?;
                ensure!(b.is_empty(), "upstream_output_decode_error");
                Ok::<_, anyhow::Error>(b)
            },
            async { Ok::<_, anyhow::Error>(child.wait().await?) }
        )?;
        let _ = err;
        ensure!(status.success(), "upstream_output_probe_failed");
        Ok::<_, anyhow::Error>(serde_json::from_slice(&out)?)
    })
    .await;
    match result {
        Ok(Ok(value)) => Ok(value),
        other => {
            child.kill().await?;
            child.wait().await?;
            other.map_err(|_| anyhow::anyhow!("upstream_output_probe_deadline"))?
        }
    }
}

pub(crate) async fn response(
    app: &App,
    id: Uuid,
    resource: &Value,
    q: &Params,
    head: bool,
) -> Result<Response> {
    if head
        || q.url.is_some()
        || q.attempt.is_some()
        || q.execution.is_some()
        || !matches!(resource["kind"].as_str(), Some("jellyfin" | "emby"))
        || resource["upstream_profile_binding_hash"].as_str().is_none()
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "upstream_output_profile_required".into(),
        ));
    }
    let sid = resource["upstream_session"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| failure("upstream_output_sid"))?;
    let route = resource["url"]
        .as_str()
        .ok_or_else(|| failure("upstream_output_route"))?;
    let binding = bind_original(app, id, sid, resource)
        .await
        .map_err(failure)?;
    authority(app, id, sid, &binding).await.map_err(failure)?;
    let sid_hash = hash(sid);
    let route_hash = hash(route);
    let owner = Uuid::new_v4();
    let inserted=sqlx::query("INSERT INTO upstream_output_observations(session_id,owner_id,sid_sha256,route_sha256,binding_sha256,state) VALUES($1,$2,$3,$4,$5,'running') ON CONFLICT(session_id) DO NOTHING").bind(id).bind(owner).bind(&sid_hash).bind(&route_hash).bind(&binding.digest).execute(&app.db).await.map_err(failure)?.rows_affected()==1;
    if !inserted {
        let row=sqlx::query("SELECT state,facts,sid_sha256,route_sha256,binding_sha256 FROM upstream_output_observations WHERE session_id=$1").bind(id).fetch_one(&app.db).await.map_err(failure)?;
        if row.get::<String, _>("state") == "measured"
            && row.get::<String, _>("sid_sha256") == sid_hash
            && row.get::<String, _>("route_sha256") == route_hash
            && row.get::<String, _>("binding_sha256") == binding.digest
        {
            return Ok(axum::Json(row.get::<Value, _>("facts")).into_response());
        }
        return Err((StatusCode::CONFLICT, "upstream_output_unavailable".into()));
    }
    let permit = app
        .probes
        .clone()
        .try_acquire_owned()
        .map_err(|_| (StatusCode::TOO_MANY_REQUESTS, "probe_busy".into()))?;
    // Inherit the existing non-cancellable delivery process scope. A nested
    // scope would hide children from its mandatory cancellation/drain receipt.
    let result = tokio::time::timeout(Duration::from_secs(35), async {
        let base = url::Url::parse(&source_url(id, &q.token)?)?;
        let first = get(app, id, sid, &binding, &base, MAX_MANIFEST).await?;
        let first = String::from_utf8(first)?;
        let parsed = Manifest::parse(&first)?;
        let media: Vec<_> = parsed
            .references()
            .iter()
            .filter(|r| r.kind == Kind::Playlist)
            .collect();
        let (playlist, base) = if media.is_empty() {
            (first, base)
        } else {
            ensure!(
                media.len() == 1 && parsed.references().len() == 1,
                "upstream_output_single_variant_required"
            );
            let url = gateway_child(&base, media[0].uri, id)?;
            (
                String::from_utf8(get(app, id, sid, &binding, &url, MAX_MANIFEST).await?)?,
                url,
            )
        };
        let window = window(&playlist)?;
        let mut bytes = Vec::new();
        if let Some(init) = &window.init {
            bytes.extend(
                get(
                    app,
                    id,
                    sid,
                    &binding,
                    &gateway_child(&base, init, id)?,
                    2 * 1024 * 1024,
                )
                .await?,
            );
        }
        for (segment, _) in &window.segments {
            bytes.extend(
                get(
                    app,
                    id,
                    sid,
                    &binding,
                    &gateway_child(&base, segment, id)?,
                    MAX_BYTES - bytes.len(),
                )
                .await?,
            );
        }
        let measured_bytes = u32::try_from(bytes.len())?;
        let representation_sha256 = hex::encode(Sha256::digest(&bytes));
        let probe = probe(bytes, window.format).await?;
        authority(app, id, sid, &binding).await?;
        let (video, audio) = output_facts(&probe)?;
        let plan_generation: Option<i64> =
            sqlx::query_scalar("SELECT plan_generation FROM playback_sessions WHERE id=$1")
                .bind(id)
                .fetch_one(&app.db)
                .await?;
        Ok::<_, anyhow::Error>(protocol::UpstreamMeasuredOutput {
            schema_version: 1,
            semantics: "finite_same_sid_output_not_whole_title".into(),
            session_id: id,
            plan_generation: plan_generation.map(u32::try_from).transpose()?,
            upstream_sid_sha256: sid_hash,
            route_sha256: route_hash,
            representation_sha256,
            measured_bytes,
            measured_segments: window.segments.len() as u8,
            manifest_duration_ms: window.segments.iter().map(|(_, n)| n).sum::<f64>() * 1000.0,
            video,
            audio,
            process_tree_reaped: true,
        })
    })
    .await;
    drop(permit);
    let result = match result {
        Ok(result) => result,
        _ => Err(anyhow::anyhow!("upstream_output_unknown")),
    };
    match result {
        Ok(facts) => {
            authority(app, id, sid, &binding).await.map_err(failure)?;
            let value = serde_json::to_value(facts).map_err(failure)?;
            publish(app, id, sid, owner, &binding, &value)
                .await
                .map_err(failure)?;
            Ok(axum::Json(value).into_response())
        }
        Err(_) => {
            sqlx::query("UPDATE upstream_output_observations SET state=$3,completed_at=clock_timestamp() WHERE session_id=$1 AND owner_id=$2 AND state='running'").bind(id).bind(owner).bind("unknown").execute(&app.db).await.map_err(failure)?;
            Err(failure("upstream_output_failed"))
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_window_does_not_claim_the_whole_playlist() {
        let w=window("#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:4,\na.ts\n#EXTINF:4,\nb.ts\n#EXTINF:4,\nc.ts\n#EXTINF:4,\nd.ts\n").unwrap();
        assert_eq!(w.segments.len(), 3);
        assert_eq!(w.format, "mpegts");
        for bad in [
            "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"k\"\n#EXTINF:4,\na.ts\n",
            "#EXTM3U\n#EXTINF:4,\n#EXT-X-BYTERANGE:10@0\na.ts\n",
            "#EXTM3U\n#EXTINF:25,\na.ts\n",
        ] {
            assert!(window(bad).is_err());
        }
    }
    #[test]
    fn decoder_never_receives_gateway_or_upstream_urls() {
        let c = probe_command("mpegts").unwrap();
        let args: Vec<_> = c.as_std().get_args().map(|a| a.to_str().unwrap()).collect();
        assert!(
            args.windows(2)
                .any(|a| a == ["-protocol_whitelist", "pipe"])
        );
        assert!(args.windows(2).any(|a| a == ["-i", "pipe:0"]));
        assert!(args.contains(&"-count_frames"));
        assert!(probe_command("hls").is_err());
    }
    #[test]
    fn measured_output_requires_decoded_facts_and_distinguishes_emby_rates() {
        let mut p = json!({"streams":[{"codec_type":"video","codec_name":"h264","profile":"Main","pix_fmt":"yuv420p","color_transfer":"bt709","width":1280,"height":720,"avg_frame_rate":"30/1","nb_read_frames":"120"},{"codec_type":"audio","codec_name":"aac","profile":"LC","sample_rate":"44100","channels":2,"nb_read_frames":"173"}]});
        assert_eq!(output_facts(&p).unwrap().1.unwrap().sample_rate, 44100);
        p["streams"][1]["sample_rate"] = json!("48000");
        assert_eq!(output_facts(&p).unwrap().1.unwrap().sample_rate, 48000);
        p["streams"][1]["nb_read_frames"] = Value::Null;
        assert!(output_facts(&p).is_err());
    }
}
