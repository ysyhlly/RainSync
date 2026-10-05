//! Public playback data from the authenticated original Worker and its immutable
//! publication ledger. No source URL/configuration, inventory or custody proof
//! is projected into the browser response.
use aes_gcm::{Aes256Gcm, aead::Aead};
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use media_core::static_hls::contracts::{
    graph::RootGraphStatement,
    input::{FrozenInput, SelectedAudioStatement},
    operation::OperationResponse,
};
use serde::{
    Deserialize,
    de::{MapAccess, Visitor, value::MapAccessDeserializer},
};
use sqlx::{PgPool, Row};
use std::{marker::PhantomData, time::Duration};
use tokio::time::Instant;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ParentReply {
    version: u8,
    session_id: String,
    delivery_token: String,
    static_hls_capture_id: String,
    input_sha256: String,
    root_digest: String,
    root_hard_expires_at_ms: u64,
    timeline_origin_ms: u32,
    delivery_mode: String,
}

// serde's struct representation also accepts positional arrays. Storage reply
// objects must reject that alias as well as unknown, duplicate or missing fields.
struct MapOnly<T>(T);
impl<'de, T: Deserialize<'de>> Deserialize<'de> for MapOnly<T> {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        struct ObjectVisitor<T>(PhantomData<T>);
        impl<'de, T: Deserialize<'de>> Visitor<'de> for ObjectVisitor<T> {
            type Value = MapOnly<T>;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a closed parent publication reply object")
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                map: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                T::deserialize(MapAccessDeserializer::new(map)).map(MapOnly)
            }
        }
        deserializer.deserialize_map(ObjectVisitor(PhantomData))
    }
}

fn open_storage(key: &Aes256Gcm, encrypted: &str, maximum: usize) -> Result<Vec<u8>> {
    ensure!(
        !encrypted.is_empty() && encrypted.len() <= maximum,
        "static_hls_parent_cipher_bounds"
    );
    let bytes = STANDARD.decode(encrypted)?;
    ensure!(bytes.len() >= 28, "static_hls_parent_cipher_bounds");
    key.decrypt((&bytes[..12]).into(), &bytes[12..])
        .map_err(|_| anyhow::anyhow!("static_hls_parent_cipher_authentication"))
}

fn parse_reply(key: &Aes256Gcm, encrypted: &str) -> Result<ParentReply> {
    let plaintext = open_storage(key, encrypted, 2048)?;
    let MapOnly(reply) = serde_json::from_slice::<MapOnly<ParentReply>>(&plaintext)?;
    ensure!(
        reply.version == 1
            && reply.delivery_mode == "direct"
            && reply.delivery_token.len() == 64
            && reply
                .delivery_token
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "static_hls_parent_reply_shape"
    );
    Ok(reply)
}

pub(super) async fn from_original_receipt(
    pool: &PgPool,
    key: &Aes256Gcm,
    input: &FrozenInput,
    response: &OperationResponse,
) -> Result<protocol::PlaybackPlan> {
    let result = response
        .published_result_statement()
        .context("static_hls_parent_not_published")?;
    let reply = parse_reply(key, result.reply_encrypted)?;
    let identity = input.identity_statement();
    ensure!(
        reply.version == 1
            && reply.session_id == identity.session_id
            && reply.static_hls_capture_id == identity.operation_id
            && reply.input_sha256 == input.input_sha256()
            && reply.root_digest == result.root_digest
            && result.capture_id == identity.operation_id
            && reply.root_hard_expires_at_ms == input.root_deadline_ms()
            && reply.delivery_mode == "direct",
        "static_hls_parent_reply_changed"
    );
    ensure!(
        reply.delivery_token.len() == 64
            && reply
                .delivery_token
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "static_hls_parent_token_bounds"
    );

    let recorded = metadata(pool, input, result.reply_encrypted).await?;
    ensure!(
        recorded.root_digest == reply.root_digest
            && recorded.published_at_ms == result.published_at_ms,
        "static_hls_parent_publication_changed"
    );
    let graph = RootGraphStatement::parse_private_plaintext(&open_storage(
        key,
        &recorded.inventory_encrypted,
        262144,
    )?)?;
    graph.require_parent_input(input)?;
    ensure!(
        graph.root_digest() == reply.root_digest
            && graph.source_origin_ms() == reply.timeline_origin_ms
            && graph.selected_audio_statement() == *result.selected_audio,
        "static_hls_parent_graph_changed"
    );
    // Recheck actual authority after bounded crypto/parsing. No renewal or
    // session/request mutation is part of producing this public representation.
    let began = Instant::now();
    let fresh = metadata(pool, input, result.reply_encrypted).await?;
    ensure!(
        fresh.root_digest == recorded.root_digest
            && fresh.inventory_encrypted == recorded.inventory_encrypted
            && fresh.published_at_ms == recorded.published_at_ms
            && fresh.expires_at_ms <= input.root_deadline_ms(),
        "static_hls_parent_publication_changed"
    );
    let elapsed = u64::try_from(began.elapsed().as_millis())?;
    let remaining = fresh
        .expires_at_ms
        .saturating_sub(fresh.observed_at_ms)
        .saturating_sub(elapsed)
        / 1000;
    ensure!(remaining > 0, "static_hls_parent_expired");
    let selected_audio_track = match graph.selected_audio_statement() {
        SelectedAudioStatement::None {} => None,
        SelectedAudioStatement::Single { stream_index } => Some(stream_index),
    };
    let audio_tracks = selected_audio_track
        .into_iter()
        .map(|index| protocol::MediaTrack {
            index,
            label: "当前音轨".into(),
            language: String::new(),
            url: None,
        })
        .collect();
    Ok(protocol::PlaybackPlan {
        distributed_compute: None,
        local_hls_ladder: None,
        advanced_playback: None,
        native_platform: None,
        upstream_profile: None,
        session_id: Uuid::parse_str(&identity.session_id)?,
        plan_generation: Some(u32::try_from(identity.plan_generation)?),
        media_id: Uuid::parse_str(&identity.media_id)?,
        media_generation: u32::try_from(identity.media_generation)?,
        delivery_mode: "direct".into(),
        transport: "hls".into(),
        playback_url: format!(
            "/media-delivery/{}/static-hls/{}/index.m3u8",
            identity.session_id, reply.delivery_token
        ),
        timeline_origin_ms: f64::from(graph.source_origin_ms()),
        duration_ms: Some(graph.duration_ms()),
        expires_in_seconds: u32::try_from(remaining)?,
        rebuild_on_seek: false,
        audio_tracks,
        subtitle_tracks: vec![],
        decision_reason: None,
        selected_audio_track,
        selected_candidate_id: None,
        selected_output: None,
        subtitle_mode: Some(protocol::SubtitleDeliveryMode::None),
        seekable_media_ranges_ms: None,
        pending_job_id: None,
        decoder_fallback_modes: Some(vec![]),
        static_hls_fallback_version: None,
        http_file_fallback_version: None,
        observation_version: None,
        observation_seq: None,
        playback_metrics_version: None,
        playback_metrics: None,
    })
}

async fn metadata(
    pool: &PgPool,
    input: &FrozenInput,
    ciphertext: &str,
) -> Result<persistence::static_hls_pending::ParentPlanMetadata> {
    tokio::time::timeout(
        Duration::from_millis(750),
        persistence::static_hls_pending::published_parent_plan_metadata(pool, input, ciphertext),
    )
    .await??
    .context("static_hls_parent_expired")
}

/// Recheck the exact original immutable parent publication before advertising
/// optional child readiness. No SQL statement recreates a capture owner or
/// qualifies its bytes. The caller separately verifies a fresh actual runtime.
/// Kept independent of Server App so cross-binary native fixtures use the same
/// publication projection without importing a Server-only startup gate.
#[allow(dead_code)] // Also compiled by the Worker's parent-plan fixture seam.
pub(super) async fn current_original_for_advertisement(
    pool: &PgPool,
    key: &Aes256Gcm,
    plan: &mut protocol::PlaybackPlan,
) -> Result<FrozenInput> {
    let row = tokio::time::timeout(Duration::from_millis(750), async {
        let mut connection = pool.acquire().await?;
        connection.close_on_drop();
        sqlx::query("SELECT r.static_hls_operation_id,r.response_encrypted FROM playback_requests r JOIN playback_sessions p ON p.id=r.session_id JOIN static_hls_captures c ON c.id=p.static_hls_capture_id AND c.session_id=p.id AND c.id=r.static_hls_operation_id WHERE r.session_id=$1 AND r.static_hls_parent_capture_id IS NULL AND r.static_hls_input_version=1 AND r.response_encrypted IS NOT NULL AND c.publication_phase='published_parent'")
            .bind(plan.session_id).fetch_optional(&mut *connection).await
    }).await??.context("static_hls_parent_expired")?;
    let operation = row
        .try_get::<Option<Uuid>, _>("static_hls_operation_id")?
        .context("static_hls_original_operation_missing")?;
    let ciphertext = row
        .try_get::<Option<String>, _>("response_encrypted")?
        .context("static_hls_parent_reply_required")?;
    let reply = parse_reply(key, &ciphertext)?;
    let loaded = tokio::time::timeout(
        Duration::from_millis(750),
        persistence::static_hls_pending::load_operation(
            pool,
            operation,
            plan.session_id,
            |cipher| {
                Ok(
                    super::static_hls_input_cipher::open_private_input_plaintext(
                        key,
                        cipher.as_bytes(),
                    )?,
                )
            },
        ),
    )
    .await??
    .context("static_hls_original_operation_missing")?;
    ensure!(
        !loaded.publication_pending && loaded.publication_authority_live,
        "static_hls_parent_expired"
    );
    let input = loaded.input;
    let identity = input.identity_statement();
    ensure!(
        reply.session_id == identity.session_id
            && reply.static_hls_capture_id == identity.operation_id
            && reply.input_sha256 == input.input_sha256()
            && reply.root_hard_expires_at_ms == input.root_deadline_ms()
            && plan.session_id.to_string() == identity.session_id
            && plan.media_id.to_string() == identity.media_id
            && u64::from(plan.media_generation) == identity.media_generation
            && plan.plan_generation.map(u64::from) == Some(identity.plan_generation)
            && plan.delivery_mode == "direct"
            && plan.transport == "hls"
            && plan.playback_url
                == format!(
                    "/media-delivery/{}/static-hls/{}/index.m3u8",
                    identity.session_id, reply.delivery_token
                )
            && plan.pending_job_id.is_none()
            && plan.selected_output.is_none(),
        "static_hls_parent_reply_changed"
    );
    let recorded = metadata(pool, &input, &ciphertext).await?;
    let graph = RootGraphStatement::parse_private_plaintext(&open_storage(
        key,
        &recorded.inventory_encrypted,
        262144,
    )?)?;
    graph.require_parent_input(&input)?;
    let selected_audio = match graph.selected_audio_statement() {
        SelectedAudioStatement::None {} => None,
        SelectedAudioStatement::Single { stream_index } => Some(stream_index),
    };
    ensure!(
        graph.root_digest() == reply.root_digest
            && recorded.root_digest == reply.root_digest
            && graph.source_origin_ms() == reply.timeline_origin_ms
            && plan.timeline_origin_ms == f64::from(graph.source_origin_ms())
            && plan.duration_ms == Some(graph.duration_ms())
            && plan.selected_audio_track == selected_audio
            && plan.audio_tracks.len() == usize::from(selected_audio.is_some())
            && plan
                .audio_tracks
                .iter()
                .all(|track| Some(track.index) == selected_audio && track.url.is_none()),
        "static_hls_parent_graph_changed"
    );
    let began = Instant::now();
    let fresh = metadata(pool, &input, &ciphertext).await?;
    ensure!(
        fresh.root_digest == recorded.root_digest
            && fresh.inventory_encrypted == recorded.inventory_encrypted
            && fresh.published_at_ms == recorded.published_at_ms
            && fresh.expires_at_ms <= input.root_deadline_ms(),
        "static_hls_parent_publication_changed"
    );
    let remaining = fresh
        .expires_at_ms
        .saturating_sub(fresh.observed_at_ms)
        .saturating_sub(u64::try_from(began.elapsed().as_millis())?)
        / 1000;
    ensure!(remaining > 0, "static_hls_parent_expired");
    // Advertisement never renews the existing public/session/root lifetime.
    plan.expires_in_seconds = plan.expires_in_seconds.min(u32::try_from(remaining)?);
    Ok(input)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::KeyInit;
    use serde_json::{Value, json};

    fn seal(key: &Aes256Gcm, text: &[u8]) -> String {
        let nonce = [19u8; 12];
        let encrypted = key.encrypt((&nonce).into(), text).unwrap();
        STANDARD.encode([nonce.as_slice(), encrypted.as_slice()].concat())
    }

    fn reply() -> Value {
        json!({"version":1,"session_id":"22222222-2222-4222-8222-222222222222",
            "delivery_token":"a".repeat(64),"static_hls_capture_id":"33333333-3333-4333-8333-333333333333",
            "input_sha256":"b".repeat(64),"root_digest":"c".repeat(64),"root_hard_expires_at_ms":1791043200000u64,
            "timeline_origin_ms":0,"delivery_mode":"direct"})
    }

    #[test]
    fn storage_reply_is_a_closed_object_not_a_positional_or_extensible_payload() {
        let key = Aes256Gcm::new_from_slice(&[17u8; 32]).unwrap();
        let value = reply();
        let text = serde_json::to_vec(&value).unwrap();
        assert!(parse_reply(&key, &seal(&key, &text)).is_ok());
        let mut unknown = value.clone();
        unknown["upstream_url"] = json!("http://fixture.invalid/private");
        assert!(parse_reply(&key, &seal(&key, &serde_json::to_vec(&unknown).unwrap())).is_err());
        let duplicate = format!(
            "{{\"version\":1,{}",
            std::str::from_utf8(&text).unwrap().trim_start_matches('{')
        );
        assert!(parse_reply(&key, &seal(&key, duplicate.as_bytes())).is_err());
        let array = value
            .as_object()
            .unwrap()
            .values()
            .cloned()
            .collect::<Vec<_>>();
        assert!(parse_reply(&key, &seal(&key, &serde_json::to_vec(&array).unwrap())).is_err());
        for field in value.as_object().unwrap().keys() {
            let mut missing = value.clone();
            missing.as_object_mut().unwrap().remove(field);
            assert!(
                parse_reply(&key, &seal(&key, &serde_json::to_vec(&missing).unwrap())).is_err()
            );
        }
    }

    #[test]
    fn storage_reply_refuses_wrong_scalar_version_token_mode_and_cipher() {
        let key = Aes256Gcm::new_from_slice(&[17u8; 32]).unwrap();
        for (field, replacement) in [
            ("version", json!(2)),
            ("version", json!(1.0)),
            ("delivery_token", json!("a".repeat(63))),
            ("delivery_token", json!("A".repeat(64))),
            ("delivery_token", json!("../source")),
            ("delivery_mode", json!("transcode")),
            ("root_hard_expires_at_ms", json!(-1)),
            ("timeline_origin_ms", json!(0.5)),
            ("session_id", Value::Null),
        ] {
            let mut value = reply();
            value[field] = replacement;
            assert!(parse_reply(&key, &seal(&key, &serde_json::to_vec(&value).unwrap())).is_err());
        }
        assert!(parse_reply(&key, &"a".repeat(2049)).is_err());
        assert!(parse_reply(&key, "not-a-storage-cipher").is_err());
        let cipher = seal(&key, &serde_json::to_vec(&reply()).unwrap());
        let wrong = Aes256Gcm::new_from_slice(&[18u8; 32]).unwrap();
        assert!(parse_reply(&wrong, &cipher).is_err());
    }
}
