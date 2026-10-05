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
    let resolved = pgc::Client::new(app.platform_http, account.cookie().cloned())
        .resolve(&entry.resource(), max_height, deadline)
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
}
