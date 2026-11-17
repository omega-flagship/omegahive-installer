"""Purpose: print the catalogue entry that pins one app zip (Studio is omegadesign) for the Linux kit.

The entry is the shape deploy/linux/install.py's validate_catalogue and extract_app check: the zip's own bytes and
sha256, the folder inside it that holds plugin.json, every file under that folder with its bytes, sha256 and git mode,
and the program digest, computed by the installer's own program_digest over the unpacked files so the pin and the
install-time check are one implementation. --expect-digest and --expect-file name values the pin must reproduce, such
as the release's published source digest and its ui/bundle.lock.json checksum; any mismatch is an error.

  app_pin.py --release release --id omegadesign --zip inputs/omegadesign-0.4.22.zip \
      --expect-digest sha256:<64 hex> --expect-file ui/bundle.lock.json=<64 hex>
"""
import argparse
import hashlib
import importlib.util
import json
import pathlib
import stat
import sys
import tempfile
import zipfile


def installer(release):
    """The release's own deploy/linux/install.py, loaded as a module and never run."""
    spec = importlib.util.spec_from_file_location("linux_install", release / "deploy/linux/install.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--release", required=True, type=pathlib.Path)
    parser.add_argument("--id", required=True)
    parser.add_argument("--zip", required=True, type=pathlib.Path)
    parser.add_argument("--expect-digest", required=True)
    parser.add_argument("--expect-file", action="append", default=[])
    args = parser.parse_args()
    install = installer(args.release)
    raw = args.zip.read_bytes()
    with zipfile.ZipFile(args.zip) as archive:
        manifests = [m.filename for m in archive.infolist() if pathlib.PurePosixPath(m.filename).name == "plugin.json"]
        if len(manifests) != 1:
            raise SystemExit(f"{args.zip}: expected one plugin.json, found {len(manifests)}")
        prefix = manifests[0][: -len("plugin.json")]
        rows = []
        # Time: one read of every member, b bytes hashed, b = the zip's uncompressed size.
        for member in sorted(archive.infolist(), key=lambda m: m.filename):
            if member.is_dir():
                continue
            if not member.filename.startswith(prefix):
                raise SystemExit(f"{member.filename} lies outside {prefix}")
            data = archive.read(member)
            mode = stat.S_IMODE(member.external_attr >> 16)
            rows.append({"path": member.filename[len(prefix):], "bytes": len(data),
                         "sha256": hashlib.sha256(data).hexdigest(), "mode": "100755" if mode & 0o111 else "100644"})
    install.checked_members(rows)
    spec = {"id": args.id, "path": args.zip.name, "prefix": prefix, "bytes": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(), "files": rows}
    with tempfile.TemporaryDirectory(prefix="app-pin-") as scratch:
        folder = pathlib.Path(scratch) / args.id
        install.extract_app(args.zip, folder, spec)
        spec["digest"] = install.program_digest(folder, rows)
    if spec["digest"] != args.expect_digest:
        raise SystemExit(f"program digest {spec['digest']} is not the expected {args.expect_digest}")
    by_path = {row["path"]: row["sha256"] for row in rows}
    for item in args.expect_file:
        name, _, expected = item.partition("=")
        if by_path.get(name) != expected:
            raise SystemExit(f"{name} has sha256 {by_path.get(name)}, not the expected {expected}")
    json.dump(spec, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
