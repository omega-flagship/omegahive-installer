"""New-hive source custody, portable: the installed-source manifest collector, the descriptor-confined reads and
the pinned extractor adapter (plan r1.1 §3; R1a, R1a.1 P1-3, R1a.2 ancestor race). No PeTTa, no hive process, no
network: these run on any POSIX host with the descriptor primitives (macOS, Linux, WSL) so the MacBook or a Linux box
can qualify them. Where the platform lacks them, newhive refuses (unsupported_platform) and so do these tests.

The extractor packet path can be overridden with NEWHIVE_J1_EXTRACTOR_PACKET (the r1.3 archive; its sha256 is pinned
here, so a different file fails rather than silently qualifying). Scratch folders live under the system temp folder,
always addressed by their real path."""

import io
import json
import os
import pathlib
import platform
import shutil
import tarfile
import tempfile

import pytest

from hive.core import newhive

PLATFORM = f"{platform.system()} {platform.release()} {platform.machine()}"

SHA_A, SHA_B = "a" * 40, "b" * 40
STAMP = "2026-10-17T00:00:00Z"   # Code R1a binding: an explicit UTC release timestamp, passed verbatim
SECRET = "sk-NEWHIVE-SENTINEL-do-not-leak"
# The J1 extractor packet is supplied explicitly (NEWHIVE_J1_EXTRACTOR_PACKET); without it these tests skip.
PACKET = pathlib.Path(os.environ.get("NEWHIVE_J1_EXTRACTOR_PACKET") or "/nonexistent")
PACKET_SHA256 = "b7337f6976c94319c5314bb8944c0ae006805e2d4a581433b657ac4417494af1"   # r1.3 J1 package, SHIP x2
PINNED = {"__init__.py": "360ec865d9031ed8f5a9bd3d06ae168e784932ff419284213fc7d503e22aff76",
          "repository_facts.py": "edd9465e942d2f737eb2467170864c8c5fb30e66d137523ccb309088cb351f50",
          "repository_map.py": "d2e3645f71ba304ae6ab1d70e6dfc3b8a42c22a6eee4a45da5137ca3c0d69c45"}
RT = getattr(newhive, "runtime_identity", lambda: "")()   # (getattr: the fail-before run at aec15e91 collects)
SOURCE = {"hive/__init__.py": b"", "hive/core/__init__.py": b"",
          "hive/core/alpha.py": b"from . import beta\n\ndef run():\n    return beta.go()\n",
          "hive/core/beta.py": b"def go():\n    return 1\n", "README.md": b"# omegahive\n"}


def real(path):
    return pathlib.Path(os.path.realpath(path))


@pytest.fixture()
def work():
    root = real(tempfile.mkdtemp(prefix="nh-", dir="/tmp" if os.path.isdir("/tmp") else None))
    yield root
    shutil.rmtree(root, ignore_errors=True)


def extractor_dir(root):
    """The three package files taken from the pinned r1.3 archive itself (archive sha256 checked first)."""
    if not PACKET.exists():
        pytest.skip("pinned extractor packet not present")
    raw = PACKET.read_bytes()
    assert newhive._sha(raw) == PACKET_SHA256
    pkg = root / "extractor"
    pkg.mkdir()
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as tar:
        members = {pathlib.PurePosixPath(m.name).name: m for m in tar.getmembers()
                   if m.isfile() and pathlib.PurePosixPath(m.name).parent.name == "omegacode_extractor"}
        for name, digest in PINNED.items():
            data = tar.extractfile(members[name]).read()
            assert newhive._sha(data) == digest
            (pkg / name).write_bytes(data)
    return pkg


def write_release(root, sha=SHA_A, files=None, stamp=STAMP, name="release", extra_manifest=None):
    files = dict(SOURCE if files is None else files)
    src = root / name / "src"
    src.mkdir(parents=True)
    for path, body in files.items():
        target = src / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
    manifest = {"schema": newhive.MANIFEST_SCHEMA, "repo": "omegahive", "sha": sha, "generated_at": stamp,
                "files": [{"path": p, "size": len(b), "sha256": newhive._sha(b)} for p, b in sorted(files.items())],
                "extractor": {"files": dict(PINNED)}}
    manifest.update(extra_manifest or {})
    mpath = root / name / "manifest.json"
    mpath.write_bytes(newhive._canon_bytes(manifest))   # Code's production recipe: canonical UTF-8 JSON, no newline
    return src, mpath


# ---- the installed-source manifest collector ------------------------------------------------------------------------

def test_collector_reads_only_listed_files_exactly(work):
    src, mpath = write_release(work)
    (src / ".env").write_text(f"OPENROUTER_API_KEY={SECRET}\n")   # unlisted, not importable: never read
    (src / "notes.txt").write_text(SECRET)
    manifest = newhive.parse_manifest(newhive.read_manifest(mpath))
    got = newhive.collect_sources(str(src), manifest)
    assert sorted(got.files) == sorted(SOURCE) and got.files["hive/core/beta.py"] == SOURCE["hive/core/beta.py"]
    assert got.diagnostics["unlisted_files_not_read"] == 2
    assert all(SECRET.encode() not in b for b in got.files.values())


@pytest.mark.parametrize("damage,code", [
    ("missing", "missing"), ("dirty", "dirty"), ("dirty_size", "dirty"), ("shadow_py", "shadow"),
    ("shadow_pyc", "shadow"), ("shadow_pth", "shadow"), ("shadow_package", "shadow"), ("link_file", "symlink"),
    ("link_dir", "symlink"), ("link_outside", "symlink"), ("fifo", "unsupported_file")])
def test_collector_refuses_damaged_source(work, damage, code):
    src, mpath = write_release(work)
    beta = src / "hive/core/beta.py"
    outside = work / "outside.py"
    outside.write_text("print('outside')\n")
    if damage == "missing":
        beta.unlink()
    elif damage == "dirty":
        beta.write_bytes(b"def go():\n    return 2\n")
    elif damage == "dirty_size":
        beta.write_bytes(SOURCE["hive/core/beta.py"] + b"#")
    elif damage == "shadow_py":
        (src / "hive/core/gamma.py").write_text("x = 1\n")
    elif damage == "shadow_pyc":
        (src / "hive/core/beta.pyc").write_bytes(b"\x00")
    elif damage == "shadow_pth":
        (src / "evil.pth").write_text("import os\n")
    elif damage == "shadow_package":
        (src / "hive/core/beta").mkdir()
        (src / "hive/core/beta/__init__.py").write_text("")
    elif damage == "link_file":
        beta.unlink()
        beta.symlink_to(outside)
    elif damage == "link_dir":
        (src / "linked").symlink_to(work)
    elif damage == "link_outside":
        (src / "hive/data").symlink_to("/etc")
    elif damage == "fifo":
        os.mkfifo(src / "pipe")
    manifest = newhive.parse_manifest(newhive.read_manifest(mpath))
    with pytest.raises(newhive.SourceRefused) as exc:
        newhive.collect_sources(str(src), manifest)
    assert exc.value.code == code
    assert outside.exists() and (src / "hive/core/alpha.py").exists()   # a refusal never deletes or repairs anything


@pytest.mark.parametrize("path", ["../escape.py", "/abs.py", "a/./b.py", "a//b.py", "a/../b.py", ".env", "conf/.env.local",
                                  "keys/server.pem", ".git/config", "data/hive.db", "x/__pycache__/m.pyc", "a\\b.py",
                                  "sp ace.py", "a/", ""])
def test_manifest_refuses_escapes_and_non_code_paths(work, path):
    _, mpath = write_release(work)
    data = json.loads(mpath.read_bytes())
    data["files"].append({"path": path, "size": 1, "sha256": "0" * 64})
    with pytest.raises(newhive.SourceRefused) as exc:
        newhive.parse_manifest(json.dumps(data).encode())
    assert exc.value.code == "unsupported_path"


def test_manifest_refuses_oversize_census(work, monkeypatch):
    _, mpath = write_release(work)
    raw = newhive.read_manifest(mpath)
    monkeypatch.setattr(newhive, "MAX_TOTAL", 20)
    with pytest.raises(newhive.SourceRefused) as exc:
        newhive.parse_manifest(raw)
    assert exc.value.code == "oversize"
    monkeypatch.setattr(newhive, "MAX_TOTAL", 96 * 1024 * 1024)
    monkeypatch.setattr(newhive, "MAX_FILES", 2)
    with pytest.raises(newhive.SourceRefused) as exc:
        newhive.parse_manifest(raw)
    assert exc.value.code == "oversize"


def test_manifest_refuses_short_sha_and_wrong_repo(work):
    _, mpath = write_release(work)
    for change in ({"sha": "abc1234"}, {"repo": "other"}, {"sha": "A" * 40}, {"extra": 1}):
        data = dict(json.loads(mpath.read_bytes()), **change)
        with pytest.raises(newhive.SourceRefused):
            newhive.parse_manifest(json.dumps(data).encode())


def test_source_root_must_be_its_real_path(work):
    src, mpath = write_release(work)
    manifest = newhive.parse_manifest(newhive.read_manifest(mpath))
    (work / "via").symlink_to(src)
    for root in (str(work / "via"), str(src) + "/", "relative/src", str(src / ".." / "src")):
        with pytest.raises(newhive.SourceRefused) as exc:
            newhive.collect_sources(root, manifest)
        assert exc.value.code in ("source_root", "symlink")


# ---- the pinned extractor adapter and finalisation -----------------------------------------------------------------

def test_pinned_extractor_runs_verified_bytes_and_refuses_wrong_pins(work):
    pkg = extractor_dir(work)
    pins = dict(PINNED)
    adapter = newhive.load_pinned_extractor(pkg, pins)
    assert callable(adapter._build)
    bad = dict(pins, **{"repository_map.py": "0" * 64})
    with pytest.raises(newhive.SourceRefused) as exc:
        newhive.load_pinned_extractor(pkg, bad)
    assert exc.value.code == "dirty"
    (pkg / "repository_impact.py").write_text("x = 1\n")   # an extra file beside the pinned three
    with pytest.raises(newhive.SourceRefused) as exc:
        newhive.load_pinned_extractor(pkg, pins)
    assert exc.value.code == "extractor_unavailable"


def test_prepare_addresses_the_receipt_then_freezes_the_envelope(work):
    pkg = extractor_dir(work)
    src, mpath = write_release(work)
    manifest = newhive.parse_manifest(newhive.read_manifest(mpath))
    adapter = newhive.load_pinned_extractor(pkg, manifest.extractor["files"])
    sources = newhive.collect_sources(str(src), manifest)
    one, two = newhive.prepare_map(sources, adapter), newhive.prepare_map(sources, adapter)
    assert one == two   # deterministic: generated_at is the release's recorded input, never "now"
    envelope, receipt = json.loads(one.envelope_bytes), json.loads(one.receipt_bytes)
    assert envelope["receipt"]["artifact_ref"] == newhive.asset_ref(one.receipt_sha256)
    assert newhive.PENDING_REF.encode() not in one.envelope_bytes   # the temporary reference is never loaded
    assert envelope["generated_at"] == STAMP and envelope["state"] == "partial"   # honest: README is not extracted
    newhive.verify_pair(envelope, receipt, sources)
    tampered = dict(receipt, facts=[])
    with pytest.raises(newhive.SourceRefused) as exc:
        newhive.verify_pair(envelope, tampered, sources)
    assert exc.value.code == "receipt_mismatch"

    def lying(sources, *, repo, sha, artifact_ref, generated_at):   # a stub that drops a file from the census
        env, rec = adapter.build(sources, repo=repo, sha=sha, artifact_ref=artifact_ref, generated_at=generated_at)
        rec["census"] = rec["census"][1:]
        return env, rec
    with pytest.raises(newhive.SourceRefused) as exc:
        newhive.prepare_map(sources, newhive.ExtractorAdapter(lying))
    assert exc.value.code == "receipt_mismatch"

    def failing(sources, **kw):
        raise ValueError("boom")
    with pytest.raises(newhive.SourceRefused) as exc:
        newhive.prepare_map(sources, newhive.ExtractorAdapter(failing))
    assert exc.value.code == "extraction_failed"


# ---- R1a.1: reads are confined by descriptors (stand-in P1-3, Code conformance 3): real race fixtures ---------------

def _outside_copy(work, src):
    outside = work / "outside"
    shutil.copytree(src, outside)   # byte-identical sentinel tree: a digest check alone cannot tell them apart
    return outside


def _track_fstat(monkeypatch):
    seen = []
    real = os.fstat

    def fstat(fd):
        st = real(fd)
        seen.append((st.st_dev, st.st_ino))
        return st
    monkeypatch.setattr(os, "fstat", fstat)
    return seen


def test_race_parent_swapped_for_a_link_at_the_open_is_never_followed(work, monkeypatch):
    src, mpath = write_release(work)
    outside = _outside_copy(work, src)
    manifest = newhive.parse_manifest(newhive.read_manifest(mpath))
    outside_ino = {(os.stat(p).st_dev, os.stat(p).st_ino) for p in outside.rglob("*") if p.is_file()}
    real_open, swapped = os.open, []

    def racing_open(path, flags, mode=0o777, *, dir_fd=None):
        if str(path).endswith("beta.py") and not swapped:   # the old lstat -> open boundary for hive/core/beta.py
            os.rename(src / "hive/core", src / "hive/core.real")
            os.symlink(outside / "hive/core", src / "hive/core")
            swapped.append(True)
        return real_open(path, flags, mode, dir_fd=dir_fd) if dir_fd is not None else real_open(path, flags, mode)
    seen = _track_fstat(monkeypatch)
    monkeypatch.setattr(os, "open", racing_open)
    try:
        got = newhive.collect_sources(str(src), manifest)
    except newhive.SourceRefused as exc:
        got = exc
    monkeypatch.undo()
    assert swapped
    assert not (set(seen) & outside_ino), "a file outside the source root was opened and read"
    if not isinstance(got, newhive.SourceRefused):
        assert got.files["hive/core/beta.py"] == SOURCE["hive/core/beta.py"]   # read from the root's own folder


def _race_hooks(monkeypatch, root, component, swap):
    """Swap at the acquisition boundary of either implementation: before the second pathname lstat of the root
    (R1a.1's _real_root -> lstat -> full-path open window), or before the descriptor open of `component` (R1a.2's
    openat walk). Returns the list that records that the swap happened."""
    real_lstat, real_open, state = os.lstat, os.open, {"lstats": 0, "done": []}

    def lstat(path, *a, **kw):
        if str(path) == str(root) and not state["done"]:
            state["lstats"] += 1
            if state["lstats"] == 2:
                swap()
                state["done"].append("lstat")
        return real_lstat(path, *a, **kw)

    def racing_open(path, flags, mode=0o777, *, dir_fd=None):
        if dir_fd is not None and str(path) == component and not state["done"]:
            swap()
            state["done"].append("openat")
        return real_open(path, flags, mode, dir_fd=dir_fd) if dir_fd is not None else real_open(path, flags, mode)
    monkeypatch.setattr(os, "lstat", lstat)
    monkeypatch.setattr(os, "open", racing_open)
    return state["done"]


def _inodes(tree):
    return {(os.stat(p).st_dev, os.stat(p).st_ino) for p in pathlib.Path(tree).rglob("*") if p.is_file()}


def _collect_or_refuse(src, manifest):
    try:
        return newhive.collect_sources(str(src), manifest)
    except newhive.SourceRefused as exc:
        return exc


def test_race_root_swapped_for_a_link_after_its_check_never_reads_outside(work, monkeypatch):
    src, mpath = write_release(work)
    outside = _outside_copy(work, src)
    manifest = newhive.parse_manifest(newhive.read_manifest(mpath))
    outside_ino = _inodes(outside)

    def swap():   # the final component: src itself
        os.rename(src, work / "release" / "src.real")
        os.symlink(outside, src)
    done = _race_hooks(monkeypatch, src, "src", swap)
    seen = _track_fstat(monkeypatch)
    got = _collect_or_refuse(src, manifest)
    monkeypatch.undo()
    assert done and not (set(seen) & outside_ino), "a file outside the source root was opened and read"
    assert isinstance(got, newhive.SourceRefused) and got.code in ("symlink", "source_root")


def test_race_ancestor_swapped_for_a_link_never_reads_outside(work, monkeypatch):
    """Stand-in R1a.1 P1: an ANCESTOR of the root (work/release) is replaced by a link to a byte-identical outside
    tree after the root's checks; every later pathname would resolve outside and an inode comparison would agree."""
    src, mpath = write_release(work)
    outside_release = work / "outside-release"
    shutil.copytree(work / "release", outside_release)
    manifest = newhive.parse_manifest(newhive.read_manifest(mpath))
    outside_ino = _inodes(outside_release)

    def swap():
        os.rename(work / "release", work / "release.real")
        os.symlink(outside_release, work / "release")
    done = _race_hooks(monkeypatch, src, "release", swap)
    seen = _track_fstat(monkeypatch)
    got = _collect_or_refuse(src, manifest)
    monkeypatch.undo()
    assert done and not (set(seen) & outside_ino), "a file outside the source root was opened and read"
    assert isinstance(got, newhive.SourceRefused) and got.code == "symlink"


def test_race_extractor_ancestor_swapped_never_loads_outside_bytes(work, monkeypatch):
    holder = work / "deps"
    holder.mkdir()
    pkg = extractor_dir(holder)                       # work/deps/extractor
    outside = work / "outside-deps"
    shutil.copytree(holder, outside)                  # byte-identical: the pins match either copy
    outside_ino = _inodes(outside)

    def swap():
        os.rename(holder, work / "deps.real")
        os.symlink(outside, holder)
    done = _race_hooks(monkeypatch, pkg, "deps", swap)
    seen = _track_fstat(monkeypatch)
    try:
        got = newhive.load_pinned_extractor(pkg, dict(PINNED))
    except newhive.SourceRefused as exc:
        got = exc
    monkeypatch.undo()
    assert done and not (set(seen) & outside_ino), "extractor bytes were read from outside the package folder"
    assert isinstance(got, newhive.SourceRefused) and got.code == "symlink"


def test_manifest_behind_an_ancestor_link_is_refused(work, monkeypatch):
    src, mpath = write_release(work)
    outside_release = work / "outside-release"
    shutil.copytree(work / "release", outside_release)
    via = work / "via"
    os.symlink(outside_release, via)                  # same bytes, reached only through a link
    outside_ino = _inodes(outside_release)
    seen = _track_fstat(monkeypatch)
    try:
        got = newhive.read_manifest(str(via / "manifest.json"))
    except newhive.SourceRefused as exc:
        got = exc
    monkeypatch.undo()
    assert not (set(seen) & outside_ino) and isinstance(got, newhive.SourceRefused) and got.code == "symlink"


def test_collector_fails_closed_without_descriptor_primitives(work, monkeypatch):
    src, mpath = write_release(work)
    manifest = newhive.parse_manifest(newhive.read_manifest(mpath))
    monkeypatch.setattr(newhive, "_descriptor_support", lambda: False)
    with pytest.raises(newhive.SourceRefused) as exc:
        newhive.collect_sources(str(src), manifest)
    assert exc.value.code == "unsupported_platform"



def test_descriptor_primitives_are_present_on_this_platform():
    """Records what was qualified: on macOS/Linux/WSL the primitives exist; elsewhere newhive refuses (tested above)."""
    assert newhive._descriptor_support(), f"no descriptor confinement on {PLATFORM}"


@pytest.mark.parametrize("path", ["", "rel", "rel/x", "/a//b", "/a/./b", "/a/../b", "/a/", "/a/.", "/a/.."])
def test_one_canonical_path_rule(path):
    """Kimi R1a.2 P3-4: one canonical-path rule for every anchored open (root, extractor folder, manifest folder)."""
    with pytest.raises(newhive.SourceRefused) as exc:
        newhive.canonical_abs(path)
    assert exc.value.code == "source_root"
    with pytest.raises(newhive.SourceRefused):
        newhive._anchored_dir(path)


def test_eloop_is_always_a_link(work, monkeypatch):
    """Kimi R1a.2 P3-2: ELOOP from openat(O_NOFOLLOW) is classified as a link without a second look (Linux's answer)."""
    import errno as errno_mod
    (work / "d").mkdir()
    real_open = os.open

    def eloop(path, flags, mode=0o777, *, dir_fd=None):
        if dir_fd is not None and path == "d":
            raise OSError(errno_mod.ELOOP, "Too many levels of symbolic links")
        return real_open(path, flags, mode, dir_fd=dir_fd) if dir_fd is not None else real_open(path, flags, mode)
    monkeypatch.setattr(os, "open", eloop)
    with pytest.raises(newhive.SourceRefused) as exc:
        newhive._anchored_dir(str(work / "d"))
    assert exc.value.code == "symlink"
