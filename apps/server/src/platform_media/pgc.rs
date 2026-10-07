//! Positively entitled, clear single-episode PGC playback. Never route an episode
//! through the ordinary UGC resolver or synthesize an ordinary video identity.
use super::*;
use providers::platform::bilibili::pgc;

pub(super) async fn resolve(
    app: &App,
    entry: &native_platform::Entry,
    account: &platform_accounts::FrozenAccount,
    max_height: Option<u32>,
    deadline: Deadline,
) -> Result<(Descriptor, Option<i64>, Vec<u32>)> {
    let identity = entry
        .pgc
        .as_ref()
        .ok_or_else(|| err(StatusCode::GONE, "invalid_playback_session"))?;
    resolve_with_client(
        &pgc::Client::new(app.platform_http, account.cookie().cloned()),
        &entry.resource(),
        identity,
        max_height,
        deadline,
    )
    .await
}

async fn resolve_with_client<T: pgc::Transport>(
    client: &pgc::Client<T>,
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
    let heights = Descriptor::bilibili_dash_heights(&resolved.dash, resolved.current_quality);
    let (descriptor, expiry) =
        Descriptor::from_bilibili_dash(&resolved.dash, resolved.current_quality, max_height)?;
    Ok((descriptor, expiry, heights))
}
fn validate_identity(
    identity: &native_platform::PgcIdentity,
    metadata: &pgc::Metadata,
) -> Result<()> {
    if !identity.validate()
        || identity.ep_id() != metadata.ep_id
        || identity.cid() != metadata.cid
        || identity.season_id() != metadata.season_id
    {
        return Err(err(StatusCode::CONFLICT, "native_platform_entry_changed"));
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn positively_entitled_pgc_fixture_converts_directly_to_clear_dash_without_ugc_metadata() {
        let reference = pgc::parse_resource("ep9007199254740993").unwrap();
        let metadata = pgc::parse_metadata_response(include_bytes!("../../../../crates/providers/src/platform/bilibili/pgc/fixtures/season-single-episode.json"), &reference).unwrap();
        let resolved = pgc::parse_playurl_response(
            include_bytes!(
                "../../../../crates/providers/src/platform/bilibili/pgc/fixtures/v2-whole-dash.json"
            ),
            &metadata,
            None,
            1700000000,
        )
        .unwrap();
        assert!(resolved.whole_entitlement().is_whole());
        let identity = native_platform::PgcIdentity::new(
            metadata.ep_id.clone(),
            metadata.cid.clone(),
            metadata.season_id.clone(),
        );
        assert!(validate_identity(&identity, &metadata).is_ok());
        let (descriptor, expiry) =
            Descriptor::from_bilibili_dash(&resolved.dash, resolved.current_quality, Some(720))
                .unwrap();
        assert!(descriptor.validate_for("bilibili").is_ok());
        assert_eq!(descriptor.tracks[0].height, Some(720));
        assert!(descriptor.tracks[0].codecs.starts_with("avc1."));
        assert_eq!(descriptor.tracks[1].codecs, "mp4a.40.2");
        assert!(expiry.is_some());
    }
    #[test]
    fn episode_identity_never_uses_ugc_bvid_and_matches_all_axes() {
        let identity = native_platform::PgcIdentity::new("7".into(), "8".into(), "9".into());
        let mut metadata = pgc::Metadata {
            ep_id: "7".into(),
            cid: "8".into(),
            season_id: "9".into(),
            aid: "10".into(),
            bvid: "BV1xx411c7mD".into(),
            title: "Season".into(),
            episode_title: "Episode".into(),
            duration_ms: 60_000,
        };
        assert!(validate_identity(&identity, &metadata).is_ok());
        metadata.bvid = "BV1yy411c7mD".into();
        assert!(validate_identity(&identity, &metadata).is_ok());
        for field in ["ep", "cid", "season"] {
            let mut wrong = metadata.clone();
            match field {
                "ep" => wrong.ep_id = "70".into(),
                "cid" => wrong.cid = "80".into(),
                _ => wrong.season_id = "90".into(),
            }
            assert!(validate_identity(&identity, &wrong).is_err());
        }
    }
    type DiscoveryCalls = std::sync::Arc<std::sync::Mutex<Vec<(String, Option<String>)>>>;

    #[derive(Clone)]
    struct QualityFixtureTransport {
        play: serde_json::Value,
        calls: DiscoveryCalls,
    }

    impl pgc::Transport for QualityFixtureTransport {
        fn get_pgc<'a>(
            &'a self,
            request: pgc::Request,
            _deadline: Deadline,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<
                        Output = std::result::Result<pgc::Response, bilibili::Error>,
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
                    pgc::Endpoint::Season => include_bytes!("../../../../crates/providers/src/platform/bilibili/pgc/fixtures/season-single-episode.json").to_vec(),
                    pgc::Endpoint::PlayUrl => serde_json::to_vec(&self.play).unwrap(),
                };
                Ok(pgc::Response { status: 200, body })
            })
        }
    }

    fn quality_fixture() -> QualityFixtureTransport {
        let mut play: serde_json::Value = serde_json::from_slice(include_bytes!(
            "../../../../crates/providers/src/platform/bilibili/pgc/fixtures/v2-whole-dash.json"
        ))
        .unwrap();
        let info = &mut play["result"]["video_info"];
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

        QualityFixtureTransport {
            play,
            calls: Default::default(),
        }
    }

    fn quality_identity() -> native_platform::PgcIdentity {
        native_platform::PgcIdentity::new(
            "9007199254740993".into(),
            "9007199254740995".into(),
            "12345".into(),
        )
    }

    #[tokio::test]
    async fn pgc_quality_discovery_survives_auto_downgrade_and_direct_upgrade() {
        for current_quality in [80, 120] {
            let mut transport = quality_fixture();
            transport.play["result"]["video_info"]["quality"] = serde_json::json!(current_quality);
            let cookie =
                bilibili::Cookie::from_header("SESSDATA=synthetic-discovery-viewer; DedeUserID=42")
                    .unwrap();
            let client = pgc::Client::new(transport.clone(), Some(cookie.clone()));
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
                    "ep9007199254740993",
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

                let calls = transport.calls.lock().unwrap();
                assert_eq!(calls.len(), (index + 1) * 2);
                for (url, account) in calls.iter() {
                    assert_eq!(account.as_deref(), Some(cookie.expose_for_storage()));
                    assert!(url.contains("ep_id=9007199254740993"));
                    assert!(!url.contains("/x/player/"));
                }
                let url = reqwest::Url::parse(&calls[index * 2 + 1].0).unwrap();
                assert_eq!(url.path(), "/pgc/player/web/v2/playurl");
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
    async fn pgc_quality_discovery_never_turns_access_or_identity_denials_into_a_menu() {
        for change in 0..4 {
            let mut transport = quality_fixture();
            match change {
                0 => transport.play["result"]["play_video_type"] = serde_json::json!("preview"),
                1 => transport.play["result"]["cid"] = serde_json::json!(1),
                2 => transport.play["result"]["video_info"]["quality"] = serde_json::json!(128),
                _ => {
                    transport.play["result"]["video_info"]["dash"]["video"][3]["baseUrl"] =
                        serde_json::json!("https://127.0.0.1/not-authorized")
                }
            }
            assert!(
                resolve_with_client(
                    &pgc::Client::new(transport.clone(), None),
                    "ep9007199254740993",
                    &quality_identity(),
                    Some(720),
                    Deadline::now() + Duration::from_secs(2),
                )
                .await
                .is_err(),
                "accepted discovery change {change}"
            );
            assert_eq!(transport.calls.lock().unwrap().len(), 2);
        }
    }
}
