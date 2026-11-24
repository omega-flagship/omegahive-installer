"""Purpose: test the installer's carry of the connector files an earlier release kept in its code folder
(hive/core/connector_files.py): each LEGACY path goes to the same place in the data folder's connectors folder, else
into the new code folder, by rename or across file systems; a path both places hold stays and fails the carry; a path
a link reaches is only reported; nothing is written through a link; and the file runs as the installer runs it, on a
bare Python with no site packages."""
import errno
import os
import pathlib
import subprocess
import sys

from hive.core import connector_files

# One file for each kind of LEGACY path: memory/, a module's memory/, the root memory/ variant of a module's file, the
# agentverse seed, and a pairing folder beside each bridge.
OLD = {
    "memory/home_assistant.json": '{"url": "http://homeassistant.local:8123", "token": "ha-old"}',
    "modules/health_glucose/memory/librelinkup.json": '{"email": "ana@example.test", "password": "llu-pw"}',
    "memory/librelinkup_cache.json": '{"token": "llu-session"}',
    "memory/runtime/agentverse/local_seed.txt": "omega agentverse local listener oldseed\n",
    "modules/channel_whatsapp/src/whatsapp_bridge/auth/creds.json": '{"registered": true}',
    "channels/whatsapp_bridge/auth_work/creds.json": '{"registered": true, "label": "work"}',
}
CARRIED = sorted({
    "memory/home_assistant.json", "modules/health_glucose/memory/librelinkup.json", "memory/librelinkup_cache.json",
    "memory/runtime/agentverse/local_seed.txt", "modules/channel_whatsapp/src/whatsapp_bridge/auth",
    "channels/whatsapp_bridge/auth_work"})
CODE = {"hive/core/app.py": "# the old release's code\n", "memory/notes.md": "not a secret\n"}


def lay_out(base, files):
    for rel, text in files.items():
        (base / rel).parent.mkdir(parents=True, exist_ok=True)
        (base / rel).write_text(text)
    return base


def places(tmp_path):
    old = lay_out(tmp_path / "app.old", {**OLD, **CODE})
    data, new = tmp_path / "data", tmp_path / "app"
    data.mkdir()
    new.mkdir()
    return old, data, new


def test_each_legacy_path_goes_to_its_own_place_in_the_connectors_folder_and_nothing_else_moves(tmp_path):
    old, data, new = places(tmp_path)
    (old / "memory/home_assistant.json").chmod(0o600)
    lines, kept = connector_files.carry(old, data, new)
    assert kept == 0
    assert sorted(lines) == sorted(f"carried {rel} to {data / 'connectors' / rel}" for rel in CARRIED)
    for rel, text in OLD.items():
        assert (data / "connectors" / rel).read_text() == text
        assert not (old / rel).exists()
    for rel, text in CODE.items():                      # code and other files stay, to go with the old folder
        assert (old / rel).read_text() == text
    assert stat_mode(data / "connectors" / "memory/home_assistant.json") == 0o600   # a rename keeps its mode
    for folder in ("connectors", "connectors/memory", "connectors/modules/health_glucose/memory"):
        assert stat_mode(data / folder) == 0o700        # each folder the carry makes is the owner's alone
    assert list(new.iterdir()) == []
    assert connector_files.carry(old, data, new) == ([], 0)    # a second run finds nothing more


def stat_mode(path):
    return os.stat(path).st_mode & 0o777


def test_a_data_folder_that_isnt_there_yet_is_made_the_owners_alone(tmp_path):
    old, data, new = places(tmp_path)
    data.rmdir()
    lines, kept = connector_files.carry(old, data, new)
    assert kept == 0 and len(lines) == len(CARRIED)
    assert stat_mode(data) == 0o700 and stat_mode(data / "connectors") == 0o700
    assert (data / "connectors/memory/home_assistant.json").read_text() == OLD["memory/home_assistant.json"]


def test_a_path_the_connectors_folder_holds_goes_into_the_new_code_and_one_both_hold_stays(tmp_path):
    old, data, new = places(tmp_path)
    lay_out(data / "connectors", {"memory/home_assistant.json": '{"token": "imported-before"}'})
    lay_out(new, {"memory/runtime/agentverse/local_seed.txt": "the new release's own\n"})
    lay_out(data / "connectors", {"memory/runtime/agentverse/local_seed.txt": "carried before\n"})
    lines, kept = connector_files.carry(old, data, new)
    assert f"carried memory/home_assistant.json to {new / 'memory/home_assistant.json'}" in lines
    assert (new / "memory/home_assistant.json").read_text() == OLD["memory/home_assistant.json"]
    assert (data / "connectors/memory/home_assistant.json").read_text() == '{"token": "imported-before"}'
    assert kept == 1
    assert (f"kept memory/runtime/agentverse/local_seed.txt in {old}: {data / 'connectors'} and {new} hold it already"
            in lines)
    assert (old / "memory/runtime/agentverse/local_seed.txt").read_text() == OLD["memory/runtime/agentverse/local_seed.txt"]
    assert connector_files.main([str(old), str(data), str(new)]) == 1     # what stays fails the installer's step


def test_a_folder_a_link_reaches_is_reported_and_left_where_it_points(tmp_path):
    old = lay_out(tmp_path / "app.old", CODE)
    (old / "memory/notes.md").unlink()
    (old / "memory").rmdir()
    elsewhere = lay_out(tmp_path / "elsewhere", {"home_assistant.json": '{"token": "kept-elsewhere"}',
                                                  "runtime/agentverse/local_seed.txt": "seed elsewhere\n"})
    (old / "memory").symlink_to(elsewhere, target_is_directory=True)
    data, new = tmp_path / "data", tmp_path / "app"
    lines, kept = connector_files.carry(old, data, new)
    assert kept == 0
    assert sorted(lines) == sorted(
        f"left {rel}: a link in {old} reaches it, and deleting {old} keeps what it points to"
        for rel in ("memory/home_assistant.json", "memory/runtime/agentverse/local_seed.txt"))
    assert (elsewhere / "home_assistant.json").read_text() == '{"token": "kept-elsewhere"}'
    assert not data.exists() and not new.exists()


def test_nothing_is_written_through_a_link_in_the_connectors_folder(tmp_path):
    old, data, new = places(tmp_path)
    away = tmp_path / "away"
    away.mkdir()
    (data / "connectors").symlink_to(away, target_is_directory=True)
    lines, kept = connector_files.carry(old, data, new)
    assert kept == len(CARRIED)
    assert all(line.startswith("kept ") for line in lines)
    assert list(away.iterdir()) == []
    assert all((old / rel).exists() for rel in OLD)


def test_across_file_systems_a_staged_copy_is_renamed_in_before_the_original_goes(tmp_path, monkeypatch):
    old, data, new = places(tmp_path)
    rename, renamed = os.rename, []

    def across(source, target):   # a rename out of the old folder crosses a file system; one beside the target doesn't
        if str(source).startswith(str(old)):
            raise OSError(errno.EXDEV, "Invalid cross-device link")
        renamed.append(pathlib.Path(source).name)
        return rename(source, target)

    monkeypatch.setattr(connector_files.os, "rename", across)
    lines, kept = connector_files.carry(old, data, new)
    assert kept == 0
    for rel, text in OLD.items():
        assert (data / "connectors" / rel).read_text() == text
        assert not (old / rel).exists()
    assert sorted(renamed) == sorted(f".{pathlib.PurePosixPath(rel).name}{connector_files.MOVING}" for rel in CARRIED)
    assert not [p for p in (data / "connectors").rglob(f"*{connector_files.MOVING}")]


def test_the_installer_runs_it_on_a_bare_python_with_nothing_of_the_hives(tmp_path):
    old, data, new = places(tmp_path)
    script = pathlib.Path(connector_files.__file__)
    run = subprocess.run([sys.executable, "-I", "-S", str(script), str(old), str(data), str(new)],
                         capture_output=True, text=True, cwd=tmp_path)
    assert run.returncode == 0, run.stderr
    assert sorted(run.stdout.splitlines()) == sorted(f"carried {rel} to {data / 'connectors' / rel}" for rel in CARRIED)
    usage = subprocess.run([sys.executable, "-I", "-S", str(script)], capture_output=True, text=True, cwd=tmp_path)
    assert usage.returncode == 2 and usage.stderr.startswith("usage: connector_files.py")


def test_the_import_reads_the_same_table_the_installer_carries():
    from hive.core import connectors
    assert connectors.LEGACY is connector_files.LEGACY and connectors.FOLDER == connector_files.FOLDER
