#!/usr/bin/env python3
"""Purpose: pin a fresh Linux release's UI, dependency lock and Omega core before building its catalogue."""
import argparse
import gzip
import hashlib
import io
import json
import pathlib
import re
import shutil
import tarfile


def pin(path):
    """Return the catalogue's exact identity for one generated input."""
    data = path.read_bytes()
    return {"path": path.name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def prepare(args):
    """Bind the existing catalogue shape to the current source, UI and lock."""
    inputs = pathlib.Path(args.inputs)
    source = pathlib.Path(args.source)
    base = json.loads(pathlib.Path(args.catalogue).read_text())
    assert base["apps"] == [], "A public release must not carry the historical private app inputs"
    assert set(base["bootstrap"]) == {"helper"}, "Public setup verifies the local owner only"
    commit = (source / "RELEASE_COMMIT").read_text().strip()
    tree = args.tree
    dist = source / "hive/ui/dist"
    assert (dist / "index.html").is_file(), "UI build left no index.html"
    files = {}
    raw = io.BytesIO()
    # Time: one read per UI file plus compression of their bytes. Space: the UI archive's bytes.
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for path in sorted(dist.rglob("*")):
            assert not path.is_symlink(), f"UI must not contain a symlink: {path}"
            if not path.is_file():
                continue
            data = path.read_bytes()
            name = path.relative_to(dist).as_posix()
            files[name] = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
            info = tarfile.TarInfo("dist/" + name)
            info.size, info.mode, info.mtime = len(data), 0o644, 0
            archive.addfile(info, io.BytesIO(data))
    ui_archive = inputs / "ui-dist-v033.tar.gz"
    ui_archive.write_bytes(gzip.compress(raw.getvalue(), mtime=0))
    manifest = inputs / "ui-dist-v033.manifest.json"
    manifest.write_text(json.dumps({"format": "omegahive.ui-prebuilt/1", "source_commit": commit,
                                   "source_tree": tree, "built_with": args.built_with,
                                   "file_count": len(files), "files": files}, indent=2, sort_keys=True) + "\n")
    base["ui_prebuilt"] = {"archive": pin(ui_archive), "manifest": pin(manifest),
                           "source_revision": commit, "source_tree": tree}
    for platform in base["platforms"].values():
        platform["core_lock"] = pin(inputs / "core.lock")
    # The minds' core, singnet/Omega at the revision the release pins, as the git bundle its Mac zip ships.
    revision = json.loads((source / "core-dependency.json").read_text())["revision"]
    assert re.fullmatch("[a-f0-9]{40}", revision), "core-dependency.json pins no full revision"
    base["omega_core"] = pin(inputs / f"omega-core-{revision[:7]}.bundle")
    for name in ("install", "bootstrap"):
        shutil.copyfile(source / f"deploy/linux/{name}.py", inputs / f"{name}.py")
    pathlib.Path(args.output).write_text(json.dumps(base, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"source_commit": commit, "source_tree": tree,
                      "ui": base["ui_prebuilt"], "core_lock": pin(inputs / "core.lock"), "omega_core": base["omega_core"]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--inputs", required=True)
    parser.add_argument("--catalogue", required=True)
    parser.add_argument("--tree", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--built-with", required=True)
    prepare(parser.parse_args())
