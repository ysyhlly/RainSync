//! Course access stays on the exact PUGV route and the preparing viewer's frozen account.
use super::*;
use providers::platform::bilibili::course;

pub(super) async fn resolve(
    app: &App,
    entry: &native_platform::Entry,
    account: &platform_accounts::FrozenAccount,
    max_height: Option<u32>,
    deadline: Deadline,
) -> Result<(Descriptor, Option<i64>, Vec<u32>)> {
    let identity = entry
        .course
        .as_ref()
        .ok_or_else(|| err(StatusCode::GONE, "invalid_playback_session"))?;
    let resolved = course::Client::new(app.platform_http, account.cookie().cloned())
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
}
