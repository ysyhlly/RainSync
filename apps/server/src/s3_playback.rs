//! Prepare an indexed S3 object for the existing HTTP Worker transport. The
//! configured URL remains the credential/policy endpoint, never the object URL.
use super::*;
use providers::{SourceConfig, s3::ObjectMetadata};

pub(crate) struct Prepared {
    pub url: String,
    pub metadata: ObjectMetadata,
    pub source_version: String,
}

fn indexed(key: &str, metadata: &Value) -> Result<ObjectMetadata> {
    let identity = metadata
        .get("s3")
        .or_else(|| metadata.get("s3_object_identity"))
        .unwrap_or(metadata);
    let object: ObjectMetadata = serde_json::from_value(identity.clone())
        .map_err(|_| err(StatusCode::CONFLICT, "source_version_required"))?;
    if object.key != key || object.etag.is_none() {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    Ok(object)
}

/// Must run outside database locks. Signed HEAD is bound to the indexed key,
/// version (when present), and strong ETag. A changed/deleted index entry cannot
/// silently become another representation during preparation.
pub(crate) async fn prepare(
    config: &SourceConfig,
    key: &str,
    indexed_metadata: &Value,
) -> Result<Prepared> {
    providers::s3::validate_config(config)
        .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid_source"))?;
    let original = indexed(key, indexed_metadata)?;
    let current = providers::s3::head_object(
        config,
        key,
        original.version_id.as_deref(),
        original.etag.as_deref(),
    )
    .await
    .map_err(|error| {
        let changed = matches!(
            error.to_string().as_str(),
            "s3_read_failed_status_404" | "s3_read_failed_status_412"
        ) || error
            .downcast_ref::<providers::media_request::MediaRequestError>()
            .is_some_and(|e| {
                *e == providers::media_request::MediaRequestError::S3RepresentationChanged
            });
        err(
            if changed {
                StatusCode::CONFLICT
            } else {
                StatusCode::BAD_GATEWAY
            },
            if changed {
                "source_changed"
            } else {
                "source_probe_failed"
            },
        )
    })?;
    from_head(config, key, &original, current)
}

fn from_head(
    config: &SourceConfig,
    key: &str,
    original: &ObjectMetadata,
    current: ObjectMetadata,
) -> Result<Prepared> {
    if current.key != key
        || original.size != current.size
        || original.etag != current.etag
        || original
            .version_id
            .as_ref()
            .is_some_and(|version| current.version_id.as_ref() != Some(version))
    {
        return Err(err(StatusCode::CONFLICT, "source_changed"));
    }
    let bucket = &config
        .s3
        .as_ref()
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "invalid_source"))?
        .bucket;
    let url = providers::s3::object_url(config, key, current.version_id.as_deref())
        .map_err(|_| err(StatusCode::BAD_GATEWAY, "source_probe_failed"))?
        .to_string();
    let source_version = current.source_version(bucket);
    Ok(Prepared {
        url,
        metadata: current,
        source_version,
    })
}

impl Prepared {
    /// Apply only to the encrypted internal resource. Do not expose source
    /// configuration, object URLs or credential references in a public plan.
    pub(crate) fn apply(&self, config: &SourceConfig, resource: &mut Value) -> Result<()> {
        resource["kind"] = json!("http");
        resource["source_kind"] = json!("s3");
        resource["url"] = json!(self.url);
        resource["source_url"] = json!(config.url);
        resource["headers"] = json!({});
        resource["s3"] = serde_json::to_value(&config.s3).map_err(anyhow::Error::from)?;
        resource["access_policy"] =
            serde_json::to_value(&config.access_policy).map_err(anyhow::Error::from)?;
        resource["source_version"] = json!(self.source_version);
        resource["s3_object"] =
            serde_json::to_value(&self.metadata).map_err(anyhow::Error::from)?;
        Ok(())
    }
    /// Keep source metadata alongside a new ffprobe result so a subsequent
    /// preparation still has an indexed key/ETag/version to verify.
    pub(crate) fn attach_metadata(&self, metadata: &mut Value) -> Result<()> {
        metadata["s3"] = serde_json::to_value(&self.metadata).map_err(anyhow::Error::from)?;
        metadata["source_version"] = json!(self.source_version);
        Ok(())
    }
    fn identity(&self) -> Value {
        // Exact Worker http_identity::State schema. HEAD establishes only an
        // opaque strong validator and size, never Binary class or consumption.
        // A strong ETag makes Last-Modified unnecessary as an identity fallback.
        json!({"version":1,"metadata":{"etag":self.metadata.etag,"modified":null,
            "reliable_modified":false,"size":self.metadata.size},"class":null,"consumed":false,"changed":false})
    }
    /// Call after inserting the provisional/final playback_session and before
    /// committing/exposing it. Caller retains request/source/room ACL guards.
    /// Existing pins are verified and never rebound, cleared or downgraded.
    pub(crate) async fn seed(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        session: Uuid,
    ) -> Result<()> {
        sqlx::query("SELECT lock_playback_http_representation($1)")
            .bind(session)
            .execute(&mut **tx)
            .await?;
        let active: Option<bool> = sqlx::query_scalar("SELECT NOT stopped AND expires_at>clock_timestamp() FROM playback_sessions WHERE id=$1 FOR UPDATE")
            .bind(session).fetch_optional(&mut **tx).await?;
        if active != Some(true) {
            return Err(err(StatusCode::CONFLICT, "playback_request_interrupted"));
        }
        let digest = hash(&self.url);
        sqlx::query("INSERT INTO playback_http_representations(session_id,target_sha256,identity) VALUES($1,$2,$3) ON CONFLICT(session_id,target_sha256) DO NOTHING")
            .bind(session).bind(&digest).bind(self.identity()).execute(&mut **tx).await?;
        let identity: Value = sqlx::query_scalar("SELECT identity FROM playback_http_representations WHERE session_id=$1 AND target_sha256=$2")
            .bind(session).bind(&digest).fetch_one(&mut **tx).await?;
        if identity["version"] != 1
            || identity["changed"] != false
            || identity["metadata"]["etag"] != json!(self.metadata.etag)
            || identity["metadata"]["size"] != json!(self.metadata.size)
            || identity["metadata"]
                .get("final_target_sha256")
                .is_some_and(|v| !v.is_null())
        {
            return Err(err(StatusCode::CONFLICT, "source_changed"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> SourceConfig {
        serde_json::from_value(json!({"url":"https://storage.example/s3","s3":{"region":"us-east-1",
            "bucket":"media-bucket","prefix":"media/","credential_ref":{
                "access_key_id_env":"RAINSYNC_S3_TEST_ACCESS","secret_access_key_env":"RAINSYNC_S3_TEST_SECRET"}}})).unwrap()
    }
    fn object() -> ObjectMetadata {
        ObjectMetadata {
            key: "media/雪 movie.mp4".into(),
            version_id: None,
            etag: Some("\"multipart-2\"".into()),
            size: 123,
            last_modified: Some("2026-10-05T00:00:00Z".into()),
            content_type: None,
            checksum_algorithms: vec![],
        }
    }
    #[test]
    fn prepared_object_does_not_replace_endpoint_or_fabricate_binary_probe_facts() {
        let config = config();
        let original = object();
        let mut current = original.clone();
        current.version_id = Some("version+/=1".into());
        let prepared = from_head(&config, &original.key, &original, current).unwrap();
        assert_eq!(
            prepared.url,
            "https://storage.example/s3/media-bucket/media/%E9%9B%AA%20movie.mp4?versionId=version%2B%2F%3D1"
        );
        let mut resource = json!({"resource":original.key,"source_policy_revision":4});
        prepared.apply(&config, &mut resource).unwrap();
        assert_eq!(config.url, "https://storage.example/s3");
        assert_eq!(resource["source_url"], config.url);
        assert_eq!(resource["kind"], "http");
        assert_eq!(resource["source_kind"], "s3");
        assert_eq!(resource["source_policy_revision"], 4);
        assert!(providers::resource_config(&resource).unwrap().s3.is_some());
        let state = prepared.identity();
        assert!(state["class"].is_null());
        assert_eq!(state["consumed"], false);
        assert_eq!(state["metadata"]["etag"], "\"multipart-2\"");
        assert_eq!(state["metadata"]["size"], 123);
        let mut meta = json!({"streams":[],"format":{"duration":"1.0"}});
        prepared.attach_metadata(&mut meta).unwrap();
        assert_eq!(meta["s3"]["version_id"], "version+/=1");
        assert!(indexed(&original.key, &meta).is_ok());
        assert!(
            indexed(
                &original.key,
                &serde_json::to_value(&prepared.metadata).unwrap()
            )
            .is_ok()
        );
    }
    #[test]
    fn fresh_head_cannot_rebind_changed_size_etag_key_or_selected_version() {
        let config = config();
        let original = object();
        let mut changed = original.clone();
        changed.size += 1;
        assert!(from_head(&config, &original.key, &original, changed).is_err());
        let mut changed = original.clone();
        changed.etag = Some("\"changed\"".into());
        assert!(from_head(&config, &original.key, &original, changed).is_err());
        let mut changed = original.clone();
        changed.key = "media/other.mp4".into();
        assert!(from_head(&config, &original.key, &original, changed).is_err());
        let mut pinned = original.clone();
        pinned.version_id = Some("version-1".into());
        assert!(from_head(&config, &original.key, &pinned, original.clone()).is_err());
        assert!(indexed("media/other.mp4", &json!({"s3":original})).is_err());
        assert!(indexed("media/unknown.mp4", &json!({})).is_err());
    }
}
