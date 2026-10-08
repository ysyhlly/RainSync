//! Dedicated software HLS ladder contracts and atomic common-prefix publication.
//! Single-output validation versions 2/3 and static child version 4 are unchanged.
use crate::media_job_timing::{OWNED_TICK_SQL, SINGLE_PHASE_SQL, record_single};
use crate::media_jobs::Claim;
use crate::media_outputs::FileProof;
use anyhow::{Result, ensure};
use media_core::hls_ladder::{LadderRecipe, RenditionId, parse_master, parse_media_playlist};
use media_core::job_health::{PendingJobHealth, TimingKind};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use uuid::Uuid;

pub const QUEUE: &str = "local_hls_ladder_v1";
pub const KIND: &str = "local_hls_ladder_transcode_v1";
pub const ADVANCED_QUEUE: &str = "advanced_hls_ladder_v1";
pub const ADVANCED_KIND: &str = "advanced_hls_ladder_transcode_v1";
pub const OWNED_ADVANCED_KIND: &str = "advanced_owned_hls_ladder_transcode_v1";
pub const OWNED_ADVANCED_QUEUE: &str = "advanced_owned_hls_ladder_v1";
pub const VALIDATION_VERSION: i32 = 5;
// Forty bytes per canonical segment line-pair plus fixed headers is a safe
// manifest reservation. Reject guaranteed-overflow jobs before queue admission.
pub const MAX_PREFIX_SEGMENTS: usize = (media_core::hls_ladder::MAX_MANIFEST_BYTES - 256) / 40;
const FIELDS: &[&str] = &[
    "kind",
    "recipe_version",
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
    "duration_ms",
    "source_generation",
    "plan_generation",
    "renditions",
];

pub fn validate_spec(spec: &Value) -> Result<()> {
    if matches!(
        spec["kind"].as_str(),
        Some(ADVANCED_KIND | OWNED_ADVANCED_KIND)
    ) {
        let mut plain = spec.clone();
        let request = plain
            .as_object_mut()
            .and_then(|o| o.remove("advanced_media"))
            .ok_or_else(|| anyhow::anyhow!("advanced_hls_ladder_spec_invalid"))?;
        let request_value = request.clone();
        let request: media_core::advanced_media::Request = serde_json::from_value(request)?;
        ensure!(
            serde_json::to_value(&request)? == request_value,
            "advanced_hls_ladder_spec_invalid"
        );
        request.validate()?;
        ensure!(
            request.requires_transform(),
            "advanced_hls_ladder_transform_required"
        );
        if spec["kind"] == OWNED_ADVANCED_KIND {
            ensure!(
                plain.get("advanced_assets").is_some(),
                "advanced_asset_custody_required"
            );
        } else {
            ensure!(
                plain.get("advanced_assets").is_none(),
                "advanced_owned_queue_required"
            );
        }
        if let Some(assets) = plain.as_object_mut().unwrap().remove("advanced_assets") {
            let catalog: media_core::advanced_media::AssetCatalog = serde_json::from_value(assets)?;
            catalog.validate(
                spec["resource"].as_str().unwrap_or(""),
                spec["source_version"].as_str().unwrap_or(""),
            )?;
        }
        plain["kind"] = json!(KIND);
        return validate_spec(&plain);
    }

    let object = spec
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("local_hls_ladder_spec_invalid"))?;
    ensure!(
        object.len() == FIELDS.len()
            && object.keys().all(|key| FIELDS.contains(&key.as_str()))
            && spec["kind"] == KIND
            && spec["recipe_version"] == 1
            && spec["source_kind"] == "local"
            && spec["negotiated_mode"] == "transcode"
            && spec["transcode"] == true,
        "local_hls_ladder_spec_invalid"
    );
    for key in ["root", "resource", "input_ticket"] {
        ensure!(
            spec[key].as_str().is_some_and(|s| !s.is_empty()
                && s.len() <= 65536
                && !s.contains(['\0', '\n', '\r'])),
            "local_hls_ladder_spec_invalid"
        );
    }
    ensure!(
        spec["source_version"]
            .as_str()
            .is_some_and(media_core::file_version::valid_file_version),
        "source_version_required"
    );
    let start = spec["start_seconds"]
        .as_f64()
        .ok_or_else(|| anyhow::anyhow!("invalid_position"))?;
    let duration = spec["duration_ms"]
        .as_f64()
        .ok_or_else(|| anyhow::anyhow!("local_hls_ladder_duration_required"))?;
    ensure!(
        start.is_finite()
            && start >= 0.0
            && duration.is_finite()
            && duration > start * 1000.0
            && duration <= media_core::hls_ladder::MAX_DURATION_MS as f64,
        "local_hls_ladder_duration_required"
    );
    ensure!(
        spec["audio_index"].is_null()
            || spec["audio_index"]
                .as_u64()
                .is_some_and(|n| n <= u32::MAX as u64),
        "invalid_audio_track"
    );
    ensure!(
        spec["source_generation"]
            .as_u64()
            .is_some_and(|n| n <= u32::MAX as u64)
            && spec["plan_generation"]
                .as_u64()
                .is_some_and(|n| n > 0 && n <= u32::MAX as u64)
            && spec["estimated_output_bytes"]
                .as_u64()
                .is_some_and(|n| n > 0 && n <= i64::MAX as u64),
        "local_hls_ladder_spec_invalid"
    );
    let rungs = spec["renditions"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("local_hls_ladder_spec_invalid"))?;
    ensure!(
        !rungs.is_empty() && rungs.len() <= 3,
        "local_hls_ladder_spec_invalid"
    );
    let mut previous = None;
    for rung in rungs {
        let id = RenditionId::parse(rung["id"].as_str().unwrap_or(""))?;
        ensure!(
            previous.is_none_or(|p| p < id)
                && rung.as_object().is_some_and(|o| o.len() == 9
                    && o.keys().all(|k| [
                        "id",
                        "width",
                        "height",
                        "video_bitrate",
                        "video_maxrate",
                        "bandwidth",
                        "average_bandwidth",
                        "avc_codec",
                        "audio_bitrate"
                    ]
                    .contains(&k.as_str()))),
            "local_hls_ladder_spec_invalid"
        );
        let (bitrate, maxrate, codec, max_width, max_height) = match id {
            RenditionId::Low => (800_000u64, 1_000_000u64, "avc1.64001F", 640u64, 360u64),
            RenditionId::Medium => (2_500_000, 3_000_000, "avc1.64001F", 1280, 720),
            RenditionId::High => (5_000_000, 6_000_000, "avc1.640028", 1920, 1080),
        };
        let audio = if spec["audio_index"].is_null() {
            None
        } else {
            Some(128_000u64)
        };
        ensure!(
            rung["width"]
                .as_u64()
                .is_some_and(|n| n >= 2 && n <= max_width && n % 2 == 0)
                && rung["height"]
                    .as_u64()
                    .is_some_and(|n| n >= 2 && n <= max_height && n % 2 == 0)
                && rung["video_bitrate"] == bitrate
                && rung["video_maxrate"] == maxrate
                && rung["avc_codec"] == codec
                && rung["audio_bitrate"].as_u64() == audio
                && rung["audio_bitrate"].is_null() == audio.is_none()
                && rung["average_bandwidth"] == bitrate + audio.unwrap_or(0)
                && rung["bandwidth"] == (maxrate + audio.unwrap_or(0)) * 5 / 4,
            "local_hls_ladder_spec_invalid"
        );
        previous = Some(id);
    }
    ensure!(
        duration - start * 1000.0
            <= MAX_PREFIX_SEGMENTS.min(media_core::hls_ladder::MAX_SEGMENTS) as f64 * 4000.0,
        "local_hls_ladder_duration_required"
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn job_spec(
    root: &str,
    resource: &str,
    source_version: &str,
    input_ticket: &str,
    start_seconds: f64,
    audio_index: Option<u32>,
    duration_ms: f64,
    source_generation: u32,
    plan_generation: u32,
    recipe: &LadderRecipe,
) -> Result<Value> {
    let bytes = recipe
        .estimated_output_bytes(Some(duration_ms))
        .ok_or_else(|| anyhow::anyhow!("local_hls_ladder_duration_required"))?;
    let spec = json!({"kind":KIND,"recipe_version":1,"root":root,"resource":resource,
        "source_kind":"local","input_ticket":input_ticket,"start_seconds":start_seconds,
        "transcode":true,"audio_index":audio_index,"estimated_output_bytes":bytes,
        "negotiated_mode":"transcode","source_version":source_version,"duration_ms":duration_ms,
        "source_generation":source_generation,"plan_generation":plan_generation,"renditions":recipe.renditions()});
    validate_spec(&spec)?;
    Ok(spec)
}

#[allow(clippy::too_many_arguments)]
pub fn job_spec_with_advanced(
    root: &str,
    resource: &str,
    source_version: &str,
    input_ticket: &str,
    start_seconds: f64,
    audio_index: Option<u32>,
    duration_ms: f64,
    source_generation: u32,
    plan_generation: u32,
    recipe: &LadderRecipe,
    request: &media_core::advanced_media::Request,
) -> Result<Value> {
    request.validate()?;
    ensure!(
        request.requires_transform(),
        "advanced_hls_ladder_transform_required"
    );
    let mut spec = job_spec(
        root,
        resource,
        source_version,
        input_ticket,
        start_seconds,
        audio_index,
        duration_ms,
        source_generation,
        plan_generation,
        recipe,
    )?;
    spec["kind"] = json!(ADVANCED_KIND);
    spec["advanced_media"] = serde_json::to_value(request)?;
    validate_spec(&spec)?;
    Ok(spec)
}
pub fn validate_any_ladder_spec(spec: &Value) -> Result<()> {
    if spec["kind"] == crate::native_platform_ladder::KIND {
        crate::native_platform_ladder::validate_spec(spec).map(|_| ())
    } else {
        validate_spec(spec)
    }
}
pub fn verify_recipe(spec: &Value, recipe: &LadderRecipe) -> Result<()> {
    validate_spec(spec)?;
    ensure!(
        spec["renditions"] == serde_json::to_value(recipe.renditions())?
            && spec["estimated_output_bytes"].as_u64()
                == recipe.estimated_output_bytes(spec["duration_ms"].as_f64()),
        "local_hls_ladder_recipe_changed"
    );
    Ok(())
}

pub struct RenditionSnapshot {
    pub id: RenditionId,
    pub manifest: String,
    /// All proofs through the common prefix; retrying a publication is idempotent.
    pub files: Vec<FileProof>,
}
pub struct Snapshot {
    pub master: String,
    pub segment_count: i32,
    pub duration_us: i64,
    pub renditions: Vec<RenditionSnapshot>,
}
impl Snapshot {
    pub fn validate(&self, complete: bool) -> Result<()> {
        let master = parse_master(&self.master)?;
        ensure!(
            self.segment_count > 0
                && self.duration_us > 0
                && master.variants.len() == self.renditions.len(),
            "local_hls_ladder_snapshot_invalid"
        );
        for (variant, rendition) in master.variants.iter().zip(&self.renditions) {
            let playlist = parse_media_playlist(&rendition.manifest)?;
            ensure!(
                variant.id == rendition.id
                    && playlist.complete == complete
                    && playlist.segments.len() == self.segment_count as usize
                    && playlist.duration_us() == self.duration_us as u64
                    && rendition.files.len() == self.segment_count as usize + 1,
                "local_hls_ladder_snapshot_invalid"
            );
            for (position, file) in rendition.files.iter().enumerate() {
                ensure!(
                    file.index == position as i32 - 1
                        && file.size_bytes > 0
                        && file.sha256.len() == 64
                        && file
                            .sha256
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
                    "invalid_file_proof"
                );
            }
        }
        Ok(())
    }
}

pub async fn publish(
    pool: &PgPool,
    claim: &Claim,
    snapshot: &Snapshot,
    complete: bool,
) -> Result<bool> {
    snapshot.validate(complete)?;
    validate_any_ladder_spec(&claim.spec)?;
    let planned = claim.spec["renditions"].as_array().unwrap();
    ensure!(
        planned.len() == snapshot.renditions.len()
            && planned
                .iter()
                .zip(&snapshot.renditions)
                .all(|(p, r)| p["id"] == r.id.as_str()),
        "local_hls_ladder_missing_rendition"
    );
    for (actual, planned) in parse_master(&snapshot.master)?.variants.iter().zip(planned) {
        let codec = format!(
            "{}{}",
            planned["avc_codec"].as_str().unwrap_or(""),
            if planned["audio_bitrate"].is_null() {
                ""
            } else {
                ",mp4a.40.2"
            }
        );
        ensure!(
            planned["width"] == actual.width
                && planned["height"] == actual.height
                && planned["bandwidth"] == actual.bandwidth
                && codec == actual.codecs,
            "local_hls_ladder_recipe_changed"
        );
    }
    let mut tx = pool.begin().await?;
    let owned = sqlx::query("SELECT id FROM media_jobs WHERE id=$1 AND owner_id=$2 AND attempt=$3 AND status='running' AND hls_ladder_job_allowed(id) AND lease_until>clock_timestamp() FOR UPDATE")
        .bind(claim.id).bind(claim.owner).bind(claim.attempt).fetch_optional(&mut *tx).await?;
    if owned.is_none() {
        tx.rollback().await?;
        return Ok(false);
    }
    let output = sqlx::query("SELECT ready_segments FROM media_outputs WHERE job_id=$1 AND attempt=$2 AND owner_id=$3 AND status='writing' AND validation_version=5 FOR UPDATE")
        .bind(claim.id).bind(claim.attempt).bind(claim.owner).fetch_optional(&mut *tx).await?;
    let Some(output) = output else {
        tx.rollback().await?;
        return Ok(false);
    };
    ensure!(
        snapshot.segment_count >= output.get::<i32, _>("ready_segments"),
        "output_snapshot_regressed"
    );
    for rung in &snapshot.renditions {
        let indices = rung.files.iter().map(|f| f.index).collect::<Vec<_>>();
        let sizes = rung.files.iter().map(|f| f.size_bytes).collect::<Vec<_>>();
        let hashes = rung
            .files
            .iter()
            .map(|f| f.sha256.as_str())
            .collect::<Vec<_>>();
        let changed=sqlx::query("INSERT INTO local_hls_ladder_files(job_id,attempt,rendition,segment_index,size_bytes,sha256) SELECT $1,$2,$3,* FROM unnest($4::integer[],$5::bigint[],$6::text[]) ON CONFLICT(job_id,attempt,rendition,segment_index) DO UPDATE SET sha256=local_hls_ladder_files.sha256 WHERE local_hls_ladder_files.size_bytes=excluded.size_bytes AND local_hls_ladder_files.sha256=excluded.sha256")
            .bind(claim.id).bind(claim.attempt).bind(rung.id.as_str()).bind(indices).bind(sizes).bind(hashes).execute(&mut *tx).await?.rows_affected();
        ensure!(
            changed == rung.files.len() as u64,
            "published_output_changed"
        );
        let changed = sqlx::query("INSERT INTO local_hls_ladder_manifests(job_id,attempt,rendition,manifest,manifest_sha256,ready_segments,duration_us) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(job_id,attempt,rendition) DO UPDATE SET manifest=excluded.manifest,manifest_sha256=excluded.manifest_sha256,ready_segments=excluded.ready_segments,duration_us=excluded.duration_us WHERE local_hls_ladder_manifests.ready_segments<=excluded.ready_segments")
            .bind(claim.id).bind(claim.attempt).bind(rung.id.as_str()).bind(&rung.manifest).bind(digest(&rung.manifest)).bind(snapshot.segment_count).bind(snapshot.duration_us).execute(&mut *tx).await?.rows_affected();
        ensure!(changed == 1, "output_snapshot_regressed");
    }
    // A final same-authority check after all locks/proofs. Success records no
    // scalar single-rendition proof and is unavailable to the legacy publisher.
    let final_sql = format!(
        "{OWNED_TICK_SQL} UPDATE media_jobs j SET status=CASE WHEN $4 THEN 'succeeded' ELSE j.status END,lease_until=CASE WHEN $4 THEN NULL ELSE j.lease_until END,error=NULL,timing_version=CASE WHEN $4 THEN NULL ELSE j.timing_version END,timing_attempt=CASE WHEN $4 THEN NULL ELSE j.timing_attempt END,queue_entered_at=CASE WHEN $4 THEN NULL ELSE j.queue_entered_at END,run_started_at=CASE WHEN $4 THEN NULL ELSE j.run_started_at END FROM locked l CROSS JOIN tick t WHERE j.id=l.id AND j.id=$1 AND j.owner_id=$2 AND j.attempt=$3 AND j.status='running' AND j.lease_until>clock_timestamp() AND hls_ladder_job_allowed(j.id) RETURNING {SINGLE_PHASE_SQL}"
    );
    let ended = sqlx::query(&final_sql)
        .bind(claim.id)
        .bind(claim.owner)
        .bind(claim.attempt)
        .bind(complete)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(ended) = ended else {
        tx.rollback().await?;
        return Ok(false);
    };
    sqlx::query("UPDATE media_outputs SET visible_manifest=$4,manifest_sha256=$5,ready_segments=$6,status=CASE WHEN $7 THEN 'published' ELSE 'writing' END,segment_count=CASE WHEN $7 THEN $6 ELSE segment_count END,published_at=CASE WHEN $7 THEN clock_timestamp() ELSE published_at END WHERE job_id=$1 AND attempt=$2 AND owner_id=$3 AND validation_version=5")
        .bind(claim.id).bind(claim.attempt).bind(claim.owner).bind(&snapshot.master).bind(digest(&snapshot.master)).bind(snapshot.segment_count).bind(complete).execute(&mut *tx).await?;
    let mut delta = PendingJobHealth::default();
    if complete {
        record_single(&mut delta, &ended, "run_seconds", TimingKind::RunSucceeded);
    }
    let observation = delta.into_commit_observation();
    tx.commit().await?;
    observation.confirmed();
    Ok(true)
}
fn digest(text: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(text.as_bytes()))
}

pub struct ReadSnapshot {
    pub master: String,
    pub attempt: i64,
    pub status: String,
    pub segment_count: i32,
    pub duration_us: i64,
    pub renditions: Vec<(RenditionId, String)>,
}
pub async fn read(pool: &PgPool, id: Uuid) -> Result<Option<ReadSnapshot>> {
    let mut tx = pool.begin().await?;
    let row = sqlx::query("SELECT j.attempt,j.status,o.visible_manifest,o.manifest_sha256,o.ready_segments FROM media_jobs j JOIN media_outputs o ON o.job_id=j.id AND o.attempt=j.attempt AND o.owner_id=j.owner_id WHERE j.id=$1 AND hls_ladder_job_allowed(j.id) AND o.validation_version=5 AND ((j.status='succeeded' AND o.status='published') OR (j.status='running' AND j.lease_until>clock_timestamp() AND o.status='writing')) FOR SHARE OF j,o")
        .bind(id).fetch_optional(&mut *tx).await?;
    let Some(row) = row else {
        tx.rollback().await?;
        return Ok(None);
    };
    let Some(master) = row.get::<Option<String>, _>("visible_manifest") else {
        tx.rollback().await?;
        return Ok(None);
    };
    ensure!(
        row.get::<Option<String>, _>("manifest_sha256").as_deref()
            == Some(digest(&master).as_str()),
        "output_manifest_changed"
    );
    let parsed = parse_master(&master)?;
    let attempt: i64 = row.get("attempt");
    let segment_count: i32 = row.get("ready_segments");
    let status: String = row.get("status");
    let mut renditions = Vec::new();
    let mut duration_us = None;
    for variant in parsed.variants {
        let rung = sqlx::query("SELECT manifest,manifest_sha256,ready_segments,duration_us FROM local_hls_ladder_manifests WHERE job_id=$1 AND attempt=$2 AND rendition=$3")
            .bind(id).bind(attempt).bind(variant.id.as_str()).fetch_one(&mut *tx).await?;
        let text: String = rung.get("manifest");
        let playlist = parse_media_playlist(&text)?;
        let duration: i64 = rung.get("duration_us");
        ensure!(
            rung.get::<String, _>("manifest_sha256") == digest(&text)
                && rung.get::<i32, _>("ready_segments") == segment_count
                && playlist.segments.len() == segment_count as usize
                && playlist.duration_us() == duration as u64
                && playlist.complete == (status == "succeeded")
                && duration_us.is_none_or(|d| d == duration),
            "local_hls_ladder_snapshot_invalid"
        );
        duration_us = Some(duration);
        renditions.push((variant.id, text));
    }
    // Share locks retain one atomic common-prefix snapshot through this commit.
    tx.commit().await?;
    Ok(Some(ReadSnapshot {
        master,
        attempt,
        status,
        segment_count,
        duration_us: duration_us.unwrap(),
        renditions,
    }))
}
pub async fn file_proof(
    pool: &PgPool,
    id: Uuid,
    attempt: i64,
    rendition: RenditionId,
    index: i32,
) -> Result<FileProof> {
    let row = sqlx::query("SELECT size_bytes,sha256 FROM local_hls_ladder_files WHERE job_id=$1 AND attempt=$2 AND rendition=$3 AND segment_index=$4")
        .bind(id).bind(attempt).bind(rendition.as_str()).bind(index).fetch_one(pool).await?;
    Ok(FileProof {
        index,
        size_bytes: row.get("size_bytes"),
        sha256: row.get("sha256"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_single_output_or_unsealed_specs() {
        assert!(validate_spec(&json!({"kind":"local_hls_ladder_transcode_v1"})).is_err());
        assert!(validate_spec(&json!({"kind":"advanced_local_transcode_v1"})).is_err());
    }
    fn source() -> Value {
        json!({"streams":[{"index":0,"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"pix_fmt":"yuv420p","sample_aspect_ratio":"1:1","r_frame_rate":"30/1","avg_frame_rate":"30/1","disposition":{"attached_pic":0}}]})
    }
    #[test]
    fn aggregate_reservation_and_closed_recipe_are_reproduced() {
        let recipe = LadderRecipe::from_probe(&source(), None, 3.0).unwrap();
        let spec = job_spec(
            "/media",
            "film.mp4",
            &format!("stat-v1:{}", "a".repeat(64)),
            "encrypted",
            3.0,
            None,
            8000.0,
            5,
            7,
            &recipe,
        )
        .unwrap();
        verify_recipe(&spec, &recipe).unwrap();
        assert_eq!(spec["renditions"].as_array().unwrap().len(), 3);
        let sum = recipe
            .renditions()
            .iter()
            .map(|r| u64::from(r.bandwidth))
            .sum::<u64>();
        assert!(spec["estimated_output_bytes"].as_u64().unwrap() >= sum * 5 / 8);
        for (field, value) in [
            ("kind", json!("local_hls_ladder_transcode_v2")),
            ("recipe_version", json!(2)),
            ("plan_generation", json!(0)),
            ("source_version", json!("unversioned")),
            ("duration_ms", json!(3000)),
            ("advanced_media", json!({"tone_map_hdr":true})),
        ] {
            let mut bad = spec.clone();
            bad[field] = value;
            assert!(validate_spec(&bad).is_err(), "{field}");
        }
        let mut extra = spec.clone();
        extra["renditions"][0]
            .as_object_mut()
            .unwrap()
            .remove("audio_bitrate");
        extra["renditions"][0]["extra"] = json!(null);
        assert!(validate_spec(&extra).is_err());
        let mut bad = spec.clone();
        bad["estimated_output_bytes"] = json!(1);
        assert!(verify_recipe(&bad, &recipe).is_err());
        let mut bad = spec;
        bad["renditions"][0]["width"] = json!(6400);
        assert!(verify_recipe(&bad, &recipe).is_err());
    }
    #[test]
    fn snapshot_requires_every_planned_prefix_and_proof() {
        let master = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,FRAME-RATE=30.000,CODECS=\"avc1.64001F\"\nlow/index.m3u8\n";
        let playlist = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:4.000000,\nindex0.m4s\n";
        let mut snapshot = Snapshot {
            master: master.into(),
            segment_count: 1,
            duration_us: 4_000_000,
            renditions: vec![RenditionSnapshot {
                id: RenditionId::Low,
                manifest: playlist.into(),
                files: vec![],
            }],
        };
        assert!(snapshot.validate(false).is_err());
        snapshot.renditions[0].files = (-1..=0)
            .map(|index| FileProof {
                index,
                size_bytes: 1,
                sha256: "a".repeat(64),
            })
            .collect();
        assert!(snapshot.validate(false).is_ok());
        assert!(snapshot.validate(true).is_err());
        snapshot.segment_count = 2;
        assert!(snapshot.validate(false).is_err());
    }
}
