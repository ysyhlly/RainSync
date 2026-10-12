//! Pure projection of the Worker's existing owner and cache snapshots.
use std::fmt::Write;

pub(super) fn append_observations(
    output: &mut String,
    owners: Option<media_core::child_process::OwnerSnapshot>,
    inventory: Option<crate::readiness::CacheInventorySnapshot>,
) {
    for (name, help) in [
        (
            "rainsync_process_owner_observation_available",
            "Whether the process owner registry was available without waiting.",
        ),
        (
            "rainsync_owned_process_tree_owners",
            "Registered process-tree owners, not a physical process count or drain receipt.",
        ),
        (
            "rainsync_process_admission_closed",
            "Whether process admission is closed.",
        ),
        (
            "rainsync_process_cleanup_failed",
            "Whether the owner registry retained a cleanup failure; zero owners is not a successful drain receipt.",
        ),
        (
            "rainsync_cache_inventory_available",
            "Whether a fresh successful cache traversal observation is available.",
        ),
        (
            "rainsync_cache_regular_files",
            "Regular-file entries observed by the bounded readiness scan, excluding symlinks and its probe file; not an atomic inventory.",
        ),
        (
            "rainsync_cache_logical_bytes",
            "Logical regular-file lengths observed by the bounded readiness scan; not allocated disk bytes or an atomic inventory.",
        ),
        (
            "rainsync_cache_inventory_age_seconds",
            "Monotonic age of the fresh successful cache traversal observation.",
        ),
    ] {
        writeln!(output, "# HELP {name} {help}\n# TYPE {name} gauge").unwrap();
    }
    writeln!(
        output,
        "rainsync_process_owner_observation_available{{process=\"worker\"}} {}",
        u8::from(owners.is_some())
    )
    .unwrap();
    if let Some(owners) = owners {
        writeln!(
            output,
            "rainsync_owned_process_tree_owners{{process=\"worker\"}} {}",
            owners.active_owners
        )
        .unwrap();
        writeln!(
            output,
            "rainsync_process_admission_closed{{process=\"worker\"}} {}",
            u8::from(owners.admission_closed)
        )
        .unwrap();
        writeln!(
            output,
            "rainsync_process_cleanup_failed{{process=\"worker\"}} {}",
            u8::from(owners.cleanup_failed)
        )
        .unwrap();
    }
    writeln!(
        output,
        "rainsync_cache_inventory_available{{process=\"worker\"}} {}",
        u8::from(inventory.is_some())
    )
    .unwrap();
    if let Some(inventory) = inventory {
        writeln!(
            output,
            "rainsync_cache_regular_files{{process=\"worker\"}} {}",
            inventory.regular_files
        )
        .unwrap();
        writeln!(
            output,
            "rainsync_cache_logical_bytes{{process=\"worker\"}} {}",
            inventory.logical_bytes
        )
        .unwrap();
        writeln!(
            output,
            "rainsync_cache_inventory_age_seconds{{process=\"worker\"}} {}",
            inventory.age.as_secs_f64()
        )
        .unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn unavailable_observations_omit_counts_instead_of_exporting_zero() {
        let mut output = String::new();
        append_observations(&mut output, None, None);
        let samples: Vec<_> = output
            .lines()
            .filter(|line| !line.starts_with('#'))
            .collect();
        assert_eq!(
            samples,
            [
                "rainsync_process_owner_observation_available{process=\"worker\"} 0",
                "rainsync_cache_inventory_available{process=\"worker\"} 0",
            ]
        );
    }
    #[test]
    fn successful_empty_inventory_and_owner_failure_are_independent_fixed_gauges() {
        let mut output = String::new();
        append_observations(
            &mut output,
            Some(media_core::child_process::OwnerSnapshot {
                active_owners: 0,
                admission_closed: true,
                cleanup_failed: true,
            }),
            Some(crate::readiness::CacheInventorySnapshot {
                regular_files: 0,
                logical_bytes: 0,
                age: Duration::from_millis(1250),
            }),
        );
        for sample in [
            "rainsync_process_owner_observation_available{process=\"worker\"} 1",
            "rainsync_owned_process_tree_owners{process=\"worker\"} 0",
            "rainsync_process_admission_closed{process=\"worker\"} 1",
            "rainsync_process_cleanup_failed{process=\"worker\"} 1",
            "rainsync_cache_inventory_available{process=\"worker\"} 1",
            "rainsync_cache_regular_files{process=\"worker\"} 0",
            "rainsync_cache_logical_bytes{process=\"worker\"} 0",
            "rainsync_cache_inventory_age_seconds{process=\"worker\"} 1.25",
        ] {
            assert!(
                output.lines().any(|line| line == sample),
                "missing {sample}"
            );
        }
        assert_eq!(
            output
                .lines()
                .filter(|line| line.starts_with("# TYPE ") && line.ends_with(" gauge"))
                .count(),
            8
        );
        assert!(output.len() < 4096);
    }
    #[test]
    fn nonzero_inventory_exports_observed_values_without_identity_labels() {
        let mut output = String::new();
        append_observations(
            &mut output,
            Some(media_core::child_process::OwnerSnapshot {
                active_owners: 7,
                admission_closed: false,
                cleanup_failed: false,
            }),
            Some(crate::readiness::CacheInventorySnapshot {
                regular_files: 11,
                logical_bytes: 2048,
                age: Duration::ZERO,
            }),
        );
        for sample in [
            "rainsync_owned_process_tree_owners{process=\"worker\"} 7",
            "rainsync_cache_regular_files{process=\"worker\"} 11",
            "rainsync_cache_logical_bytes{process=\"worker\"} 2048",
        ] {
            assert!(
                output.lines().any(|line| line == sample),
                "missing {sample}"
            );
        }
        assert!(
            output
                .lines()
                .filter(|line| !line.starts_with('#'))
                .all(|line| line
                    .split_once('{')
                    .unwrap()
                    .1
                    .starts_with("process=\"worker\"} "))
        );
    }

    #[test]
    fn observation_option_matrix_preserves_wire_shape_and_prefix() {
        let names = [
            "rainsync_process_owner_observation_available",
            "rainsync_owned_process_tree_owners",
            "rainsync_process_admission_closed",
            "rainsync_process_cleanup_failed",
            "rainsync_cache_inventory_available",
            "rainsync_cache_regular_files",
            "rainsync_cache_logical_bytes",
            "rainsync_cache_inventory_age_seconds",
        ];
        let prefixes = ["", "runtime-render sentinel\njob-health-render sentinel\n"];
        let mut owner_cases = vec![None];
        for active_owners in [0, 7, usize::MAX] {
            for admission_closed in [false, true] {
                for cleanup_failed in [false, true] {
                    owner_cases.push(Some(media_core::child_process::OwnerSnapshot {
                        active_owners,
                        admission_closed,
                        cleanup_failed,
                    }));
                }
            }
        }
        let mut inventory_cases = vec![None];
        for regular_files in [0, 11, u64::MAX] {
            for logical_bytes in [0, 2048, u64::MAX] {
                for age in [
                    Duration::ZERO,
                    Duration::from_nanos(1),
                    Duration::from_nanos(999_999_999),
                    Duration::from_millis(1250),
                    Duration::MAX,
                ] {
                    inventory_cases.push(Some(crate::readiness::CacheInventorySnapshot {
                        regular_files,
                        logical_bytes,
                        age,
                    }));
                }
            }
        }
        assert_eq!(owner_cases.len(), 13);
        assert_eq!(inventory_cases.len(), 46);
        let dump = std::env::var_os("RAINSYNC_P22_BYTE_CORPUS").is_some();
        if dump {
            println!("\nP22_OBSERVATIONS_META_V1|{}|1196", usize::BITS);
        }
        let mut case = 0;
        for prefix in prefixes {
            for owners in &owner_cases {
                for inventory in &inventory_cases {
                    let mut output = prefix.to_owned();
                    append_observations(&mut output, *owners, *inventory);
                    assert!(
                        output.starts_with(prefix),
                        "case {case}: prefix was modified"
                    );
                    let suffix = &output[prefix.len()..];
                    assert!(suffix.ends_with('\n'), "case {case}: missing final newline");
                    assert!(suffix.len() < 4096, "case {case}: original fixed budget");
                    let lines: Vec<_> = suffix.lines().collect();
                    for (index, name) in names.iter().enumerate() {
                        assert!(
                            lines[index * 2].starts_with(&format!("# HELP {name} ")),
                            "case {case}: metadata ordering"
                        );
                        assert_eq!(lines[index * 2 + 1], format!("# TYPE {name} gauge"));
                    }
                    let mut expected = vec![format!(
                        "{}{{process=\"worker\"}} {}",
                        names[0],
                        u8::from(owners.is_some())
                    )];
                    if let Some(owners) = owners {
                        for (name, value) in [
                            (names[1], owners.active_owners.to_string()),
                            (names[2], u8::from(owners.admission_closed).to_string()),
                            (names[3], u8::from(owners.cleanup_failed).to_string()),
                        ] {
                            expected.push(format!("{name}{{process=\"worker\"}} {value}"));
                        }
                    }
                    expected.push(format!(
                        "{}{{process=\"worker\"}} {}",
                        names[4],
                        u8::from(inventory.is_some())
                    ));
                    if let Some(inventory) = inventory {
                        for (name, value) in [
                            (names[5], inventory.regular_files.to_string()),
                            (names[6], inventory.logical_bytes.to_string()),
                            (names[7], inventory.age.as_secs_f64().to_string()),
                        ] {
                            expected.push(format!("{name}{{process=\"worker\"}} {value}"));
                        }
                    }
                    assert_eq!(lines[16..], expected, "case {case}: exact samples/order");
                    assert_eq!(
                        expected.len(),
                        2 + usize::from(owners.is_some()) * 3
                            + usize::from(inventory.is_some()) * 3
                    );
                    if dump {
                        println!(
                            "\nP22_OBSERVATIONS_V1|{case}|{}",
                            hex::encode(output.as_bytes())
                        );
                    }
                    case += 1;
                }
            }
        }
        assert_eq!(case, 1196);
    }
}
