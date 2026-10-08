"""Compile checks: body byte hooks cannot accept negative or nonfinite inputs.

Run with python3 tests/runtime-metrics-types.py (rustc must be on PATH).
Uses the actual locked media-core Cargo artifact; no database is used.
"""
from pathlib import Path
import subprocess
import json
import tempfile

repo = Path(__file__).resolve().parents[1]
build = subprocess.run([
    "cargo", "build", "--locked", "--offline", "-p", "media-core", "--message-format=json"
], cwd=repo, check=True, capture_output=True, text=True)
artifacts = [json.loads(line) for line in build.stdout.splitlines() if line.startswith("{")]
libraries = [Path(path) for item in artifacts
    if item.get("reason") == "compiler-artifact" and item.get("target", {}).get("name") == "media_core"
    for path in item.get("filenames", []) if path.endswith(".rlib")]
assert len(libraries) == 1, "one exact media-core artifact must be resolved from Cargo"
library = libraries[0]
dependencies = library.parent / "deps" if (library.parent / "deps").is_dir() else library.parent
with tempfile.TemporaryDirectory(prefix="rainsync-w08-types-") as temporary:
    root = Path(temporary)
    for name, expression, diagnostic in [
        ("negative", "-1", "E0600"),
        ("nan", "f64::NAN", "E0308"),
        ("infinity", "f64::INFINITY", "E0308"),
    ]:
        candidate = root / f"{name}.rs"
        candidate.write_text(
            "use media_core::runtime_metrics::{RuntimeMetrics,Layer,Cache};\n"
            "fn main() { let metrics = RuntimeMetrics::default();\n"
            "let mut transfer = metrics.begin_transfer(Layer::WorkerEgress,Cache::NotHit).unwrap();\n"
            f"transfer.sample(1,{expression}); }}\n"
        )
        result = subprocess.run([
            "rustc", "--edition=2021", str(candidate),
            "--extern", f"media_core={library}", "-L", f"dependency={dependencies}", "-o", str(root / name)
        ], capture_output=True, text=True)
        assert result.returncode != 0 and diagnostic in result.stderr, result.stderr
        print(f"PASS: {name} body-byte input rejected at compile time ({diagnostic})")
