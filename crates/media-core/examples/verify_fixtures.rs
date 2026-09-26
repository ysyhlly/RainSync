use anyhow::{Context, Result, ensure};

fn main() -> Result<()> {
    let path = std::env::args()
        .nth(1)
        .unwrap_or(".runtime/fixtures/manifest.json".into());
    let report: serde_json::Value = serde_json::from_slice(&std::fs::read(path)?)?;
    let cases = report["cases"].as_array().context("missing cases")?;
    ensure!(!cases.is_empty(), "empty fixture manifest");
    for case in cases {
        let id = case["id"].as_str().context("missing id")?;
        let result = media_core::compatible_mode(&case["metadata"], false);
        if let Some(expected) = case["expected_error"].as_str() {
            let error = result.expect_err("unsupported fixture must be refused");
            ensure!(
                error.to_string() == expected,
                "{id}: unexpected error {error}"
            );
        } else {
            let expected = case["expected_mode"]
                .as_str()
                .context("missing expected route")?;
            ensure!(result? == expected, "{id}: unexpected playback route");
        }
        println!("PASS: {id}");
    }
    Ok(())
}
