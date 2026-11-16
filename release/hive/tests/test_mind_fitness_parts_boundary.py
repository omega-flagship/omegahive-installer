"""Correction 1 (Review B1 on 03f0bb8): revision staging stays inside the mind's own memory folder.

hive-revision-part is client-allowed because it never leaves the mind. At 03f0bb8 it followed links: a symlinked
revision_parts/<artifact> directory let part 1 write (and reset) outside the memory root. Every staged read, write,
listing, reset and cleanup is now reached hop by hop from the memory root with O_NOFOLLOW, and only plain,
single-link <n>.txt files are ever unlinked. Synthetic, disposable files only."""
import importlib.util
import json
import os
import pathlib

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("hive_commons_boundary", ROOT / "modules" / "hive" / "src" / "hive_commons.py")
hc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hc)


@pytest.fixture
def area(tmp_path, monkeypatch):
    memory, outside = tmp_path / "memory", tmp_path / "outside"
    memory.mkdir()
    outside.mkdir()
    monkeypatch.setenv("OMEGACLAW_MEMORY_DIR", str(memory))
    return memory, outside


def _no_post(monkeypatch):
    monkeypatch.setattr(hc, "_call", lambda *a, **k: pytest.fail("nothing may reach the hive from an unsafe staging area"))


def test_review_probe_a_linked_artifact_directory_is_refused_and_nothing_is_written_outside(area):
    """Review's review_parts_boundary.py, as a regression test."""
    memory, outside = area
    (memory / "revision_parts").mkdir()
    (memory / "revision_parts" / "ar_test").symlink_to(outside, target_is_directory=True)
    reply = hc.revision_part("ar_test", 1, "synthetic outside write")
    assert reply.startswith("HIVE-ERROR unsafe_staging:"), reply
    assert not (outside / "1.txt").exists()


def test_a_linked_revision_parts_root_is_refused(area):
    memory, outside = area
    (memory / "revision_parts").symlink_to(outside, target_is_directory=True)
    assert hc.revision_part("ar_x", 1, "x").startswith("HIVE-ERROR unsafe_staging:")
    assert list(outside.iterdir()) == []


def test_part_one_reset_through_a_link_preserves_outside_files(area):
    memory, outside = area
    for n in (1, 2, 3):
        (outside / f"{n}.txt").write_text(f"outside {n}")
    (memory / "revision_parts").mkdir()
    (memory / "revision_parts" / "ar_r").symlink_to(outside, target_is_directory=True)
    assert hc.revision_part("ar_r", 1, "reset").startswith("HIVE-ERROR unsafe_staging:")
    assert sorted(p.read_text() for p in outside.iterdir()) == ["outside 1", "outside 2", "outside 3"]


@pytest.mark.parametrize("link", ["symlink", "hardlink"])
def test_a_linked_numbered_file_is_never_written_read_or_removed(area, monkeypatch, link):
    memory, outside = area
    secret = outside / "secret.txt"
    secret.write_text("outside content")
    hc.revision_part("ar_f", 1, "one")
    staged = memory / "revision_parts" / "ar_f" / "2.txt"
    staged.symlink_to(secret) if link == "symlink" else os.link(secret, staged)
    assert hc.revision_part("ar_f", 2, "overwrite").startswith("HIVE-ERROR unsafe_staging:")      # write
    _no_post(monkeypatch)
    assert hc.revision("ar_f", json.dumps({"parent": 1, "body_parts": 2})).startswith("HIVE-ERROR unsafe_staging:")  # read
    assert hc.revision_part("ar_f", 1, "reset").startswith("HIVE-ERROR unsafe_staging:")          # reset
    assert secret.read_text() == "outside content"
    assert staged.is_symlink() or staged.exists()                                    # the link itself was not removed either
    assert (memory / "revision_parts" / "ar_f" / "1.txt").read_text() == "one"   # refused as a whole: nothing removed


def test_traversal_in_the_joined_revision_path_is_refused(area, monkeypatch):
    memory, outside = area
    (outside / "1.txt").write_text("outside")
    _no_post(monkeypatch)
    for art in ("../outside", "..", "a/b", "ar x", "/etc"):
        out = hc.revision(art, json.dumps({"parent": 1, "body_parts": 1}))
        assert out.startswith("HIVE-ERROR bad_request: the artifact is an id"), (art, out)
    assert (outside / "1.txt").read_text() == "outside"


def test_a_link_swapped_in_after_the_check_is_refused_at_the_open(area, monkeypatch):
    """The lstat check is not the only guard: the open itself refuses a link (O_NOFOLLOW) and re-checks the inode."""
    memory, outside = area
    parts = memory / "revision_parts"
    parts.mkdir()
    (parts / "ar_s").symlink_to(outside, target_is_directory=True)
    real_stat = os.stat

    def lying_stat(path, *a, **k):   # as if the entry were a plain directory when it was checked
        return real_stat(outside) if path == "ar_s" else real_stat(path, *a, **k)
    monkeypatch.setattr(hc.os, "stat", lying_stat)
    fd = os.open(parts, os.O_RDONLY | os.O_DIRECTORY)
    try:
        with pytest.raises(hc._Unsafe):
            hc._open_dir(fd, "ar_s", False, str(memory.resolve()))
    finally:
        os.close(fd)


def test_cleanup_after_posting_removes_only_plain_part_files(area, monkeypatch):
    memory, outside = area
    hc.revision_part("ar_c", 1, "a")
    hc.revision_part("ar_c", 2, "b")
    notes = memory / "revision_parts" / "ar_c" / "notes.md"
    notes.write_text("kept")
    sent = []
    monkeypatch.setattr(hc, "_call", lambda m, p, payload=None: (sent.append(payload) or
                                                                {"n": 2, "digest": "sha256:x", "changed_steps": [], "affected_steps": []}, None))
    assert hc.revision("ar_c", json.dumps({"parent": 1, "body_parts": 2})).startswith("HIVE-REVISION ar_c r2")
    assert sent[0]["body"] == "ab"
    assert sorted(p.name for p in (memory / "revision_parts" / "ar_c").iterdir()) == ["notes.md"]   # not recursive


def test_a_memory_root_reached_through_a_link_still_works(tmp_path, monkeypatch):
    real = tmp_path / "real-memory"
    real.mkdir()
    (tmp_path / "memory-link").symlink_to(real, target_is_directory=True)
    monkeypatch.setenv("OMEGACLAW_MEMORY_DIR", str(tmp_path / "memory-link"))   # the configured root itself may be a link
    assert hc.revision_part("ar_ok", 1, "fine").startswith("HIVE-REVISION-PART ar_ok part 1")
    assert (real / "revision_parts" / "ar_ok" / "1.txt").read_text() == "fine"


# ---- Correction 2 (Review on d23fce3): a link made after the check never receives new bytes ----------------------

def test_review_link_after_check_probe_the_outside_inode_keeps_its_bytes(area, monkeypatch):
    """Review's link-after-check.json interleaving: stage part 2, then make an outside hard link to 2.txt after every
    check and immediately before the new bytes go in (at d23fce3 that point was ftruncate; now it is the install)."""
    memory, outside = area
    assert hc.revision_part("ar_race", 2, "original").startswith("HIVE-REVISION-PART")
    staged, mirror = memory / "revision_parts" / "ar_race" / "2.txt", outside / "mirror.txt"
    real_rename, real_ftruncate = os.rename, os.ftruncate

    def link_then(fn):
        def wrapped(*a, **k):
            if not mirror.exists():
                os.link(staged, mirror)
            return fn(*a, **k)
        return wrapped
    monkeypatch.setattr(hc.os, "rename", link_then(real_rename))
    monkeypatch.setattr(hc.os, "ftruncate", link_then(real_ftruncate))
    reply = hc.revision_part("ar_race", 2, "replacement")
    assert mirror.read_text() == "original"            # the outside inode is unchanged
    assert staged.read_text() == "replacement" and os.stat(staged).st_nlink == 1 and reply.startswith("HIVE-REVISION-PART")


def test_an_existing_part_inode_is_never_opened_for_writing(area, monkeypatch):
    hc.revision_part("ar_w", 1, "one")
    real_open = os.open
    opened = []

    def watch(path, flags, *a, **k):
        if flags & (os.O_WRONLY | os.O_RDWR):
            opened.append(path)
            assert flags & os.O_EXCL and flags & os.O_CREAT and flags & os.O_NOFOLLOW, (path, flags)
        return real_open(path, flags, *a, **k)
    monkeypatch.setattr(hc.os, "open", watch)
    monkeypatch.setattr(hc.os, "ftruncate", lambda *a: pytest.fail("no truncate of an existing file"))
    assert hc.revision_part("ar_w", 1, "two").startswith("HIVE-REVISION-PART")
    assert opened and all(str(p).startswith(".part-1-") for p in opened)
    assert [p.name for p in (area[0] / "revision_parts" / "ar_w").iterdir()] == ["1.txt"]   # no temp left behind


def test_a_failed_install_leaves_no_temp_and_the_old_part(area, monkeypatch):
    hc.revision_part("ar_t", 1, "kept")
    monkeypatch.setattr(hc.os, "rename", lambda *a, **k: (_ for _ in ()).throw(OSError(5, "synthetic failure")))
    assert hc.revision_part("ar_t", 2, "x").startswith("HIVE-ERROR unsafe_staging:")
    assert [p.name for p in (area[0] / "revision_parts" / "ar_t").iterdir()] == ["1.txt"]


def test_a_late_detection_says_what_was_already_done(area, monkeypatch):
    memory, outside = area
    hc.revision_part("ar_l", 1, "a")
    hc.revision_part("ar_l", 2, "b")
    real_rename = os.rename

    def install_then_link(*a, **k):   # after the install, someone links the new part outside
        real_rename(*a, **k)
        os.link(memory / "revision_parts" / "ar_l" / "1.txt", outside / "late.txt")
    monkeypatch.setattr(hc.os, "rename", install_then_link)
    reply = hc.revision_part("ar_l", 1, "fresh")
    assert "Nothing was staged, read or removed" not in reply
    assert reply.startswith("HIVE-ERROR unsafe_staging:") and "Already done before this was found: removed part 1, removed part 2, staged part 1" in reply, reply
