"""Purpose: check the installer's Studio path, the app the hive shows as Create: setup-studio.sh lays a release zip out
in apps/omegadesign only when it matches pins.sh (the hive's own source digest and the page lock's sha256), refuses
anything else without leaving a folder behind, and omegahive.sh's app_settings mounts and pins it beside the Tools app,
lets it run in the sandbox, and turns Studio's sessions on unless the owner's hive.env says otherwise.

Each test runs the real scripts against a throwaway hive folder whose app is this checkout and whose Python is this one.
"""

import hashlib
import json
import os
import pathlib
import re
import shlex
import shutil
import stat
import subprocess
import sys
import zipfile

import pytest

from hive.core.programs import Programs

ROOT = pathlib.Path(__file__).resolve().parents[2]   # hive/tests/ -> the repository's root
MACOS = ROOT / "install" / "macos"
VERSION = "9.9.9"

pytestmark = pytest.mark.skipif(shutil.which("bash") is None, reason="the installer's scripts need bash")


def bundle(tmp_path, program="def run(): return 1\n"):
    """A Studio-shaped release folder and its zip: plugin.json, one .py and the page lock. Returns (zip, digest, lock sha)."""
    src = tmp_path / "bundle-src"
    (src / "ui").mkdir(parents=True)
    (src / "plugin.json").write_text(json.dumps({"id": "omegadesign", "name": "Studio", "version": VERSION, "module": "program.py"}))
    (src / "program.py").write_text(program)
    (src / "ui" / "bundle.lock.json").write_text(json.dumps({"files": {}}))
    digest = Programs.source_digest(src)
    lock = hashlib.sha256((src / "ui" / "bundle.lock.json").read_bytes()).hexdigest()
    out = tmp_path / f"omegadesign-{VERSION}.zip"
    with zipfile.ZipFile(out, "w") as z:
        for f in sorted(src.rglob("*")):
            if f.is_file():
                z.write(f, f"omegadesign-release/{VERSION}/{f.relative_to(src)}")
    return out, digest, lock


def hive_home(tmp_path, digest, lock):
    """A finished-install look-alike: app/ is this checkout, venv/bin/python this Python, and a copy of setup-studio.sh
    beside a pins.sh that pins the test bundle."""
    oh = tmp_path / "OmegaHive"
    (oh / "venv" / "bin").mkdir(parents=True)
    os.symlink(sys.executable, oh / "venv" / "bin" / "python")
    os.symlink(ROOT, oh / "app")
    scripts = tmp_path / "macos"
    scripts.mkdir()
    shutil.copy(MACOS / "setup-studio.sh", scripts / "setup-studio.sh")
    (scripts / "pins.sh").write_text(
        f"OMEGADESIGN_VERSION={VERSION}\nOMEGADESIGN_DIGEST={digest}\nOMEGADESIGN_LOCK_SHA256={lock}\n"
        'sha256() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$@"; else sha256sum "$@"; fi; }\n')
    return oh, scripts / "setup-studio.sh"


def setup(oh, script, zip_path):
    return subprocess.run(["bash", str(script), str(zip_path)], env={**os.environ, "OMEGAHIVE_HOME": str(oh)},
                          capture_output=True, text=True)


def test_a_pinned_bundle_is_laid_out_read_only_and_kept_on_a_second_run(tmp_path):
    zip_path, digest, lock = bundle(tmp_path)
    oh, script = hive_home(tmp_path, digest, lock)
    first = setup(oh, script, zip_path)
    assert first.returncode == 0, first.stderr
    assert f"Studio is omegadesign {VERSION}" in first.stdout
    studio = oh / "apps" / "omegadesign"
    assert Programs.source_digest(studio) == digest
    assert not (studio / "program.py").stat().st_mode & stat.S_IWUSR
    assert not (oh / "apps" / "omegadesign.new").exists()
    again = setup(oh, script, zip_path)
    assert again.returncode == 0, again.stderr
    assert "already omegadesign" in again.stdout


def test_a_bundle_that_differs_from_its_pin_is_refused_and_leaves_nothing(tmp_path):
    zip_path, digest, lock = bundle(tmp_path)
    other, _, _ = bundle(tmp_path / "other", program="def run(): return 2\n")
    oh, script = hive_home(tmp_path, digest, lock)
    done = setup(oh, script, other)
    assert done.returncode == 1
    assert f"is not omegadesign {VERSION} as pinned" in done.stderr
    assert not (oh / "apps" / "omegadesign").exists()
    assert not (oh / "apps" / "omegadesign.new").exists()


def test_a_member_that_climbs_out_of_the_folder_is_refused(tmp_path):
    zip_path, digest, lock = bundle(tmp_path)
    with zipfile.ZipFile(zip_path, "a") as z:
        z.writestr(f"omegadesign-release/{VERSION}/../../escaped.txt", "out")
    oh, script = hive_home(tmp_path, digest, lock)
    done = setup(oh, script, zip_path)
    assert done.returncode != 0
    assert "would land outside the Studio folder" in done.stderr
    assert not (oh / "apps" / "escaped.txt").exists() and not (oh / "escaped.txt").exists()
    assert not (oh / "apps" / "omegadesign").exists()


def app_settings(oh, env=None):
    """omegahive.sh's app_settings, run on its own: the function's text from the script, with OH and TOOLCHAIN set."""
    text = (MACOS / "omegahive.sh").read_text()
    body = re.search(r"^app_settings\(\) \{\n.*?^PY\n\}\n", text, re.S | re.M).group(0)
    script = f"OH={shlex.quote(str(oh))}\nTOOLCHAIN={shlex.quote(str(oh / 'toolchain'))}\n{body}app_settings\n"
    run_env = {k: v for k, v in os.environ.items() if not k.startswith("HIVE_")}
    done = subprocess.run(["bash", "-c", script], env={**run_env, **(env or {})}, capture_output=True, text=True, check=True)
    exports = {}
    for line in done.stdout.splitlines():
        key, _, value = line.removeprefix("export ").partition("=")
        exports[key] = shlex.split(value)[0] if value else ""
    return exports


def pins_sh(name):
    return re.search(rf"^{name}=(\S+)$", (MACOS / "pins.sh").read_text(), re.M).group(1)


def installed_apps(tmp_path, *apps):
    oh = tmp_path / "OmegaHive"
    (oh / "venv" / "bin").mkdir(parents=True)
    os.symlink(sys.executable, oh / "venv" / "bin" / "python")
    os.symlink(ROOT, oh / "app")
    for app in apps:
        (oh / "apps" / app).mkdir(parents=True)
        (oh / "apps" / app / "plugin.json").write_text("{}")
    return oh


def test_studio_is_mounted_pinned_and_sandboxed_beside_the_tools_app_with_sessions_on(tmp_path):
    oh = installed_apps(tmp_path, "omega-tools", "omegadesign")
    out = app_settings(oh)
    studio, tools = str(oh / "apps" / "omegadesign"), str(oh / "apps" / "omega-tools")
    assert out["HIVE_PLUGIN_DIRS"].split(os.pathsep) == [tools, studio]
    pins = json.loads(out["HIVE_APP_PINS"])
    assert pins["omegadesign"] == {"release": studio, "digest": pins_sh("OMEGADESIGN_DIGEST"),
                                   "files": {"ui/bundle.lock.json": pins_sh("OMEGADESIGN_LOCK_SHA256")}}
    assert pins["omega-tools"]["digest"] == pins_sh("OMEGA_TOOLS_DIGEST")
    assert out["HIVE_SANDBOX_RUN_APPS"].split(",") == ["omega-tools", "omegadesign"]
    assert out["HIVE_STUDIO_SESSIONS"] == "on"


def test_the_owners_own_choices_are_kept_beside_studio(tmp_path):
    oh = installed_apps(tmp_path, "omegadesign")
    out = app_settings(oh, {"HIVE_STUDIO_SESSIONS": "off", "HIVE_PLUGIN_DIRS": "/srv/mine",
                            "HIVE_APP_PINS": json.dumps({"mine": {"release": "/srv/mine", "digest": "sha256:" + "0" * 64}}),
                            "HIVE_SANDBOX_RUN_APPS": "code-project-test"})
    assert "HIVE_STUDIO_SESSIONS" not in out            # the owner's off stays as hive.env has it
    assert out["HIVE_PLUGIN_DIRS"].split(os.pathsep) == [str(oh / "apps" / "omegadesign"), "/srv/mine"]
    assert set(json.loads(out["HIVE_APP_PINS"])) == {"mine", "omegadesign"}
    assert out["HIVE_SANDBOX_RUN_APPS"].split(",") == ["omegadesign", "code-project-test"]


def test_without_studio_nothing_of_it_is_set(tmp_path):
    oh = installed_apps(tmp_path, "omega-tools")
    out = app_settings(oh)
    assert "omegadesign" not in json.loads(out["HIVE_APP_PINS"])
    assert out["HIVE_PLUGIN_DIRS"] == str(oh / "apps" / "omega-tools")
    assert "HIVE_STUDIO_SESSIONS" not in out
