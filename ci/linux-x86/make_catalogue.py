"""Build the x86_64 test catalogue and bundle for one exact release commit (CI only, never published).

Mirrors the reviewed aarch64 internal catalogue shape (studio-linux-user-release/2): the same apps, UI, bootstrap,
SWI and PeTTa pins, with the x86_64 Python/uv pins and the source inventory recomputed from the exact source tarball.
Every input is checked against a pin; nothing is downloaded here.
"""
import argparse
import hashlib
import io
import json
import pathlib
import shutil
import tarfile

P = pathlib.Path


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def pin(path, name):
    return {"path": name, "bytes": P(path).stat().st_size, "sha256": sha(path)}


def inventory(tar_path, prefix):
    rows = []
    with tarfile.open(tar_path, "r:gz") as t:
        for m in t:
            if not m.isfile():
                continue
            assert m.name.startswith(prefix + "/"), m.name
            data = t.extractfile(m).read()
            rows.append({"path": m.name[len(prefix) + 1:], "bytes": len(data),
                         "sha256": hashlib.sha256(data).hexdigest(),
                         "mode": "100755" if m.mode & 0o111 else "100644"})
    return sorted(rows, key=lambda r: r["path"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-catalogue", required=True)   # the reviewed aarch64 catalogue (shape + shared pins)
    ap.add_argument("--pins", required=True)             # X86_64_RUNTIME_PINS json
    ap.add_argument("--source-tar", required=True)
    ap.add_argument("--prefix", required=True)
    ap.add_argument("--commit", required=True)
    ap.add_argument("--tree", required=True)
    ap.add_argument("--inputs", required=True)           # folder holding locks, apps, ui, bootstrap files
    ap.add_argument("--bundle", required=True)           # output bundle folder
    ap.add_argument("--release-id", required=True)
    a = ap.parse_args()

    base = json.loads(P(a.base_catalogue).read_text())
    pins = json.loads(P(a.pins).read_text())
    arm = base["platforms"]["aarch64"]
    bundle = P(a.bundle)
    bundle.mkdir(mode=0o700, parents=True, exist_ok=False)
    inputs = P(a.inputs)

    def stage(src_name, expected=None):
        src = inputs / src_name
        dst = bundle / (expected["path"] if expected else src_name)
        shutil.copyfile(src, dst)
        dst.chmod(0o600)
        got = pin(dst, dst.name)
        if expected:
            assert (got["bytes"], got["sha256"]) == (expected["bytes"], expected["sha256"]), (src_name, got, expected)
        return got

    files = inventory(a.source_tar, a.prefix)
    shutil.copyfile(a.source_tar, bundle / "source.tar.gz")
    (bundle / "source.tar.gz").chmod(0o600)
    source = pin(bundle / "source.tar.gz", "source.tar.gz")
    source.update(files=files, prefix=a.prefix)

    # The reviewed core lock is universal (hashes for every platform's wheels), so x86_64 uses the same exact bytes.
    core = stage(arm["core_lock"]["path"], arm["core_lock"])
    build = stage("build.lock", arm["build_lock"])

    x86 = {
        "uv": {k: pins["uv"][k] for k in ("url", "bytes", "sha256")},
        "python": {k: pins["python_stripped"][k] for k in ("url", "bytes", "sha256")},
        "swipl_source": arm["swipl_source"],
        "petta_source": arm["petta_source"],
        "source_payload": source,
        "core_lock": core,
        "build_lock": build,
    }
    for app in base["apps"]:
        stage(app["path"], app)
    for key in ("archive", "manifest"):
        stage(base["ui_prebuilt"][key]["path"], base["ui_prebuilt"][key])
    boot = dict(base["bootstrap"])
    stage(boot["seed"]["path"], boot["seed"])
    # The owner-route helper is the release's own deploy/linux/bootstrap.py (it pins this release's control.py).
    helper = stage("bootstrap.py")
    assert helper["sha256"] == {r["path"]: r for r in files}["deploy/linux/bootstrap.py"]["sha256"], "bootstrap.py is not the release's"
    boot["helper"] = helper

    by_path = {r["path"]: r for r in files}
    modules = [by_path[r["path"]] for r in base["module_files"] if r["path"] in by_path]
    extra = [r for r in files if r["path"].startswith("deploy/linux/") and r["path"] not in {m["path"] for m in modules}]
    modules = sorted(modules + extra, key=lambda r: r["path"])

    out = dict(base)
    out.update(release_id=a.release_id, source_revision=a.commit, source_tree=a.tree,
               platforms={"x86_64": x86, "aarch64": dict(arm, source_payload=source, core_lock=core, build_lock=build)},
               module_files=modules, bootstrap=boot)
    shutil.copyfile(inputs / "install.py", bundle / "install.py")   # the release's own deploy/linux/install.py
    assert sha(bundle / "install.py") == by_path["deploy/linux/install.py"]["sha256"], "install.py is not the release's"
    (bundle / "install.py").chmod(0o600)
    (bundle / "release-manifest.json").write_text(json.dumps(out, indent=2, sort_keys=True) + "\n")
    (bundle / "release-manifest.json").chmod(0o600)
    print(json.dumps({"files": len(files), "modules": len(modules), "source": {k: source[k] for k in ("bytes", "sha256")}}))


if __name__ == "__main__":
    main()
