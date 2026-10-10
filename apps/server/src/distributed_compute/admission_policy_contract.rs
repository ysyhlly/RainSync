//! Characterization of actual parent helpers in both source phases.
//! No legacy implementation, estimate formula, synthetic Error or I/O helper.
use super::{Source, budget_fits, estimated_output_bytes, valid_capabilities};
use axum::{body::to_bytes, response::IntoResponse};
use serde_json::{Value, json};

fn record(suite: &str, id: &str, input: &Value, output: &Value) {
    // Leading newline avoids libtest's unfinished status line.
    println!(
        "\nP19_CASE {}",
        json!({"suite": suite, "id": id, "input": input, "output": output})
    );
}

fn budget_probes(estimate: Option<u64>) -> Value {
    let mut budgets = vec![
        i64::MIN,
        -1,
        0,
        1,
        64 * 1024 * 1024,
        1024 * 1024 * 1024,
        i64::MAX,
    ];
    if let Some(bytes) = estimate.and_then(|bytes| i64::try_from(bytes).ok()) {
        budgets.push(bytes);
        if let Some(before) = bytes.checked_sub(1) {
            budgets.push(before);
        }
        if let Some(after) = bytes.checked_add(1) {
            budgets.push(after);
        }
    }
    budgets.sort_unstable();
    budgets.dedup();
    json!(
        budgets
            .into_iter()
            .map(|budget| { json!({"budget": budget, "fits": budget_fits(estimate, budget)}) })
            .collect::<Vec<_>>()
    )
}

async fn estimate_observation(result: crate::Result<Option<u64>>) -> Value {
    match result {
        Ok(estimate) => json!({
            "kind": "ok", "estimate_bytes": estimate,
            "budget_probes": budget_probes(estimate),
        }),
        Err(error) => {
            // Retain every return-value field and the real external adapter's
            // serialized body/header bytes, not an enum or reconstructed body.
            let status = error.0.as_u16();
            let reason = error.1.clone();
            let retry_after_seconds = error.2;
            let response = error.into_response();
            let http_status = response.status().as_u16();
            let version = format!("{:?}", response.version());
            let mut names: Vec<_> = response
                .headers()
                .keys()
                .map(|name| name.as_str())
                .collect();
            names.sort_unstable();
            names.dedup();
            let headers: Vec<_> = names
                .into_iter()
                .map(|name| {
                    json!([
                        name,
                        response
                            .headers()
                            .get_all(name)
                            .iter()
                            .map(|value| { hex::encode(value.as_bytes()) })
                            .collect::<Vec<_>>()
                    ])
                })
                .collect();
            let body = to_bytes(response.into_body(), 4096).await.unwrap();
            json!({
                "kind": "error", "status": status, "reason": reason,
                "retry_after_seconds": retry_after_seconds,
                "http": {"status": http_status, "version": version,
                    "headers": headers, "body_hex": hex::encode(body)},
            })
        }
    }
}

fn source_observation(body: &Value) -> Value {
    match serde_json::from_value::<Source>(body.clone()) {
        Ok(source) => json!({"kind": "ok", "source": {
            "media_id": source.media_id, "source_version": source.source_version,
            "content_sha256": source.content_sha256, "size_bytes": source.size_bytes,
        }}),
        Err(error) => json!({"kind": "error", "message": error.to_string(),
            "category": format!("{:?}", error.classify()),
            "line": error.line(), "column": error.column()}),
    }
}

#[tokio::test]
async fn real_admission_outputs_preserve_status_priority_and_serialization() {
    let matrix: Value = serde_json::from_str(include_str!("admission_policy_inputs.json")).unwrap();
    for case in matrix["cases"].as_array().unwrap() {
        let suite = case["suite"].as_str().unwrap();
        let id = case["id"].as_str().unwrap();
        let input = &case["input"];
        let output = match suite {
            "capabilities" => {
                let capabilities: Vec<String> =
                    serde_json::from_value(input["capabilities"].clone()).unwrap();
                json!({"valid": valid_capabilities(&capabilities)})
            }
            "estimate" => {
                estimate_observation(estimated_output_bytes(
                    input["recipe"].as_str().unwrap(),
                    &input["metadata"],
                    input["source_version"].as_str().unwrap(),
                    input["source_bytes"].as_i64().unwrap(),
                    input["with_audio"].as_bool().unwrap(),
                ))
                .await
            }
            "budget" => {
                let estimate: Option<u64> =
                    serde_json::from_value(input["estimate_bytes"].clone()).unwrap();
                json!({"fits": budget_fits(estimate, input["budget"].as_i64().unwrap())})
            }
            "source_decode" => source_observation(&input["body"]),
            _ => panic!("unexpected matrix suite {suite}"),
        };
        // A few literal contract anchors supplement the old version's complete
        // output oracle. This is a field matcher, not a second policy algorithm.
        if let Some(expected) = case["expected"].as_object() {
            for (key, value) in expected {
                assert_eq!(&output[key], value, "{suite}/{id}: {key}");
            }
        }
        record(suite, id, input, &output);
    }
}
