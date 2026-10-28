"""Admin loader: attach a PNG figure to a recorded OmegaEvolve report on a hive (lab-figures r1).

One call per figure, through the hive's own route (POST /api/evolve/swarms/{swarm}/records/{record}/figures), as a
signed-in admin or the report's contributor. The file's sha256 is computed here and, when --sha256 is given, must
equal it before anything is sent. Nothing else is fetched or changed; the report itself is never modified.

    HIVE_TOKEN=<session token> python -m hive.tools.evolve_figures_load --hive https://<hive>/omegahive \\
        --swarm <swarm_id> --record <record_id> --file <figure.png> --sha256 <hex> \\
        --caption-file <caption.txt> [--source-locator <archive member path>]

Prints the attached figure as JSON (sha256, bytes, width, height, caption, read_url).
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import pathlib
import sys


def attach_file(client, swarm_id, record_id, path, caption, source_locator=None, expect_sha256=None, headers=None):
    """POST one figure with an httpx-style client (base URL already set). Exits on a hash mismatch or a refusal."""
    data = pathlib.Path(path).read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if expect_sha256 and expect_sha256 != digest:
        raise SystemExit(f"{path}: sha256 {digest} is not the expected {expect_sha256}; nothing sent")
    body = {"sha256": digest, "caption": caption, "content_base64": base64.b64encode(data).decode()}
    if source_locator:
        body["source_locator"] = source_locator
    r = client.post(f"/api/evolve/swarms/{swarm_id}/records/{record_id}/figures", json=body, headers=headers or {})
    if r.status_code != 200:
        raise SystemExit(f"{path}: refused {r.status_code}: {r.text[:500]}")
    return r.json()


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--hive", required=True, help="the hive's base URL, e.g. https://host/omegahive")
    p.add_argument("--swarm", required=True)
    p.add_argument("--record", required=True)
    p.add_argument("--file", required=True)
    p.add_argument("--sha256", help="the expected sha256 of the file (refuses before sending if it differs)")
    p.add_argument("--caption-file", required=True, help="a UTF-8 text file holding the caption, exactly as shown")
    p.add_argument("--source-locator")
    args = p.parse_args(argv)
    token = os.environ.get("HIVE_TOKEN")
    if not token:
        raise SystemExit("set HIVE_TOKEN to a signed-in admin or contributor session token")
    import httpx
    caption = pathlib.Path(args.caption_file).read_text(encoding="utf-8").strip()
    with httpx.Client(base_url=args.hive.rstrip("/"), headers={"Authorization": f"Bearer {token}"},
                      timeout=120, follow_redirects=False) as client:
        out = attach_file(client, args.swarm, args.record, args.file, caption, args.source_locator, args.sha256)
    json.dump(out, sys.stdout, indent=1)
    print()


if __name__ == "__main__":
    main()
