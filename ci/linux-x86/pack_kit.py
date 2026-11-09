"""Pack the one-file newcomer download from the CI bundle (test kit for local user testing, never a published release).

Takes the bundle that make_catalogue.py built and checked, marks its catalogue copy ready (the same ready=True shape
run_install.py validates), packs it as the flat tar.gz the download expects, and fills the release's own
deploy/linux/installer.sh template: ROOT_BOUND_RELEASE=1, the bundle byte count and SHA256, then the base64 body.
Nothing is downloaded and no installer code is changed.
"""
import argparse
import base64
import gzip
import hashlib
import io
import json
import pathlib
import re
import tarfile

P = pathlib.Path
MARKER = "\n__OMEGAHIVE_BUNDLE_BASE64__\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", required=True)
    ap.add_argument("--template", required=True)   # release/deploy/linux/installer.sh
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    bundle = P(a.bundle)
    files = sorted(p for p in bundle.iterdir() if p.is_file())
    assert {"install.py", "release-manifest.json"} <= {p.name for p in files}, "bundle is incomplete"
    assert all(p.is_file() and not p.is_symlink() for p in bundle.iterdir()), "bundle must be flat regular files"
    assert len(files) <= 128

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT) as t:
        for p in files:
            data = p.read_bytes()
            if p.name == "release-manifest.json":
                catalogue = json.loads(data)
                catalogue["ready"] = True
                data = (json.dumps(catalogue, indent=2, sort_keys=True) + "\n").encode()
            info = tarfile.TarInfo(p.name)
            info.size, info.mode, info.mtime, info.uid, info.gid = len(data), 0o600, 0, 0, 0
            t.addfile(info, io.BytesIO(data))
    out_gz = io.BytesIO()
    with gzip.GzipFile(fileobj=out_gz, mode="wb", mtime=0, filename="") as g:
        g.write(buf.getvalue())
    raw = out_gz.getvalue()
    assert 0 < len(raw) <= 64 * 1024**2, "bundle exceeds the download's 64 MB limit"

    template = P(a.template).read_text()
    # The marker line (real newlines) occurs once, at the very end; the Python body names it only as an escaped literal.
    assert template.count(MARKER) == 1 and template.endswith(MARKER), "unexpected installer template"
    filled, n = re.subn(r"(?m)^ROOT_BOUND_RELEASE=0$", "ROOT_BOUND_RELEASE=1", template)
    assert n == 1
    filled, n = re.subn(r"(?m)^BUNDLE_BYTES=0$", "BUNDLE_BYTES=%d" % len(raw), filled)
    assert n == 1
    filled, n = re.subn(r"(?m)^BUNDLE_SHA256=UNBOUND$", "BUNDLE_SHA256=" + hashlib.sha256(raw).hexdigest(), filled)
    assert n == 1
    script = filled.rstrip("\n") + "\n" + base64.b64encode(raw).decode() + "\n"
    assert len(script.encode()) <= 96 * 1024**2
    out = P(a.out)
    out.write_text(script)
    digest = hashlib.sha256(script.encode()).hexdigest()
    out.with_name(out.name + ".sha256").write_text("%s  %s\n" % (digest, out.name))
    print(json.dumps({"kit": out.name, "bytes": len(script.encode()), "sha256": digest,
                      "bundle_bytes": len(raw), "bundle_sha256": hashlib.sha256(raw).hexdigest(),
                      "files": [p.name for p in files]}))


if __name__ == "__main__":
    main()
