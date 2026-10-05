//! Closed finite native ladder jobs reuse the original opaque input custody.
//! An encoder observation never populates public rendition facts directly.
use crate::native_platform_transcode::{self as native, Spec as InputSpec};
use anyhow::{Result, ensure};
use media_core::hls_ladder::LadderRecipe;
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;
pub const QUEUE: &str = "native_platform_hls_ladder_v1";
pub const KIND: &str = "native_platform_clear_ladder_v1";
pub struct Spec {
    pub input: InputSpec,
    pub source_generation: u32,
    pub plan_generation: u32,
    pub renditions: Value,
}
pub fn validate_spec(value: &Value) -> Result<Spec> {
    let mut input = value.clone();
    let object = input
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("native_platform_ladder_spec_invalid"))?;
    ensure!(
        object.len()
            == 13
                + usize::from(object.contains_key("source_video"))
                + usize::from(object.contains_key("source_webm"))
            && object.get("kind") == Some(&json!(KIND)),
        "native_platform_ladder_spec_invalid"
    );
    let source_generation = object
        .remove("source_generation")
        .and_then(|v| v.as_u64())
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(|| anyhow::anyhow!("native_platform_ladder_spec_invalid"))?;
    let plan_generation = object
        .remove("plan_generation")
        .and_then(|v| v.as_u64())
        .and_then(|v| u32::try_from(v).ok())
        .filter(|v| *v > 0)
        .ok_or_else(|| anyhow::anyhow!("native_platform_ladder_spec_invalid"))?;
    let renditions = object
        .remove("renditions")
        .ok_or_else(|| anyhow::anyhow!("native_platform_ladder_spec_invalid"))?;
    object.insert("kind".into(), json!(native::KIND));
    let input = native::validate_spec(&input)?;
    // Reuse the closed geometry/rate grammar, never a permissive rendition DTO.
    let local = json!({"kind":crate::local_hls_ladder::KIND,"recipe_version":1,"root":"/sealed","resource":"opaque","source_kind":"local","input_ticket":"opaque","start_seconds":input.start_seconds,"transcode":true,"audio_index":1,"estimated_output_bytes":input.estimated_output_bytes,"negotiated_mode":"transcode","source_version":format!("stat-v1:{}","0".repeat(64)),"duration_ms":input.duration_seconds*1000.0,"source_generation":source_generation,"plan_generation":plan_generation,"renditions":renditions});
    crate::local_hls_ladder::validate_spec(&local)?;
    Ok(Spec {
        input,
        source_generation,
        plan_generation,
        renditions,
    })
}
pub fn job_spec(
    input: &InputSpec,
    source_generation: u32,
    plan_generation: u32,
    recipe: &LadderRecipe,
) -> Result<Value> {
    ensure!(recipe.has_audio(), "native_platform_audio_required");
    let mut value = serde_json::to_value(input)?;
    value["kind"] = json!(KIND);
    value["source_generation"] = json!(source_generation);
    value["plan_generation"] = json!(plan_generation);
    value["renditions"] = serde_json::to_value(recipe.renditions())?;
    value["estimated_output_bytes"] = json!(
        recipe
            .estimated_output_bytes(Some(input.duration_seconds * 1000.0))
            .ok_or_else(|| anyhow::anyhow!("native_platform_ladder_duration_required"))?
    );
    validate_spec(&value)?;
    Ok(value)
}
pub fn verify_recipe(value: &Value, recipe: &LadderRecipe) -> Result<()> {
    let spec = validate_spec(value)?;
    ensure!(
        spec.renditions == serde_json::to_value(recipe.renditions())?
            && spec.input.estimated_output_bytes
                == recipe
                    .estimated_output_bytes(Some(spec.input.duration_seconds * 1000.0))
                    .unwrap_or(0),
        "native_platform_ladder_recipe_changed"
    );
    Ok(())
}
pub async fn enqueue(
    tx: &mut Transaction<'_, Postgres>,
    session: Uuid,
    spec: &Value,
    limit: i64,
) -> Result<bool> {
    let spec = validate_spec(spec)?;
    sqlx::query("INSERT INTO native_platform_transcodes(session_id,user_id,room_id,media_id,generation,viewer_id,plan_generation,auth_login_hash,lifecycle_epoch,frozen_resource,deadline_ms,byte_limit) SELECT id,user_id,room_id,media_id,generation,viewer_id,plan_generation,auth_login_hash,lifecycle_epoch,resource,$2,$3 FROM playback_sessions WHERE id=$1 AND resource->'native_platform_hls_ladder_version'='1'::jsonb AND resource->'native_platform_context'->'version' IN ('1'::jsonb,'2'::jsonb,'4'::jsonb) AND generation=$4 AND plan_generation=$5 AND NOT stopped AND expires_at>clock_timestamp()")
        .bind(session).bind(spec.input.deadline_ms).bind(i64::try_from(spec.input.byte_budget())?).bind(i64::from(spec.source_generation)).bind(i64::from(spec.plan_generation)).execute(&mut **tx).await?;
    crate::media_queue::enqueue_native_platform_ladder(tx, session, &job_value(&spec)?, limit)
        .await
        .map_err(Into::into)
}
fn job_value(spec: &Spec) -> Result<Value> {
    let mut v = serde_json::to_value(&spec.input)?;
    v["kind"] = json!(KIND);
    v["source_generation"] = json!(spec.source_generation);
    v["plan_generation"] = json!(spec.plan_generation);
    v["renditions"] = spec.renditions.clone();
    Ok(v)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn original_inputs_remain_closed_and_opaque() {
        let input = InputSpec {
            source_webm: None,
            source_video: None,
            kind: native::KIND.into(),
            recipe_version: 1,
            source_kind: "native_platform_private".into(),
            negotiated_mode: "transcode".into(),
            tracks: vec![native::Track {
                container: Default::default(),
                key: "progressive".into(),
                ticket: "a".repeat(64),
                total_bytes: 99,
                strong_etag: "\"e\"".into(),
            }],
            output_ticket: "b".repeat(64),
            duration_seconds: 10.0,
            start_seconds: 1.0,
            deadline_ms: 1000,
            estimated_output_bytes: 1,
        };
        let probe = json!({"streams":[{"index":0,"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"pix_fmt":"yuv420p","sample_aspect_ratio":"1:1","r_frame_rate":"30/1","avg_frame_rate":"30/1","disposition":{"attached_pic":0}},{"index":1,"codec_type":"audio","codec_name":"aac"}]});
        let recipe = LadderRecipe::from_probe(&probe, Some(1), 1.0).unwrap();
        let value = job_spec(&input, 2, 3, &recipe).unwrap();
        verify_recipe(&value, &recipe).unwrap();
        assert!(native::validate_spec(&value).is_err());
        for field in ["url", "cookie", "filter", "source_version"] {
            let mut v = value.clone();
            v[field] = json!("forbidden");
            assert!(validate_spec(&v).is_err());
        }
        let mut v = value;
        v["renditions"][0]["bandwidth"] = json!(1);
        assert!(validate_spec(&v).is_err());
    }
}
