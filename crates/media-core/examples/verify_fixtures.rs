use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};

fn main() -> Result<()> {
    let path = std::env::args()
        .nth(1)
        .unwrap_or(".runtime/fixtures/manifest.json".into());
    let path = std::path::Path::new(&path);
    let report: serde_json::Value = serde_json::from_slice(&std::fs::read(path)?)?;
    let cases = report["cases"].as_array().context("missing cases")?;
    let catalog: serde_json::Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/media-cases.json"))?;
    let catalog = catalog.as_array().context("missing catalog")?;
    ensure!(cases.len() == catalog.len(), "incomplete fixture manifest");
    for expected_case in catalog {
        let id = expected_case["id"].as_str().context("missing id")?;
        let matching: Vec<_> = cases.iter().filter(|c| c["id"] == id).collect();
        ensure!(matching.len() == 1, "{id}: missing or duplicate fixture");
        let case = matching[0];
        for (key, value) in expected_case.as_object().context("fixture object")? {
            ensure!(case[key] == *value, "{id}: stale catalog field {key}");
        }
        let file = format!(
            "{id}.{}",
            expected_case["extension"].as_str().context("extension")?
        );
        ensure!(case["file"] == file, "{id}: unexpected filename");
        let bytes = std::fs::read(path.parent().context("manifest directory")?.join(file))?;
        ensure!(
            case["bytes"].as_u64() == Some(bytes.len() as u64),
            "{id}: size mismatch"
        );
        ensure!(
            case["sha256"] == format!("{:x}", Sha256::digest(&bytes)),
            "{id}: content changed since probe"
        );
        let result = media_core::compatible_mode(&case["metadata"], false);
        if let Some(expected) = expected_case["expected_error"].as_str() {
            let error = result.expect_err("unsupported fixture must be refused");
            ensure!(
                error.to_string() == expected,
                "{id}: unexpected error {error}"
            );
        } else {
            let expected = expected_case["expected_mode"]
                .as_str()
                .context("missing expected route")?;
            ensure!(result? == expected, "{id}: unexpected playback route");
        }
        if let Some(expected) = expected_case["expected_selected_audio_mode"].as_str() {
            ensure!(
                media_core::compatible_mode(&case["metadata"], true)? == expected,
                "{id}: selected audio route mismatch"
            );
        }
        println!("PASS: {id}");
    }
    Ok(())
}
