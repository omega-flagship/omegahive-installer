"""Release-input tuple (self-map): one durability barrier, manifest last, caller's deadline honoured.

Synthetic git release in a temp folder and a stand-in three-file extractor (pins patched to its bytes). No hive,
no network, no real data.
"""
import hashlib
import json
import os
import pathlib
import subprocess
import tempfile

import pytest

from hive.core import releaseinputs as ri

FILES = {"hive/__init__.py": b"", "hive/core/a.py": b"A = 1\n", "hive/core/deep/b/c.py": b"def c():\n    return 2\n",
         "README.md": b"# demo\n", "data/secret.py": b"X = 1\n"}


def _git(root, *args):
    env = {"PATH": "/usr/bin:/bin", "HOME": str(root), "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
           "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
    return subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True, env=env).stdout


@pytest.fixture()
def release(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        base = pathlib.Path(os.path.realpath(tmp))
        root = base / "app"
        root.mkdir()
        for name, body in FILES.items():
            (root / name).parent.mkdir(parents=True, exist_ok=True)
            (root / name).write_bytes(body)
        _git(root, "init", "-q")
        _git(root, "add", "-A")
        _git(root, "commit", "-q", "-m", "synthetic")
        sha = _git(root, "rev-parse", "HEAD").decode().strip()
        ext = base / "ext"
        ext.mkdir()
        pins = {}
        for name in ri.EXTRACTOR:
            body = ("# stand-in %s\n" % name).encode()
            (ext / name).write_bytes(body)
            pins[name] = (len(body), hashlib.sha256(body).hexdigest())
        monkeypatch.setattr(ri, "EXTRACTOR", pins)
        yield root, sha, ext


def test_tuple_written_with_one_barrier_and_no_bulk_fsync(release, monkeypatch):
    root, sha, ext = release
    events, real_fsync = [], os.fsync

    def fsync(fd):
        events.append(("fsync", os.readlink("/proc/self/fd/%d" % fd) if os.path.exists("/proc/self/fd") else fd))
        return real_fsync(fd)

    def barrier():
        events.append(("barrier", None))
        assert not (root / ".runtime" / ("repo-inputs-" + sha) / "manifest.json").exists()

    monkeypatch.setattr(ri.os, "fsync", fsync)
    monkeypatch.setattr(ri, "_barrier", barrier)
    paths = ri.write_release_inputs(str(root), sha, str(ext))
    tuple_dir = root / ".runtime" / ("repo-inputs-" + sha)
    assert paths[ri.nh.ENV_RELEASE_MANIFEST] == str(tuple_dir / "manifest.json")
    assert (tuple_dir / "source" / "hive/core/deep/b/c.py").read_bytes() == FILES["hive/core/deep/b/c.py"]
    assert not (tuple_dir / "source" / "data").exists()           # blocked folders never exported
    kinds = [k for k, _ in events]
    assert kinds.count("barrier") == 1
    # Only the folder that receives .runtime, the manifest, the tuple folder and .runtime itself are fsynced:
    # a constant, whatever the file count.
    assert len(events) <= 5, events
    assert kinds.index("barrier") < len(kinds) - 3                 # manifest fsync comes after the barrier
    manifest = json.loads((tuple_dir / "manifest.json").read_bytes())
    assert manifest["sha"] == sha and {f["path"] for f in manifest["files"]} >= {"hive/core/a.py", "README.md"}


def test_replay_reverifies_without_rewriting(release):
    root, sha, ext = release
    first = ri.write_release_inputs(str(root), sha, str(ext))
    stamp = os.stat(first[ri.nh.ENV_RELEASE_MANIFEST]).st_mtime_ns
    assert ri.write_release_inputs(str(root), sha, str(ext)) == first
    assert os.stat(first[ri.nh.ENV_RELEASE_MANIFEST]).st_mtime_ns == stamp


def test_partial_tuple_without_manifest_is_refused(release, monkeypatch):
    root, sha, ext = release

    def crash():
        raise OSError("power cut before the manifest")

    monkeypatch.setattr(ri, "_barrier", crash)
    with pytest.raises(OSError):
        ri.write_release_inputs(str(root), sha, str(ext))
    monkeypatch.setattr(ri, "_barrier", lambda: None)
    with pytest.raises(ri.nh.SourceRefused):
        ri.write_release_inputs(str(root), sha, str(ext))


@pytest.mark.parametrize("deadline", [0, 601, "50", True])
def test_deadline_bounds(release, deadline):
    root, sha, ext = release
    with pytest.raises(ri.nh.SourceRefused):
        ri.write_release_inputs(str(root), sha, str(ext), deadline)


def test_cli_accepts_the_wrappers_deadline_flag(release, capsys):
    root, sha, ext = release
    assert ri.main([str(root), sha, "--extractor", str(ext), "--deadline", "170"]) == 0
    assert set(json.loads(capsys.readouterr().out)) == {ri.nh.ENV_RELEASE_MANIFEST, ri.nh.ENV_RELEASE_SOURCE,
                                                        ri.nh.ENV_EXTRACTOR}
    # release_inputs_env.py only passes --deadline when it finds this literal in the generator's source.
    assert '"--deadline"' in pathlib.Path(ri.__file__).read_text(encoding="utf-8")
