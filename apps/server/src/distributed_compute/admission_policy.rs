//! Data-only admission prechecks, with no HTTP, environment or storage access.
//! Fixed recipes and their estimation arithmetic remain owned by media_core.
use media_core::distributed_compute::{
    COMPUTE_RECIPES, MAX_SOURCE_DURATION_SECONDS, compute_recipe,
};
use serde_json::Value;

pub(super) const MAX_SOURCE_BYTES: i64 = 16 * 1024 * 1024 * 1024;

#[derive(Debug)]
pub(super) enum AdmissionError {
    InvalidRecipe,
    SourceTooLarge,
    SourceDurationUnsupported,
}

pub(super) fn valid_capabilities(capabilities: &[String]) -> bool {
    !capabilities.is_empty()
        && capabilities.len() <= COMPUTE_RECIPES.len()
        && capabilities
            .iter()
            .enumerate()
            .all(|(i, id)| compute_recipe(id).is_ok() && !capabilities[..i].contains(id))
}

// Only version-bound probe metadata may influence admission. This is a
// conservative capacity estimate, not a promise of actual encoded size. Unknown
// metadata/remux still undergo the node and server runtime byte/probe checks.
pub(super) fn estimated_output_bytes(
    recipe: &str,
    metadata: &Value,
    source_version: &str,
    source_bytes: i64,
    with_audio: bool,
) -> Result<Option<u64>, AdmissionError> {
    let recipe = compute_recipe(recipe).map_err(|_| AdmissionError::InvalidRecipe)?;
    if source_bytes <= 0 || source_bytes > MAX_SOURCE_BYTES {
        return Err(AdmissionError::SourceTooLarge);
    }
    if metadata["capability_source_version"].as_str() != Some(source_version)
        || metadata["format"]["duration"].is_null()
    {
        return Ok(None);
    }
    let duration = metadata["format"]["duration"].as_f64().or_else(|| {
        metadata["format"]["duration"]
            .as_str()
            .and_then(|v| v.parse::<f64>().ok())
    });
    let duration = duration
        .filter(|v| v.is_finite() && *v > 0.0 && *v <= MAX_SOURCE_DURATION_SECONDS)
        .ok_or(AdmissionError::SourceDurationUnsupported)?;
    // Preserve legacy 480p/remux admission; their actual runtime byte limits
    // still apply. Only the new HD recipes reserve conservative capacity.
    Ok((recipe.segment_seconds == 2)
        .then(|| recipe.estimated_output_bytes(duration, with_audio))
        .flatten())
}

pub(super) fn budget_fits(estimate: Option<u64>, budget: i64) -> bool {
    budget > 0 && estimate.is_none_or(|bytes| bytes <= budget as u64)
}
