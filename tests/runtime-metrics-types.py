"""Compile checks: body byte hooks cannot accept negative or nonfinite inputs.

Run with python3 tests/runtime-metrics-types.py (rustc must be on PATH).
No dependencies, network, database, or shared build directory are used.
"""
from pathlib import Path
import subprocess
import tempfile

source = Path(__file__).resolve().parents[1] / "apps/server/src/runtime_metrics.rs"
with tempfile.TemporaryDirectory(prefix="rainsync-w08-types-") as temporary:
    root = Path(temporary)
    library = root / "libruntime_metrics.rlib"
    subprocess.run([
        "rustc", "--edition=2021", "--crate-type=lib", str(source), "-o", str(library)
    ], check=True, capture_output=True)
    for name, expression, diagnostic in [
        ("negative", "-1", "E0600"),
        ("nan", "f64::NAN", "E0308"),
        ("infinity", "f64::INFINITY", "E0308"),
    ]:
        candidate = root / f"{name}.rs"
        candidate.write_text(
            "use runtime_metrics::{RuntimeMetrics,Layer,Cache};\n"
            "fn main() { let metrics = RuntimeMetrics::default();\n"
            "let mut transfer = metrics.begin_transfer(Layer::WorkerEgress,Cache::NotHit).unwrap();\n"
            f"transfer.sample(1,{expression}); }}\n"
        )
        result = subprocess.run([
            "rustc", "--edition=2021", str(candidate),
            "--extern", f"runtime_metrics={library}", "-o", str(root / name)
        ], capture_output=True, text=True)
        assert result.returncode != 0 and diagnostic in result.stderr, result.stderr
        print(f"PASS: {name} body-byte input rejected at compile time ({diagnostic})")
