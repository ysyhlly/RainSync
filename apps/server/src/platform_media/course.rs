//! Course access stays on the exact PUGV route and the preparing viewer's frozen account.
use super::*;
use providers::platform::bilibili::course;

pub(super) async fn resolve(
    http: providers::platform::http::PlatformHttp,
    entry: &native_platform::Entry,
    account: &platform_accounts::FrozenAccount,
    max_height: Option<u32>,
    deadline: Deadline,
) -> Result<(Descriptor, Option<i64>, Vec<u32>)> {
    let identity = entry
        .course
        .as_ref()
        .ok_or_else(|| err(StatusCode::GONE, "invalid_playback_session"))?;
    resolve_with_client(
        &course::Client::new(http, account.cookie().cloned()),
        &entry.resource(),
        identity,
        max_height,
        deadline,
    )
    .await
}

async fn resolve_with_client<T: course::Transport>(
    client: &course::Client<T>,
    resource: &str,
    identity: &native_platform::PgcIdentity,
    max_height: Option<u32>,
    deadline: Deadline,
) -> Result<(Descriptor, Option<i64>, Vec<u32>)> {
    // Discover the complete clear rendition set admitted for this exact viewer
    // and episode (qn 127). Keep the provider's whole-access/current-quality
    // gates; apply Auto's or the viewer's pixel ceiling only to selection below.
    // A downgrade must not erase authorized upgrade choices from the next menu.
    let resolved = client
        .resolve(resource, None, deadline)
        .await
        .map_err(provider_error)?;
    if !resolved.whole_entitlement().is_whole() {
        return Err(err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "native_platform_access_denied",
        ));
    }
    validate_identity(identity, &resolved.metadata)?;
    descriptor(&resolved, max_height)
}
fn validate_identity(
    identity: &native_platform::PgcIdentity,
    metadata: &course::Metadata,
) -> Result<()> {
    if !identity.is_course()
        || !identity.validate()
        || identity.ep_id() != metadata.ep_id
        || identity.aid() != Some(metadata.aid.as_str())
        || identity.cid() != metadata.cid
        || identity.season_id() != metadata.season_id
    {
        return Err(err(StatusCode::CONFLICT, "native_platform_entry_changed"));
    }
    Ok(())
}
fn descriptor(
    resolved: &course::Resolved,
    max_height: Option<u32>,
) -> Result<(Descriptor, Option<i64>, Vec<u32>)> {
    let heights = Descriptor::bilibili_dash_heights(&resolved.dash, resolved.current_quality);
    let (mut descriptor, expiry) =
        Descriptor::from_bilibili_dash(&resolved.dash, resolved.current_quality, max_height)?;
    // The provider proves the selected audio rate with one exact bounded init
    // fetch. Persist its representation identity for all subsequent byte ranges.
    if let Some(probe) = &resolved.audio_probe {
        let audio = descriptor
            .tracks
            .iter_mut()
            .find(|track| track.kind == "audio")
            .ok_or_else(|| err(StatusCode::GONE, "invalid_playback_session"))?;
        audio.observed_content_length = Some(probe.total_bytes);
        audio.strong_etag = probe.strong_etag.clone();
    }
    descriptor.validate_for("bilibili")?;
    Ok((descriptor, expiry, heights))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> course::Resolved {
        let reference = course::parse_resource("course:ep9007199254740993").unwrap();
        let metadata=course::parse_metadata_response(include_bytes!("../../../../crates/providers/src/platform/bilibili/course/fixtures/season-authorized-episode.json"),&reference).unwrap();
        course::parse_playurl_response(include_bytes!("../../../../crates/providers/src/platform/bilibili/course/fixtures/full-clear-dash.json"),&metadata,None,1700000000).unwrap().finish_without_probe().unwrap()
    }
    #[test]
    fn clear_course_uses_real_tracks_and_closed_course_identity() {
        let resolved = fixture();
        let m = &resolved.metadata;
        let identity = native_platform::PgcIdentity::new_course(
            m.ep_id.clone(),
            m.aid.clone(),
            m.cid.clone(),
            m.season_id.clone(),
        );
        assert!(validate_identity(&identity, m).is_ok());
        let (d, expiry, heights) = descriptor(&resolved, Some(720)).unwrap();
        assert!(d.validate_for("bilibili").is_ok());
        assert!(d.tracks[0].height.is_some_and(|h| h <= 720));
        assert_eq!(d.tracks[1].codecs, "mp4a.40.2");
        assert!(expiry.is_some());
        assert!(!heights.is_empty());
        let pgc =
            native_platform::PgcIdentity::new(m.ep_id.clone(), m.cid.clone(), m.season_id.clone());
        assert!(validate_identity(&pgc, m).is_err());
        for axis in ["ep", "aid", "cid", "season"] {
            let wrong = native_platform::PgcIdentity::new_course(
                if axis == "ep" {
                    "1".into()
                } else {
                    m.ep_id.clone()
                },
                if axis == "aid" {
                    "1".into()
                } else {
                    m.aid.clone()
                },
                if axis == "cid" {
                    "1".into()
                } else {
                    m.cid.clone()
                },
                if axis == "season" {
                    "1".into()
                } else {
                    m.season_id.clone()
                },
            );
            assert!(validate_identity(&wrong, m).is_err());
        }
    }
    #[test]
    fn audio_probe_identity_is_propagated_and_cannot_truncate_ranges() {
        let mut resolved = fixture();
        resolved.audio_probe = Some(course::AudioProbeIdentity {
            total_bytes: 100000,
            strong_etag: Some("\"course-audio\"".into()),
        });
        let (d, _, _) = descriptor(&resolved, None).unwrap();
        assert_eq!(d.tracks[1].observed_content_length, Some(100000));
        assert_eq!(d.tracks[1].strong_etag.as_deref(), Some("\"course-audio\""));
        resolved.audio_probe.as_mut().unwrap().total_bytes = 1;
        assert!(descriptor(&resolved, None).is_err());
        resolved.audio_probe.as_mut().unwrap().total_bytes = 100000;
        resolved.audio_probe.as_mut().unwrap().strong_etag = Some("W/\"weak\"".into());
        assert!(descriptor(&resolved, None).is_err());
    }
    type DiscoveryCalls = std::sync::Arc<std::sync::Mutex<Vec<(String, Option<String>)>>>;

    #[derive(Clone)]
    struct QualityFixtureTransport {
        play: serde_json::Value,
        calls: DiscoveryCalls,
        init_calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    }

    impl course::Transport for QualityFixtureTransport {
        fn get_course<'a>(
            &'a self,
            request: course::Request,
            _deadline: Deadline,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<
                        Output = std::result::Result<course::Response, bilibili::Error>,
                    > + Send
                    + 'a,
            >,
        > {
            Box::pin(async move {
                request.validate()?;
                self.calls.lock().unwrap().push((
                    request.url().to_string(),
                    request
                        .cookie()
                        .map(|cookie| cookie.expose_for_storage().to_owned()),
                ));
                let body = match request.endpoint() {
                    course::Endpoint::Season => include_bytes!("../../../../crates/providers/src/platform/bilibili/course/fixtures/season-authorized-episode.json").to_vec(),
                    course::Endpoint::PlayUrl => serde_json::to_vec(&self.play).unwrap(),
                };
                Ok(course::Response { status: 200, body })
            })
        }

        fn read_course_init<'a>(
            &'a self,
            request: course::InitRequest,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<
                        Output = std::result::Result<
                            providers::platform::youtube::mp4::RangeResponse,
                            bilibili::Error,
                        >,
                    > + Send
                    + 'a,
            >,
        > {
            Box::pin(async move {
                use providers::platform::youtube::mp4;
                request.validate()?;
                let init = include_bytes!(
                    "../../../../crates/providers/src/platform/bilibili/course/fixtures/audio-init-aac44100.mp4"
                );
                assert_eq!(request.range_request().range.start, 0);
                assert_eq!(request.range_request().range.end, init.len() as u64 - 1);
                assert_eq!(request.range_request().max_body_bytes, init.len());
                assert!(request.url().path().ends_with("synthetic-audio.m4s"));
                self.init_calls
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                Ok(mp4::RangeResponse {
                    status: 206,
                    headers: mp4::RangeHeaders {
                        content_range: vec![format!("bytes 0-{}/100000", init.len() - 1)],
                        content_length: vec![init.len().to_string()],
                        content_encoding: vec!["identity".into()],
                        etag: vec!["\"synthetic-quality-audio\"".into()],
                        last_modified: vec![],
                    },
                    body: init.to_vec(),
                })
            })
        }
    }

    fn quality_fixture() -> QualityFixtureTransport {
        let mut play: serde_json::Value = serde_json::from_slice(include_bytes!("../../../../crates/providers/src/platform/bilibili/course/fixtures/full-clear-dash.json")).unwrap();
        let info = &mut play["data"];
        info["quality"] = serde_json::json!(120);
        // The advertised 4320p level has no admitted track and must never enter
        // the menu. The 2160p AVC rendition is actually present and authorized.
        info["accept_quality"] = serde_json::json!([127, 120, 80, 64, 16]);
        info["accept_description"] = serde_json::json!(["4320P", "2160P", "1080P", "720P", "360P"]);
        info["support_formats"] = serde_json::json!([]);
        let expires = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 3600;
        let template = info["dash"]["video"][0].clone();
        info["dash"]["video"] = serde_json::Value::Array(
            [(16, 640, 360), (64, 1280, 720), (80, 1920, 1080), (120, 3840, 2160)]
                .into_iter()
                .map(|(quality, width, height)| {
                    let mut track = template.clone();
                    track["id"] = serde_json::json!(quality);
                    track["width"] = serde_json::json!(width);
                    track["height"] = serde_json::json!(height);
                    track["codecs"] = serde_json::json!("avc1.640033");
                    track["baseUrl"] = serde_json::json!(format!(
                        "https://upos-sz-mirrorcos.bilivideo.com/synthetic-{quality}.m4s?deadline={expires}"
                    ));
                    track
                }).collect(),
        );
        info["dash"]["audio"][0]["baseUrl"] = serde_json::json!(format!(
            "https://upos-sz-mirrorcos.bilivideo.com/synthetic-audio.m4s?deadline={expires}"
        ));

        let init = include_bytes!(
            "../../../../crates/providers/src/platform/bilibili/course/fixtures/audio-init-aac44100.mp4"
        );
        let audio = &mut info["dash"]["audio"][0];
        audio.as_object_mut().unwrap().remove("audioSamplingRate");
        audio["SegmentBase"] = serde_json::json!({
            "Initialization": format!("0-{}", init.len()-1),
            "indexRange": format!("{}-{}", init.len(), init.len()+99),
        });

        QualityFixtureTransport {
            play,
            calls: Default::default(),
            init_calls: Default::default(),
        }
    }

    fn quality_identity() -> native_platform::PgcIdentity {
        native_platform::PgcIdentity::new_course(
            "9007199254740993".into(),
            "9007199254740994".into(),
            "9007199254740995".into(),
            "12345".into(),
        )
    }

    #[tokio::test]
    async fn course_quality_discovery_survives_auto_downgrade_and_direct_upgrade() {
        for current_quality in [80, 120] {
            let mut transport = quality_fixture();
            transport.play["data"]["quality"] = serde_json::json!(current_quality);
            let cookie =
                bilibili::Cookie::from_header("SESSDATA=synthetic-discovery-viewer; DedeUserID=42")
                    .unwrap();
            let client = course::Client::new(transport.clone(), Some(cookie.clone()));
            let expected = if current_quality == 120 {
                vec![360, 720, 1080, 2160]
            } else {
                vec![360, 720, 1080]
            };
            let mut ceilings = vec![1080, 720, 1080, 360, 1080];
            if current_quality == 120 {
                ceilings.push(2160);
            }
            for (index, height) in ceilings.into_iter().enumerate() {
                // Initial Auto's effective 1080 ceiling, manual downgrade,
                // and direct upgrade all rediscover the same full admitted set.
                let (descriptor, expiry, heights) = resolve_with_client(
                    &client,
                    "course:ep9007199254740993",
                    &quality_identity(),
                    Some(height),
                    Deadline::now() + Duration::from_secs(2),
                )
                .await
                .unwrap();
                assert_eq!(heights, expected);
                assert_eq!(descriptor.tracks[0].height, Some(height));
                assert_eq!(descriptor.tracks[1].codecs, "mp4a.40.2");
                assert!(descriptor.validate_for("bilibili").is_ok());
                assert!(expiry.is_some());

                assert_eq!(descriptor.tracks[1].sampling_rate, Some(44100));
                assert_eq!(descriptor.tracks[1].observed_content_length, Some(100000));
                assert_eq!(
                    descriptor.tracks[1].strong_etag.as_deref(),
                    Some("\"synthetic-quality-audio\"")
                );
                assert_eq!(
                    transport
                        .init_calls
                        .load(std::sync::atomic::Ordering::Relaxed),
                    index + 1
                );

                let calls = transport.calls.lock().unwrap();
                assert_eq!(calls.len(), (index + 1) * 2);
                for (url, account) in calls.iter() {
                    assert_eq!(account.as_deref(), Some(cookie.expose_for_storage()));
                    assert!(url.contains("ep_id=9007199254740993"));
                    assert!(!url.contains("/x/player/"));
                }
                let url = reqwest::Url::parse(&calls[index * 2 + 1].0).unwrap();
                assert_eq!(url.path(), "/pugv/player/web/playurl");
                assert!(
                    url.query_pairs()
                        .any(|(key, value)| key == "qn" && value == "127")
                );
                assert!(
                    url.query_pairs()
                        .any(|(key, value)| key == "cid" && value == "9007199254740995")
                );
            }
        }
    }

    #[tokio::test]
    async fn course_quality_discovery_never_turns_access_or_identity_denials_into_a_menu() {
        for change in 0..4 {
            let mut transport = quality_fixture();
            match change {
                0 => transport.play["data"]["is_preview"] = serde_json::json!(1),
                1 => transport.play["data"]["cid"] = serde_json::json!(1),
                2 => transport.play["data"]["quality"] = serde_json::json!(128),
                _ => {
                    transport.play["data"]["dash"]["video"][3]["baseUrl"] =
                        serde_json::json!("https://127.0.0.1/not-authorized")
                }
            }
            assert!(
                resolve_with_client(
                    &course::Client::new(transport.clone(), None),
                    "course:ep9007199254740993",
                    &quality_identity(),
                    Some(720),
                    Deadline::now() + Duration::from_secs(2),
                )
                .await
                .is_err(),
                "accepted discovery change {change}"
            );
            assert_eq!(transport.calls.lock().unwrap().len(), 2);
            assert_eq!(
                transport
                    .init_calls
                    .load(std::sync::atomic::Ordering::Relaxed),
                0
            );
        }
    }
}
