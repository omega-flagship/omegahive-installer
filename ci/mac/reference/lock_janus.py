#!/usr/bin/env python3
from pathlib import Path
import hashlib
import json
import zipfile

root = Path(__file__).resolve().parent
wheels = list((root / "wheelhouse").glob("janus_swi-1.5.3-*.whl"))
assert len(wheels) == 1, wheels
wheel = wheels[0]
digest = hashlib.sha256(wheel.read_bytes()).hexdigest()
line = f"janus_swi==1.5.3 --hash=sha256:{digest}\n"
(root / "janus-requirements.lock").write_text(line)
(root / "final-runtime-requirements.lock").write_text((root / "runtime-requirements.lock").read_text() + line)
(root / "receipts/janus-built-wheel.json").write_text(json.dumps({
    "file": wheel.name, "sha256": digest, "bytes": wheel.stat().st_size,
    "source": "stock Janus 1.5.3, build-only loader-relative rpath derivative; PBS Python 3.12.15/SWI 10.1.14",
    "install": "offline --require-hashes --no-deps --no-compile before runtime qualification",
}, indent=2) + "\n")
print(wheel.name, digest)
