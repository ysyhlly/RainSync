//! Ordinary-job advanced recipes use the existing claim, attempt, process
//! scope, source-version monitor and immutable-output publication gates.
use anyhow::{Result, ensure};
use media_core::advanced_media::{
    EncoderPreference, EncoderSelection, Input, Inventory, OwnedLocalInput, Recipe, Request,
    WorkerGatewayInput,
};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

pub const ENCODER_SETTING: &str = "RAINSYNC_VIDEO_ENCODER";
pub fn preference_from_env() -> Result<EncoderPreference> {
    EncoderPreference::parse(&std::env::var(ENCODER_SETTING).unwrap_or_else(|_| "software".into()))
}
pub fn request(spec: &Value) -> Result<Option<Request>> {
    let Some(value) = spec.get("advanced_media") else {
        return Ok(None);
    };
    let request: Request = serde_json::from_value(value.clone())?;
    request.validate()?;
    ensure!(
        request.requires_transform(),
        "advanced_media_transform_required"
    );
    ensure!(
        matches!(
            spec["kind"].as_str(),
            Some(
                "advanced_local_transcode_v1"
                    | "advanced_owned_local_transcode_v1"
                    | "advanced_owned_remote_transcode_v1"
                    | "remote_asset_transcode_v1"
            )
        ) && spec["recipe_version"].as_u64() == Some(1),
        "advanced_media_recipe_contract_required"
    );
    ensure!(
        spec["negotiated_mode"] == "transcode",
        "advanced_media_requires_transcode"
    );
    ensure!(
        matches!(
            spec["source_kind"].as_str(),
            Some("local" | "agent" | "http")
        ) && (spec["source_kind"] == "local")
            == matches!(
                spec["kind"].as_str(),
                Some("advanced_local_transcode_v1" | "advanced_owned_local_transcode_v1")
            ),
        "advanced_media_requires_local_source"
    );
    ensure!(
        (spec["source_kind"] == "http" && spec["source_version"].is_null())
            || spec["source_version"]
                .as_str()
                .is_some_and(media_core::file_version::valid_file_version),
        "advanced_media_source_version_required"
    );
    if spec["kind"] == "advanced_local_transcode_v1" {
        ensure!(
            spec.get("advanced_assets").is_none()
                && spec.get("held_input_bytes").is_none()
                && spec.get("remote_duration_seconds").is_none(),
            "advanced_owned_queue_required"
        );
    }
    if spec["kind"] == "advanced_owned_local_transcode_v1" {
        ensure!(
            spec.get("advanced_assets").is_some()
                && spec.get("held_input_bytes").is_none()
                && spec.get("remote_duration_seconds").is_none(),
            "advanced_asset_custody_required"
        );
    }
    if spec["source_kind"] != "local" {
        ensure!(
            spec["held_input_bytes"]
                .as_u64()
                .is_some_and(|n| (1..=2 * 1024 * 1024 * 1024).contains(&n)),
            "advanced_remote_input_bound"
        );
        ensure!(
            spec.get("advanced_assets").is_none() && spec.get("advanced_remote_assets").is_none()
                || spec["kind"] == "remote_asset_transcode_v1",
            "advanced_remote_external_assets_unsupported"
        );
        ensure!(
            spec["remote_duration_seconds"]
                .as_f64()
                .is_some_and(|n| n.is_finite()
                    && (0.001..=21600.0).contains(&n)
                    && spec["start_seconds"]
                        .as_f64()
                        .is_some_and(|start| start < n)),
            "advanced_remote_timeline_bound"
        );
    }
    if spec["kind"] == "remote_asset_transcode_v1" {
        let remote: media_core::advanced_media::RemoteAssetCatalog =
            serde_json::from_value(spec["advanced_remote_assets"].clone())?;
        remote.validate(
            spec["source_kind"].as_str().unwrap_or(""),
            spec["resource"].as_str().unwrap_or(""),
            spec["source_version"].as_str(),
        )?;
        ensure!(
            serde_json::to_value(&remote.catalog)? == spec["advanced_assets"],
            "advanced_asset_source_binding_required"
        );
        if let Some(pin) = remote.source_http {
            ensure!(
                pin.bytes == spec["held_input_bytes"].as_u64().unwrap_or(0),
                "source_changed"
            );
        }
    } else if spec.get("advanced_remote_assets").is_some() {
        anyhow::bail!("advanced_owned_queue_required");
    }
    if spec["source_kind"] == "local"
        && let Some(value) = spec.get("advanced_assets")
    {
        let catalog: media_core::advanced_media::AssetCatalog =
            serde_json::from_value(value.clone())?;
        catalog.validate(
            spec["resource"].as_str().unwrap_or(""),
            spec["source_version"].as_str().unwrap_or(""),
        )?;
    }
    Ok(Some(request))
}

/// The dedicated queue's recognized closed contract is the only exception to
/// the pre-wave generic marker refusal. Validate before cache/input side effects.
pub fn admit_claim(spec: &Value) -> Result<bool> {
    let marked = spec.get("advanced_media").is_some()
        || spec.get("advanced_remote_assets").is_some()
        || spec["kind"] == "remote_asset_transcode_v1"
        || spec["kind"].as_str().is_some_and(|kind| {
            kind.starts_with("advanced_local") || kind.starts_with("advanced_owned")
        });
    if !marked {
        return Ok(false);
    }
    let object = spec
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("advanced_media_job_invalid"))?;
    const FIELDS: &[&str] = &[
        "kind",
        "recipe_version",
        "advanced_media",
        "root",
        "resource",
        "source_kind",
        "input_ticket",
        "start_seconds",
        "transcode",
        "audio_index",
        "estimated_output_bytes",
        "negotiated_mode",
        "source_version",
    ];
    ensure!(
        object.keys().all(|key| FIELDS.contains(&key.as_str())
            || matches!(
                key.as_str(),
                "advanced_assets"
                    | "advanced_remote_assets"
                    | "held_input_bytes"
                    | "remote_duration_seconds"
            ))
            && FIELDS.iter().all(|key| object.contains_key(*key)),
        "advanced_media_job_invalid"
    );
    ensure!(
        spec["advanced_media"].as_object().is_some_and(|intent| [
            "schema_version",
            "tone_map_hdr",
            "subtitle_stream_index"
        ]
        .iter()
        .all(|key| intent.contains_key(*key))),
        "advanced_media_job_invalid"
    );
    ensure!(
        request(spec)?.is_some(),
        "advanced_media_recipe_contract_required"
    );
    ensure!(
        spec["transcode"] == true
            && spec["root"]
                .as_str()
                .is_some_and(|value| spec["source_kind"] != "local" || !value.is_empty())
            && spec["resource"]
                .as_str()
                .is_some_and(|value| !value.is_empty())
            && spec["input_ticket"]
                .as_str()
                .is_some_and(|value| !value.is_empty())
            && spec["start_seconds"].as_f64().is_some_and(
                |value| value.is_finite() && (0.0..=9_007_199_254_740.0).contains(&value)
            )
            && (spec["audio_index"].is_null()
                || spec["audio_index"]
                    .as_u64()
                    .is_some_and(|value| u32::try_from(value).is_ok())),
        "advanced_media_job_invalid"
    );
    Ok(true)
}

/// Retain original input custody until supervision has positively reaped the
/// encoder. No hardware-failure output is rewritten under the same attempt.
pub struct Prepared {
    pub args: Vec<String>,
    pub recipe: Arc<Recipe>,
    local: Option<Arc<OwnedLocalInput>>,
    assets: Option<Arc<media_core::advanced_media::OwnedAssets>>,
    remote_check: Option<(String, media_core::advanced_media::RemoteAssetCatalog)>,
}
impl Prepared {
    pub(crate) fn native_gateway(args: Vec<String>, recipe: Arc<Recipe>) -> Self {
        Self {
            args,
            recipe,
            local: None,
            assets: None,
            remote_check: None,
        }
    }
    pub fn install(&self, command: &mut tokio::process::Command) -> Result<()> {
        if let Some(assets) = &self.assets {
            assets.install(command)?;
        }
        if let Some(local) = &self.local {
            local.install(command)?;
        }
        Ok(())
    }
    pub fn verify(&self) -> Result<()> {
        if let Some(local) = &self.local {
            local.verify()?;
        }
        if let Some(assets) = &self.assets {
            assets.verify()?;
        }
        Ok(())
    }
    pub async fn verify_remote(&self) -> Result<()> {
        if let Some((input, catalog)) = &self.remote_check {
            super::advanced_remote::verify_assets(input, catalog).await?;
        }
        Ok(())
    }
    pub fn backend(&self) -> media_core::advanced_media::Backend {
        self.recipe.encoder().backend()
    }
}

async fn probe(local: &OwnedLocalInput) -> Result<Value> {
    let mut command = tokio::process::Command::new("ffprobe");
    media_core::input_policy::clean_environment(&mut command);
    command.args(media_core::input_policy::args(false, false));
    command.args([
        "-v",
        "error",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
    ]);
    command
        .arg(local.decoder_path()?)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    local.install(&mut command)?;
    let (status, bytes) =
        media_core::child_process::capture(command, Duration::from_secs(30), 8 * 1024 * 1024)
            .await?;
    ensure!(status.success(), "advanced_media_probe_failed");
    local.verify()?;
    let meta = serde_json::from_slice(&bytes)?;
    local.verify_dolby_vision_rpu(&meta).await?;
    Ok(meta)
}

pub async fn prepare(
    spec: &Value,
    input: &str,
    output: &Path,
    audio: Option<u32>,
) -> Result<Option<Prepared>> {
    let intent = request(spec)?;
    let preference = preference_from_env()?;
    if intent.is_none()
        && (preference == EncoderPreference::Software || spec["negotiated_mode"] != "transcode")
    {
        return Ok(None);
    }
    // Optional hardware selection does not reinterpret old unversioned jobs.
    if intent.is_none()
        && spec["source_kind"] == "local"
        && !spec["source_version"]
            .as_str()
            .is_some_and(media_core::file_version::valid_file_version)
    {
        tracing::info!(
            reason = "legacy_source_version_unavailable",
            "using legacy software recipe"
        );
        return Ok(None);
    }
    let sealed = intent.is_some();
    let intent = intent.unwrap_or_default();
    let inventory = Inventory::inspect().await?;
    // A device observation is not a successful driver session; qualification
    // stays unvalidated until the actual output has passed both gates.
    let encoder = EncoderSelection::choose(preference, &inventory)?;
    let start = spec["start_seconds"].as_f64().unwrap_or(0.0);
    let remote_gateway = input.to_owned();
    let remote_started = tokio::time::Instant::now();
    let (local, gateway, meta) = if spec["source_kind"] == "local" {
        let root = PathBuf::from(spec["root"].as_str().unwrap_or(""));
        let resource = spec["resource"].as_str().unwrap_or("").to_owned();
        let expected = spec["source_version"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("advanced_media_source_version_required"))?
            .to_owned();
        let local = Arc::new(
            media_core::child_process::blocking(move || {
                OwnedLocalInput::open(&root, &resource, &expected)
            })
            .await??,
        );
        let meta = probe(&local).await?;
        (Some(local), None, meta)
    } else if sealed {
        let local = super::advanced_remote::hold(
            input,
            spec["held_input_bytes"]
                .as_u64()
                .ok_or_else(|| anyhow::anyhow!("advanced_remote_input_bound"))?,
            output,
        )
        .await?;
        let meta = probe(&local).await?;
        (Some(local), None, meta)
    } else {
        let gateway = WorkerGatewayInput::new(input)?;
        let meta = media_core::probe_with_policy(input, spec["source_kind"] == "http").await?;
        (None, Some(gateway), meta)
    };
    let mut meta = meta;
    if let Some(value) = spec.get("advanced_assets") {
        meta["advanced_assets"] = value.clone();
    }
    let recipe = Arc::new(Recipe::from_probe(&meta, audio, start, &intent, encoder)?);
    let external_index = recipe.external_subtitle().map(|a| a.index);
    let assets = if external_index.is_some() || recipe.requires_external_fonts() {
        if spec["kind"] == "remote_asset_transcode_v1" {
            let remote: media_core::advanced_media::RemoteAssetCatalog =
                serde_json::from_value(spec["advanced_remote_assets"].clone())?;
            let remaining = Duration::from_secs(300)
                .checked_sub(remote_started.elapsed())
                .ok_or_else(|| anyhow::anyhow!("advanced_remote_acquisition_timeout"))?;
            Some(
                tokio::time::timeout(
                    remaining,
                    super::advanced_remote::hold_assets(
                        input,
                        &remote,
                        local.as_ref().unwrap().clone(),
                        output,
                        external_index,
                    ),
                )
                .await??,
            )
        } else {
            let catalog: media_core::advanced_media::AssetCatalog =
                serde_json::from_value(spec["advanced_assets"].clone())?;
            let root = PathBuf::from(spec["root"].as_str().unwrap_or(""));
            let directory = output
                .parent()
                .ok_or_else(|| anyhow::anyhow!("advanced_asset_directory_invalid"))?
                .join("owned-fonts");
            let index = external_index;
            Some(Arc::new(
                media_core::child_process::blocking(move || {
                    if let Some(index) = index {
                        media_core::advanced_media::OwnedAssets::open(
                            &root, &catalog, index, &directory,
                        )
                    } else {
                        media_core::advanced_media::OwnedAssets::open_fonts(
                            &root, &catalog, &directory,
                        )
                    }
                })
                .await??,
            ))
        }
    } else {
        None
    };
    let input = match (&local, &gateway) {
        (Some(local), _) => Input::OwnedLocal(local),
        (_, Some(gateway)) => Input::WorkerGateway(gateway),
        _ => unreachable!("prepared decoder input"),
    };
    let mut args =
        recipe.ffmpeg_args_with_assets(input, output, &inventory, false, assets.as_deref())?;
    if sealed && spec["source_kind"] != "local" {
        let end = args.len() - 1;
        args.splice(
            end..end,
            [
                "-t".into(),
                (spec["remote_duration_seconds"].as_f64().unwrap() - start).to_string(),
            ],
        );
    }
    // Do not retain upstream URLs/tickets in reports. This is evidence of a
    // selected backend, not a claim that hardware has successfully run.
    tracing::info!(backend=?recipe.encoder().backend(), qualification=?recipe.encoder().qualification(),
        fallback=?recipe.encoder().fallback(), tone_map_hdr=recipe.tone_mapped(), subtitle=?recipe.subtitle(),
        build_report_sha256=%inventory.build_report_sha256, "advanced media recipe prepared");
    Ok(Some(Prepared {
        args,
        recipe,
        local,
        assets,
        remote_check: if spec["kind"] == "remote_asset_transcode_v1" {
            Some((
                remote_gateway,
                serde_json::from_value(spec["advanced_remote_assets"].clone())?,
            ))
        } else {
            None
        },
    }))
}

/// Preparation has the same confirmed lease deadline as encoding. Held remote
/// bytes and metadata children cannot keep working after cancellation/expiry.
pub async fn prepare_scoped(
    app: &super::App,
    claim: &persistence::media_jobs::Claim,
    input: &str,
    output: &Path,
    audio: Option<u32>,
) -> Result<Option<Prepared>> {
    use super::process;
    let mut until = process::finalization_deadline(
        Duration::from_secs(3),
        process::confirmed_deadline(persistence::media_jobs::renew_remaining(&app.db, claim)),
    )
    .await?
    .ok_or_else(|| anyhow::Error::new(process::LeaseInterrupted))?;
    verify_scope(app, claim).await?;
    let work = prepare(&claim.spec, input, output, audio);
    tokio::pin!(work);
    let mut next = tokio::time::Instant::now() + Duration::from_secs(4);
    loop {
        tokio::select! {biased;_=tokio::time::sleep_until(until)=>return Err(process::LeaseInterrupted.into()),result=&mut work=>return result,
            _=tokio::time::sleep_until(next)=>{
                verify_scope(app,claim).await?;
                let renewal=tokio::select!{biased;_=tokio::time::sleep_until(until)=>return Err(process::LeaseInterrupted.into()),r=tokio::time::timeout(Duration::from_secs(3),process::confirmed_deadline(persistence::media_jobs::renew_remaining(&app.db,claim)))=>r};
                if tokio::time::Instant::now()>=until{return Err(process::LeaseInterrupted.into());}
                match renewal{Ok(Ok(Some(deadline)))if deadline>tokio::time::Instant::now()=>{until=deadline;next=tokio::time::Instant::now()+Duration::from_secs(4)},Ok(Ok(_))=>return Err(process::LeaseInterrupted.into()),_=>next=tokio::time::Instant::now()+Duration::from_secs(1)}
            }
        }
    }
}

pub async fn verify_scope(app: &super::App, claim: &persistence::media_jobs::Claim) -> Result<()> {
    if !matches!(
        claim.spec["kind"].as_str(),
        Some(
            "advanced_local_transcode_v1"
                | "advanced_owned_local_transcode_v1"
                | "advanced_owned_remote_transcode_v1"
                | "remote_asset_transcode_v1"
        )
    ) {
        return Ok(());
    }
    let allowed:bool=tokio::time::timeout(Duration::from_secs(3),sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM media_jobs j WHERE j.id=$1 AND j.owner_id=$2 AND j.attempt=$3 AND j.status='running' AND j.lease_until>clock_timestamp() AND advanced_media_job_allowed(j.id))").bind(claim.id).bind(claim.owner).bind(claim.attempt).fetch_one(&app.db)).await??;
    ensure!(allowed, super::process::LeaseInterrupted);
    Ok(())
}
pub async fn monitor_scope(
    app: &super::App,
    claim: &persistence::media_jobs::Claim,
    prepared: Option<&Prepared>,
) -> anyhow::Error {
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        if let Err(error) = super::source_version::verify(&claim.spec).await {
            return error;
        }
        if let Err(error) = verify_scope(app, claim).await {
            return error;
        }
        if let Some(prepared) = prepared
            && let Err(error) = prepared.verify()
        {
            return error;
        }
        if let Some(prepared) = prepared
            && let Err(error) = prepared.verify_remote().await
        {
            return error;
        }
    }
}

/// Extra font data must not consume the bounded codec-header diagnostic pipe.
/// Only a Server-issued offer or exact transform intent enables this fallback.
pub async fn probe_advertised(input: &str, resource: &Value) -> Result<Value> {
    if resource["advanced_probe"] == "metadata_only" {
        return media_core::advanced_media::probe_gateway_metadata(input).await;
    }
    match media_core::probe_with_policy(input, resource["kind"] == "http").await {
        Err(error)
            if resource["advanced_probe"] == "offer"
                && error.downcast_ref::<std::io::Error>().is_some_and(|e| {
                    e.kind() == std::io::ErrorKind::InvalidData
                        && e.to_string() == "process output exceeds limit"
                }) =>
        {
            let mut meta = media_core::advanced_media::probe_gateway_metadata(input).await?;
            meta["advanced_metadata_only"] = serde_json::json!(true);
            Ok(meta)
        }
        result => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn sealed_requests_require_local_transcode_and_current_version() {
        let mut spec = json!({"kind":"advanced_local_transcode_v1","recipe_version":1,"advanced_media":{"schema_version":1,"subtitle_stream_index":2},"source_kind":"local","source_version":format!("stat-v1:{}", "a".repeat(64)),"negotiated_mode":"transcode"});
        assert_eq!(
            request(&spec).unwrap().unwrap().subtitle_stream_index,
            Some(2)
        );
        spec["negotiated_mode"] = json!("remux");
        assert!(request(&spec).is_err());
        spec["negotiated_mode"] = json!("transcode");
        spec["source_kind"] = json!("agent");
        assert!(request(&spec).is_err());
        spec["source_kind"] = json!("local");
        spec["advanced_media"]["filter"] = json!("movie=/etc/passwd");
        assert!(request(&spec).is_err());
        assert!(request(&json!({"source_kind":"local"})).unwrap().is_none());
    }

    fn sealed_spec() -> Value {
        json!({"kind":"advanced_local_transcode_v1","recipe_version":1,
            "advanced_media":{"schema_version":1,"tone_map_hdr":false,"subtitle_stream_index":0},
            "source_kind":"local","source_version":format!("stat-v1:{}", "a".repeat(64)),
            "negotiated_mode":"transcode","transcode":true,"root":"/media","resource":"movie.mkv",
            "input_ticket":"encrypted-session-ticket","start_seconds":5.0,"audio_index":null,"estimated_output_bytes":1000})
    }

    #[test]
    fn remote_recipe_is_finite_and_cannot_expand_to_external_assets_or_urls() {
        let mut spec = sealed_spec();
        spec["kind"] = json!("advanced_owned_remote_transcode_v1");
        spec["source_kind"] = json!("http");
        spec["source_version"] = Value::Null;
        spec["root"] = json!("");
        spec["held_input_bytes"] = json!(100);
        spec["remote_duration_seconds"] = json!(10.0);
        assert!(admit_claim(&spec).unwrap());
        for (key, value) in [
            ("held_input_bytes", json!(0)),
            ("held_input_bytes", json!(2147483649u64)),
            ("remote_duration_seconds", json!(21600.1)),
            ("remote_duration_seconds", json!(5.0)),
            ("source_kind", json!("jellyfin")),
            ("advanced_assets", json!({})),
            ("url", json!("https://foreign.invalid/a")),
            ("cookie", json!("secret")),
        ] {
            let mut changed = spec.clone();
            changed[key] = value;
            assert!(admit_claim(&changed).is_err(), "{key}");
        }
        spec["source_kind"] = json!("agent");
        assert!(admit_claim(&spec).is_err());
        spec["source_version"] = json!(format!("stat-v1:{}", "b".repeat(64)));
        assert!(admit_claim(&spec).unwrap());
    }

    #[test]
    fn closed_advanced_contract_is_the_only_generic_gate_exception() {
        let spec = sealed_spec();
        assert!(admit_claim(&spec).unwrap());
        let claim = persistence::media_jobs::Claim {
            id: uuid::Uuid::new_v4(),
            owner: uuid::Uuid::new_v4(),
            attempt: 1,
            spec: spec.clone(),
        };
        // The unchanged baseline gate proves this marker cannot fall through
        // to old negotiated_hls_args if directly handed to generic dispatch.
        assert!(super::super::static_hls_child_gate::reject_unsupported_claim(&claim).is_err());
        assert!(!admit_claim(&json!({"negotiated_mode":"transcode"})).unwrap());
        for key in [
            "kind",
            "recipe_version",
            "source_kind",
            "source_version",
            "negotiated_mode",
            "advanced_media",
            "input_ticket",
            "start_seconds",
            "transcode",
        ] {
            let mut malformed = spec.clone();
            malformed.as_object_mut().unwrap().remove(key);
            assert!(admit_claim(&malformed).is_err(), "missing {key}");
        }
        for (key, value) in [
            ("recipe_version", json!(2)),
            ("kind", json!("advanced_local_transcode_v2")),
            ("source_kind", json!("http")),
            ("capture_id", json!("foreign")),
            ("filter", json!("untrusted")),
            ("worker_instance", json!("foreign")),
        ] {
            let mut malformed = spec.clone();
            malformed[key] = value;
            assert!(admit_claim(&malformed).is_err(), "changed {key}");
        }
    }
}

#[cfg(test)]
mod remote_asset_admission_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn remote_assets_have_a_new_closed_generation_and_source_binding() {
        use media_core::advanced_media::*;
        let version = format!("stat-v1:{}", "a".repeat(64));
        let catalog = AssetCatalog {
            schema_version: 1,
            source_resource: "movies/a.mkv".into(),
            source_version: version.clone(),
            subtitles: vec![SubtitleAsset {
                index: EXTERNAL_ASS_INDEX,
                kind: SubtitleKind::Ass,
                file: AssetFile {
                    resource: "movies/a.ass".into(),
                    source_version: version.clone(),
                    bytes: 40,
                },
            }],
            fonts: vec![],
        };
        let remote = RemoteAssetCatalog {
            schema_version: 1,
            source_kind: "agent".into(),
            source_resource: "movies/a.mkv".into(),
            source_version: version.clone(),
            catalog: catalog.clone(),
            source_http: None,
            http_files: vec![],
        };
        let spec = json!({"kind":"remote_asset_transcode_v1","recipe_version":1,"advanced_media":{"schema_version":1,"tone_map_hdr":false,"subtitle_stream_index":EXTERNAL_ASS_INDEX},"root":"","resource":"movies/a.mkv","source_kind":"agent","input_ticket":"sealed","start_seconds":5.0,"transcode":true,"audio_index":null,"estimated_output_bytes":1000,"negotiated_mode":"transcode","source_version":version,"held_input_bytes":100,"remote_duration_seconds":10.0,"advanced_assets":catalog,"advanced_remote_assets":remote});
        assert!(admit_claim(&spec).unwrap());
        for (key, value) in [
            ("kind", json!("advanced_owned_remote_transcode_v1")),
            ("resource", json!("movies/b.mkv")),
            ("advanced_remote_assets", json!({})),
            ("url", json!("https://foreign.invalid/sub.ass")),
            ("fontsdir", json!("/etc/fonts")),
        ] {
            let mut bad = spec.clone();
            bad[key] = value;
            assert!(admit_claim(&bad).is_err(), "{key}");
        }
    }
}
