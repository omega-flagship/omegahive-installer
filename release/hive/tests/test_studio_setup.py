"""Purpose: check the installer's Studio path, the app the hive shows as Create: setup-studio.sh lays a release zip out
in apps/omegadesign only when it matches pins.sh (the hive's own source digest and the page lock's sha256), refuses
anything else without leaving a folder behind, and omegahive.sh's app_settings mounts and pins it beside the Tools app,
lets it run in the sandbox, and turns Studio's sessions on unless the owner's hive.env says otherwise. The owner step,
studio-on.py, turns Studio on in Create · Code the first time, keeps an owner's choice of swarms through a new release,
leaves a Studio its owner turned off alone, and runs with or without Create's Code service; serve's background step on
Linux and WSL turns Studio on after create, even when create stops because Code never answers.

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
import time
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


def created(oh):
    """Create's apps folder, where a plan's deploy puts what the person made (create_plan_ports.py)."""
    return str(oh / "data" / "create" / "apps")


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
    assert out["HIVE_PLUGIN_DIRS"].split(os.pathsep) == [tools, studio, created(oh)]
    pins = json.loads(out["HIVE_APP_PINS"])
    assert pins["omegadesign"] == {"release": studio, "digest": pins_sh("OMEGADESIGN_DIGEST"),
                                   "files": {"ui/bundle.lock.json": pins_sh("OMEGADESIGN_LOCK_SHA256")}}
    assert pins["omega-tools"]["digest"] == pins_sh("OMEGA_TOOLS_DIGEST")
    assert out["HIVE_SANDBOX_RUN_APPS"].split(",") == ["omega-tools", "omegadesign", "create-acceptance-check"]
    assert out["HIVE_STUDIO_SESSIONS"] == "on"


def test_the_owners_own_choices_are_kept_beside_studio(tmp_path):
    oh = installed_apps(tmp_path, "omegadesign")
    out = app_settings(oh, {"HIVE_STUDIO_SESSIONS": "off", "HIVE_PLUGIN_DIRS": "/srv/mine",
                            "HIVE_APP_PINS": json.dumps({"mine": {"release": "/srv/mine", "digest": "sha256:" + "0" * 64}}),
                            "HIVE_SANDBOX_RUN_APPS": "code-project-test"})
    assert "HIVE_STUDIO_SESSIONS" not in out            # the owner's off stays as hive.env has it
    assert out["HIVE_PLUGIN_DIRS"].split(os.pathsep) == [str(oh / "apps" / "omegadesign"), created(oh), "/srv/mine"]
    assert set(json.loads(out["HIVE_APP_PINS"])) == {"mine", "omegadesign"}
    assert out["HIVE_SANDBOX_RUN_APPS"].split(",") == ["omegadesign", "create-acceptance-check", "code-project-test"]


def test_make_is_set_up_on_every_hive_whatever_else_is_installed(tmp_path):
    # Jon on #395: Create is on from setup, so even a hive with neither Tools nor Studio can run a plan's acceptance check
    # (the python runtime and the built-in check in the sandbox list, unpinned) and load what a plan deploys
    oh = installed_apps(tmp_path)
    out = app_settings(oh, {"HIVE_SANDBOX_RUN_APPS": "code-project-test,create-acceptance-check"})
    assert out["HIVE_PLUGIN_DIRS"] == created(oh)
    assert out["HIVE_SANDBOX_RUN_APPS"].split(",") == ["create-acceptance-check", "code-project-test"]
    runtimes = json.loads(out["HIVE_SANDBOX_RUNTIMES"])
    assert runtimes["python"]["exe"] == os.path.realpath(oh / "venv" / "bin" / "python")
    assert "HIVE_APP_PINS" not in out and "metta" not in runtimes


def test_without_studio_nothing_of_it_is_set(tmp_path):
    oh = installed_apps(tmp_path, "omega-tools")
    out = app_settings(oh)
    assert "omegadesign" not in json.loads(out["HIVE_APP_PINS"])
    assert out["HIVE_PLUGIN_DIRS"].split(os.pathsep) == [str(oh / "apps" / "omega-tools"), created(oh)]
    assert "HIVE_STUDIO_SESSIONS" not in out


def studio_on():
    """install/macos/studio-on.py as a module (its file name has a hyphen, as the installer's scripts do)."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("studio_on", MACOS / "studio-on.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ENTRY = {"digest": "sha256:" + "a" * 64}
NEW = {"digest": "sha256:" + "b" * 64}


@pytest.mark.parametrize("entry, status, active, want", [
    # the first time, a swarm app is turned on in the Create · Code controller's swarm
    (ENTRY, {"installed": False, "placement": "swarm"}, set(), ("install", ["s_code"])),
    # a person app opens in each person's own space, so its review names no swarm
    (ENTRY, {"installed": False, "placement": "person"}, set(), ("install", [])),
    # the owner turned it off: a start leaves it off
    (ENTRY, {"installed": True, "placement": "swarm", "release_digest": ENTRY["digest"]}, set(), ("say", None)),
    # on where it was, the same release: nothing to post
    (ENTRY, {"installed": True, "placement": "swarm", "release_digest": ENTRY["digest"]}, {"s_code"}, ("say", None)),
    # a new release keeps the swarms its owner has it on in, the controller's or others, and none stays none
    (NEW, {"installed": True, "placement": "swarm", "release_digest": ENTRY["digest"]}, {"s_team", "s_code"},
     ("install", ["s_code", "s_team"])),
    (NEW, {"installed": True, "placement": "swarm", "release_digest": ENTRY["digest"]}, set(), ("install", [])),
    # Studio that didn't load is said, not posted
    ({"error": "not pinned"}, {"installed": False, "placement": "swarm"}, set(), ("say", None)),
])
def test_studio_is_turned_on_once_and_an_owners_choice_stands(entry, status, active, want):
    kind, what = studio_on().decide(entry, status, active, "s_code")
    assert kind == want[0]
    if kind == "install":
        assert what == {"release_digest": entry["digest"], "placement": status["placement"], "use_in": want[1]}


def test_without_the_controller_studio_waits_for_the_next_start():
    kind, line = studio_on().decide(ENTRY, {"installed": False, "placement": "swarm"}, set(), None)
    assert kind == "say" and "next start" in line


def fake_hive(installed, active, digest=ENTRY["digest"]):
    """The hive's answers to the step's reads, and the posts it receives."""
    posts = []

    def api(method, path, body=None):
        if method == "POST":
            posts.append((path, body))
            return {"ok": True}
        return {"/api/programs/omegadesign": {"digest": digest},
                "/api/programs/omegadesign/install": {"installed": installed, "placement": "swarm",
                                                      "release_digest": ENTRY["digest"] if installed else None},
                "/api/agents": [{"name": "Your mind", "swarm_id": "s_me"},
                                {"name": "Create · Code controller", "swarm_id": "s_code"}],
                "/api/programs/omegadesign/activations": [{"swarm_id": s, "active": True} for s in active]}[path]
    return api, posts


def test_the_switch_on_step_reviews_studio_into_create_code_once():
    api, posts = fake_hive(installed=False, active=[])
    assert studio_on().run(api) == "Create is in your hive: Studio, with its Make, Code and Flow."
    assert posts == [("/api/programs/omegadesign/install",
                      {"release_digest": ENTRY["digest"], "placement": "swarm", "use_in": ["s_code"]})]
    api, posts = fake_hive(installed=True, active=["s_code"])
    studio_on().run(api)
    assert posts == []                                   # the next start posts nothing


def test_the_switch_on_step_leaves_studio_off_when_its_owner_turned_it_off():
    api, posts = fake_hive(installed=True, active=[])
    assert "turned off" in studio_on().run(api)
    assert posts == []
    api, posts = fake_hive(installed=True, active=[], digest=NEW["digest"])   # an update with a new release
    assert studio_on().run(api) == "Studio is updated and stays off, as its owner left it."
    assert posts == [("/api/programs/omegadesign/install",
                      {"release_digest": NEW["digest"], "placement": "swarm", "use_in": []})]


def test_the_studio_step_runs_with_or_without_the_code_service():
    """omegahive.sh: create still needs Code's config, studio needs only Studio's folder, and serve runs studio either way."""
    text = (MACOS / "omegahive.sh").read_text()
    studio = re.search(r"^studio\(\) \{\n(.*?)^\}\n", text, re.S | re.M).group(1)
    assert "omegadesign/plugin.json" in studio and "config.json" not in studio
    serve = re.search(r"^serve\(\) \{\n(.*?)^\}\n", text, re.S | re.M).group(1)
    assert re.search(r"^\s+code_and_studio >> .*&$", serve, re.M)
    installer = (MACOS / "Install OmegaHive.command").read_text()
    assert '"$OH/app/install/macos/omegahive.sh" studio' in installer


@pytest.mark.parametrize("has_code, answers, said", [
    (True, False, ["FAIL Create's Code service did not answer, so it can't be enrolled; its log: {code}/logs/service.log",
                   "Create's Code service did not start or enrol; see above", "STUDIO ON"]),
    (True, True, ["ENROLLED", "STUDIO ON"]),
    (False, False, ["STUDIO ON"]),
])
def test_serve_turns_studio_on_with_or_without_a_working_code_service(tmp_path, has_code, answers, said):
    """serve's background step, as Linux and WSL run it. create's fail exits the shell it runs in, which ended the whole
    step before studio while the two shared one (the QA review of #397 at f7801859), so a hive whose Code service never
    answered got no Create at any start. Here the step runs with the real create against a Code service that never
    answers, with an enrolment that works, and on a hive that has no Code service at all."""
    text = (MACOS / "omegahive.sh").read_text()
    step, create = (re.search(rf"^{name}\(\) \{{\n.*?^\}}\n", text, re.S | re.M).group(0)
                    for name in ("code_and_studio", "create"))
    code = tmp_path / "code"
    if has_code:
        code.mkdir()
        (code / "config.json").write_text("{}")
    if answers:   # an enrolment that works needs a hive and a Code service, which this test stands in for
        create = "create() { echo ENROLLED; }\n"
    stubs = ("say() { printf '%s\\n' \"$*\"; }\nfail() { echo \"FAIL $*\"; exit 1; }\nwait_running() { :; }\n"
             "start() { :; }\nstart_code() { :; }\ncode_answers() { return 1; }\nstudio() { echo STUDIO ON; }\n")
    script = f"set -euo pipefail\nCODE={shlex.quote(str(code))}\n{stubs}{create}{step}code_and_studio\n"
    done = subprocess.run(["bash", "-c", script], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60)
    assert done.returncode == 0, done.stdout + done.stderr
    assert done.stdout.splitlines() == [line.format(code=code) for line in said]


def enrol_lock_run(oh, name, body):
    """omegahive.sh's enrol_lock, run on its own: its text from the script, with OH set and fail saying why it stopped."""
    lock = re.search(r"^enrol_lock\(\) \{\n.*?^\}\n", (MACOS / "omegahive.sh").read_text(), re.S | re.M).group(0)
    script = f"set -euo pipefail\nOH={shlex.quote(str(oh))}\nfail() {{ echo \"FAIL $*\"; exit 1; }}\n{lock}{body}"
    return subprocess.Popen(["bash", "-c", script, "enrol", name])


def test_enrolments_take_turns_and_a_dead_holders_lock_is_taken_over(tmp_path):
    # serve's own create and one run right after start, at once: on a fresh Linux install both found Code unenrolled
    oh = tmp_path / "OmegaHive"
    oh.mkdir()
    held = ("(enrol_lock; trap 'rm -rf \"$OH/run/create.lock\"' EXIT\n"
            " echo \"in $1\" >> \"$OH/turns\"; sleep 1; echo \"out $1\" >> \"$OH/turns\")\n")
    runs = [enrol_lock_run(oh, name, held) for name in ("a", "b")]
    assert [run.wait(timeout=60) for run in runs] == [0, 0]
    turns = (oh / "turns").read_text().split("\n")[:-1]
    assert [t.split()[0] for t in turns] == ["in", "out", "in", "out"]          # never two holders at once
    assert turns[0].split()[1] == turns[1].split()[1] and turns[2].split()[1] == turns[3].split()[1]
    assert not (oh / "run" / "create.lock").exists()                             # each holder lets go
    # a lock whose holder died, its pid gone, is taken over at once rather than waited out
    gone = subprocess.Popen(["true"])
    gone.wait()
    (oh / "run" / "create.lock").mkdir()
    (oh / "run" / "create.lock" / "pid").write_text(str(gone.pid))
    started = time.monotonic()
    assert enrol_lock_run(oh, "c", held).wait(timeout=60) == 0
    assert time.monotonic() - started < 10 and (oh / "turns").read_text().endswith("in c\nout c\n")


def test_create_waits_for_code_before_it_enrols():
    """On Linux start returns once the hive answers and serve starts Code after it, so create waits for Code (starting it
    only where it never came up) and enrols under the lock, before Code's register is ever called."""
    create = re.search(r"^create\(\) \{\n(.*?)^\}\n", (MACOS / "omegahive.sh").read_text(), re.S | re.M).group(1)
    steps = ["  start\n", "  code_answers || start_code\n", "  code_answers || fail ",
             "(enrol_lock; trap 'rm -rf \"$OH/run/create.lock\"' EXIT\n", '"/v1/operator/register"']
    where = [create.find(step) for step in steps]
    assert -1 not in where and where == sorted(where)
