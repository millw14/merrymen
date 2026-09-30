"""Verify the committed MerrymenBrain export without accessing another repository."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent / "brain/vendor/merrymenbrain_perps"
manifest = json.loads((root / "PROVENANCE.json").read_text())
if manifest["repository"] != "https://github.com/millw14/merrymenbrain" or manifest["license"] != "Apache-2.0":
    raise SystemExit("Unexpected MerrymenBrain provenance")
for name, expected in manifest["files"].items():
    if Path(name).name != name or hashlib.sha256((root / name).read_bytes()).hexdigest() != expected:
        raise SystemExit(f"MerrymenBrain export changed: {name}")
extras = {p.name for p in root.iterdir() if p.is_file()} - set(manifest["files"]) - {"PROVENANCE.json"}
if extras:
    raise SystemExit(f"Unexpected files in MerrymenBrain export: {sorted(extras)}")
print(f"MerrymenBrain perps export verified: {manifest['source_commit']}")
