"""Purpose: manage per-agent workspaces shared by every driver.

    <data>/agents/<id>/
      run.metta            entry file (PeTTa resolves imports against its dir)
      repos/OmegaClaw-Core -> the shared checkout (git-import! finds it here)
      repos/petta_lib_chromadb
      memory/              OMEGACLAW_MEMORY_DIR: spaces, history, hive channel files
      memory/prompt.txt    base prompt + persona (shipped default: src/base_prompt.txt)
      token                the agent's hive token (0600)
      agent.log
"""

from __future__ import annotations

import os
import contextlib
import importlib.util
import pathlib
import re
import shutil
import site
import stat
import subprocess
import json
import sys
import threading

from ..core.tools import ToolRegistry
from ..spaces.sexpr import STATEMENT_HEADS
from . import mindfs

RUN_METTA = """!(import! &self (library lib_import))
!(import_prolog_functions_from_file ./repos/OmegaClaw-Core/hive/runtime/register.pl (register-hive-core))
!(register-hive-core)
!(import! &self (car-atom (collapse (library OmegaClaw-Core lib_omegaclaw))))
!(omegaclaw)
"""

# J3 host R6.1: the Studio maker skills (modules/hive_studio) enter an omega mind only while Studio sessions are on: this
# one line in its run.metta and OMEGACLAW_EXTRA_MODULES in its environment (Supervisor.start). Off, neither exists. A
# connector's module (hive/core/connectors.py) enters a mind its owner installed it on the same way.
STUDIO_MODULE = "hive_studio"
STUDIO_IMPORT = "!(import! &self (library OmegaClaw-Core ./modules/hive_studio/entry.metta))"


def module_import(module):
    """The run.metta line that loads one optional module into an omega mind."""
    return f"!(import! &self (library OmegaClaw-Core ./modules/{module}/entry.metta))"

CHROMADB_LIB_URL = "https://github.com/patham9/petta_lib_chromadb.git"
ITER_TEMPLATE = pathlib.Path(__file__).resolve().parents[1] / "templates" / "iter"
# Every omega mind this workspace builds talks to its hive (env below), so its base prompt is the hive-worker base.
COMMCHANNEL = "hive"
HIVE_BASE_PROMPT = pathlib.Path(__file__).resolve().parents[1] / "templates" / "omega" / "prompt.txt"
# Iter (upstream iter.py) reads every memory/ file only while together they fit MAX_MEMORY_CHARS = 3000; past that it
# sees an index of names. Its hive note keeps well under that, leaving room for what the Iter writes itself: at least
# 700 characters. 2200 left the role no room once the template held both the Create line and the earlier-work line
# (2203 characters with both); at 2300 a role of about 190 characters fits whole and a longer one is cut and marked.
ITER_NOTE_CHARS = 2300
# Iter is a pinned external dependency like Omega (core-dependency.json "iter", cloned to third_party/iter). A worker
# gets the whole clone, less its Git metadata and the channels that would connect it to outside chats.
# Iter's own tools that run code a mind writes, tools/shell.py any shell command, tools/python.py any Python and
# tools/metta.py any MeTTa (which reaches every Prolog predicate and Python), run in the worker and never through the
# hive's gate, so any of them could rewrite the tools the loop loads. A mind builds no software itself unless its owner
# switched its own coding on (policy.OWN_CODE_REASON, Jon on omega-flagship/omegahive#395), while its thinking in code
# stays: a worker gets Iter's own three only while its mind's own coding is on, a self-modifying Iter, and otherwise
# the kit's tools/shell.py, which asks the gate each time, and the kit's tools/metta.py, which runs free in a sandbox
# that writes only a scratch folder (tools/_think_sandbox.py). The revision a worker is stamped with names which it
# has, so a worker changes over at its next start after its owner switches.
ITER_CODE_TOOLS = ("shell.py", "python.py", "metta.py")
ITER_SKIP = {".git", "irc.py", "mattermost.py", *ITER_CODE_TOOLS}


def iter_code_tools_stamp(coding):
    """The part of a worker's revision stamp that says which code tools it has: Iter's own (its mind's own coding
    on) or the kit's, a shell that asks and a sandboxed metta."""
    return ("+own-coding:" if coding else "+asks:") + ",".join(ITER_CODE_TOOLS)


def iter_tool_count(root):
    """How many tools an Iter loop loads from a worker: tools/*.py but those starting with an underscore (iter.py
    load_tools, utils.metta python-files), read through mindfs like the rest of the worker."""
    return sum(1 for name in mindfs.listdir(root, "tools") if name.endswith(".py") and not name.startswith("_"))


ITER_STAMP = ".iter_revision"
# Iter variants (agent options.iter_variant). "omega": iter.py of the omega branch, everything from it. "metta": the
# metta-omega compromise, the MeTTa loop (iter.metta, utils.metta, utils.py) of the metta branch run by PeTTa, with
# the tools and context transformations of the omega branch (the same dynamic-file contract, so they run unchanged).
ITER_VARIANTS = ("omega", "metta")
ITER_METTA_LOOP = ("iter.metta", "utils.metta", "utils.py")
# Files of the metta branch that replace their omega counterparts in the metta variant (its metta tool autoloads
# metta/*.metta into spaces of the same name).
ITER_METTA_OVERRIDES = ("tools/metta.py",)


def iter_variant(agent):
    variant = (agent.get("options") or {}).get("iter_variant") or "omega"
    if variant not in ITER_VARIANTS:
        raise ValueError(f"unknown Iter variant {variant!r}")
    return variant


def iter_kit_digest():
    """A short hash of the hive kit (hive/templates/iter), so a changed kit reaches existing workers at their next start."""
    import hashlib
    h = hashlib.sha256()
    for path in sorted(p for p in ITER_TEMPLATE.rglob("*") if p.is_file() and "__pycache__" not in p.parts):
        h.update(str(path.relative_to(ITER_TEMPLATE)).encode() + b"\0" + path.read_bytes() + b"\0")
    return h.hexdigest()[:12]


def iter_path():
    """PATH without the hive's venv: the rest of an Iter worker's PATH, after its interpreter's folder
    (iter_environment)."""
    venv = os.environ.get("VIRTUAL_ENV")
    return os.pathsep.join(p for p in os.environ.get("PATH", "").split(os.pathsep)
                           if not (venv and pathlib.Path(p).resolve().is_relative_to(pathlib.Path(venv).resolve())))


# What Iter imports from outside the standard library (third_party/iter at core-dependency.json's "iter" pin): openai
# in iter.py and its memory tools, chromadb in its memory tools, ddgs in tools/websearch.py. The hive's kit
# (hive/templates/iter) imports nothing more. Where they are installed differs: an installed hive's venv holds them
# (install/installer_common.py BASE_PIP), the image's system python3 holds them (Dockerfile), so the worker's Python is
# found by what it can import, never by where it sits.
ITER_IMPORTS = ("openai", "chromadb", "ddgs")
# Run as `python -c ITER_IMPORT_PROBE module...`: prints each module that interpreter cannot find, importing none.
ITER_IMPORT_PROBE = "import importlib.util, sys\nfor m in sys.argv[1:]:\n    importlib.util.find_spec(m) or print(m)"


def iter_missing(python=None):
    """The ITER_IMPORTS modules an interpreter cannot find, looked up without importing them: this hive's own when
    python is None, else python started with the Python variables an Iter worker gets (PATH, HOME, PYTHONPATH, LANG
    and the user site Workspace.env keeps). None when python does not run.
    Time: three module lookups in this process, or one start of python."""
    if python is None:
        return [m for m in ITER_IMPORTS if importlib.util.find_spec(m) is None]
    env = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "PYTHONPATH", "LANG")}
    env["PYTHONUSERBASE"] = site.getuserbase()
    try:
        done = subprocess.run([python, "-c", ITER_IMPORT_PROBE, *ITER_IMPORTS], env=env, stdin=subprocess.DEVNULL,
                              capture_output=True, text=True)
    except OSError:
        return None
    return done.stdout.split() if done.returncode == 0 else None


def iter_python():
    """The Python an Iter worker runs in, chosen by what it can import: this hive's own interpreter when it finds every
    ITER_IMPORTS module (an installed hive, whose venv holds them), else the first python3 on PATH that finds them all
    (the image, whose system python3 holds them). Refuses, naming what each interpreter it tried lacks, when none does.
    Time: three lookups here, then one interpreter start per python3 on PATH tried, n = PATH entries."""
    missing = iter_missing()
    if not missing:
        return sys.executable
    lacking = {sys.executable: missing}
    for folder in os.environ.get("PATH", "").split(os.pathsep):
        python = shutil.which("python3", path=folder) if folder else None
        if not python or os.path.abspath(python) in lacking:
            continue
        python = os.path.abspath(python)
        missing = iter_missing(python)
        if missing == []:
            return python
        lacking[python] = missing
    raise RuntimeError(f"an Iter worker needs a Python that can import {', '.join(ITER_IMPORTS)}, and none here can: "
                       + "; ".join(f"{p} does not run" if m is None else f"{p} lacks {', '.join(m)}"
                                   for p, m in lacking.items()))


def iter_interpreter():
    """The interpreter an Iter worker runs: HIVE_ITER_PYTHON when set (a path, or a name found on PATH), as given and
    unchecked, else iter_python()."""
    chosen = os.environ.get("HIVE_ITER_PYTHON")
    if not chosen:
        return iter_python()
    found = shutil.which(chosen)
    if not found:
        raise RuntimeError(f"HIVE_ITER_PYTHON={chosen} is not a program this hive can run")
    return os.path.abspath(found)


def iter_environment(python):
    """PATH and VIRTUAL_ENV for an Iter worker that runs python. PATH has python's folder first, so the MeTTa loop's
    workers (python3 from PATH) run the same interpreter, then iter_path(). VIRTUAL_ENV names python's own venv (PEP
    405: a pyvenv.cfg beside it or one folder up, its link not followed), which janus needs to see that venv's
    packages, and is empty for an interpreter in no venv."""
    folder = pathlib.Path(python).parent   # unresolved: a venv's python is a link to its base interpreter
    venv = next((str(p) for p in (folder, folder.parent) if (p / "pyvenv.cfg").is_file()), "")
    return {"PATH": os.pathsep.join(p for p in (str(folder), iter_path()) if p), "VIRTUAL_ENV": venv}

HIVE_PROMPT = """

## You are {name}, a mind in an OmegaHive
You run continuously. People and other minds reach you through the hive channel;
reply with `send`. To reach a swarm-mate, post in your swarm's room and @Name them
(`hive-rooms` lists it, `hive-room-post r_id @Name text`). You belong to a swarm that shares a commons of beliefs:
- `hive-publish <statement> <f> <c>` shares a belief, e.g. `hive-publish (--> sky blue) 0.9 0.8`.
  A statement is a logical form: every list in it starts with one of {heads}, so a compound
  term is a product, e.g. `(--> (x water sea-level) boils-at-100-celsius)`. f is how true, c how confident (0 < c < 1).
- `hive-query <pattern>` searches the commons, e.g. `hive-query (Current (--> sky $x) $tv $stamp)`.
- `hive-belief <statement>` shows a shared belief with its sources.
Beliefs from independent evidence are merged by revision; repeating what another
mind told you does not make it more certain.

To show larger work, share it for a while instead of sending long messages:
- `hive-exhibit Lyra,Orion 60 Title | text and atoms` shows a piece of work (or `swarm`).
- `hive-share-request Lyra world 30 why` asks to read one of Lyra's spaces; Lyra answers
  `hive-share-grant sh_id` or `hive-share-deny sh_id reason`; `hive-share-offer` opens yours.
- `hive-shared sh_id filter` reads what was shared with you; access ends by itself.
"""

# A person's own mind lives alone in a swarm of its own (hive/core/personal.py), so the sharing HIVE_PROMPT describes
# reaches no other mind. Told nothing of it, on v0.31 one such mind exhibited a lesson to its empty swarm and was
# refused, and four others published one and told their person that other minds, swarm-mates or the hive could read
# it (16 November). It says only who reads what the mind shares, and never steers it toward publishing: Jon wants
# beliefs seen through permission-scoped links between spaces, not passed around (omega-flagship/omegahive#334).
OWN_MIND_PROMPT = """
## You are your person's own mind
No other mind is in your swarm or can join it, and sharing never crosses swarms, so no other mind reads what you
share: a belief you publish stays in your own commons, which your person sees on your swarm's page, and an exhibit
or a space share has no one to read it. Never tell your person that other minds, swarm-mates or the hive can read
what you share.
"""


def current_token(root):
    """The credential a mind starts with. J3 host R3 (handoff spec r2.4 §3): a Studio maker's workspace holds one file
    per token epoch (token-e<j>) and a `current` pointer naming j; only token-e<current> is ever read, never a
    pending-token-e* or current.tmp. Every other mind has no pointer and keeps its single `token` file, read as before."""
    root = pathlib.Path(root)
    # The mind may write anything in its folder: every credential read refuses links and hard links (mindfs).
    if mindfs.lexists(root, "current"):
        try:
            epoch = mindfs.read_text(root, "current").strip()
        except mindfs.UnsafeMindPath:
            epoch = ""
        if not epoch.isdigit():
            raise RuntimeError(f"{root.name}: the credential pointer is unreadable")
        return mindfs.read_text(root, f"token-e{int(epoch)}").strip()
    return mindfs.read_text(root, "token").strip()


class Workspace:
    def __init__(self, settings, programs=None):
        self.settings = settings
        self.programs = programs
        self._runtime_root = None
        self._runtime_lock = threading.Lock()

    def path(self, agent_id) -> pathlib.Path:
        return self.settings.agents_dir / agent_id

    @contextlib.contextmanager
    def _namespace(self, agent_id):
        # Production supervisors attach Programs/hive before workspace access. Standalone render/driver fixtures
        # have no hive DB. Reuse placement's one namespace authority whenever that host context exists.
        hive = getattr(self.programs, "hive", None)
        if hive is None:
            yield
            return
        with hive.placement._workspace_guard(agent_id, self.path(agent_id)):
            yield

    def runtime_core(self) -> pathlib.Path:
        from ..runtime.core import compose
        # Concurrent mind starts share one successful verification in the hive.
        with self._runtime_lock:
            if self._runtime_root is None:
                self._runtime_root = compose(self.settings.core_root, self.settings.data_dir / "libs" / "omega-runtime")
            return self._runtime_root

    def refresh_runtime(self, agent):
        if agent.get("kind") in {"iter", "module"}:
            return
        target = self.runtime_core()
        root = self.path(agent["id"])
        rel = "repos/OmegaClaw-Core"
        current = mindfs.readlink(root, rel)
        if current is not None and os.path.realpath(os.path.join(root, "repos", current)) == str(target.resolve()):
            return
        st = mindfs.lstat(root, rel)
        if current is None and st is not None and stat.S_ISDIR(st.st_mode):
            raise RuntimeError("Agent core path is a real directory; refusing to replace it")
        try:
            mindfs.symlink(root, rel, target)
        except mindfs.UnsafeMindPath as exc:
            raise RuntimeError(f"Agent core path cannot be replaced safely ({exc.strerror})") from None

    def chromadb_lib(self) -> pathlib.Path:
        lib = self.settings.data_dir / "libs" / "petta_lib_chromadb"
        if not (lib / "lib_chromadb.metta").exists():
            lib.parent.mkdir(parents=True, exist_ok=True)
            source = os.environ.get("HIVE_CHROMADB_LIB")
            if source and pathlib.Path(source).exists():
                shutil.copytree(source, lib, dirs_exist_ok=True)
            else:
                subprocess.run(["git", "clone", "-q", "--depth", "1", CHROMADB_LIB_URL, str(lib)], check=True)
        return lib

    def iter_source(self, key="iter") -> pathlib.Path:
        """A pinned Iter clone (core-dependency.json "iter" or "iter_metta"), installed and verified like Omega."""
        from ..runtime.core import initialize_iter
        source = initialize_iter(self.settings.core_root, key)
        if source is None:
            raise RuntimeError(f"core-dependency.json has no \"{key}\" entry")
        return source

    def create_iter(self, agent, token):
        with self._namespace(agent["id"]):
            return self._create_iter(agent, token)

    def _create_iter(self, agent, token):
        root = mindfs.ensure_root(self.path(agent["id"]))
        self._sync_iter(agent)
        self.write_iter_note(agent)
        mindfs.write_text(root, "token", token, mode=0o600)
        return root

    def sync_iter(self, agent):
        with self._namespace(agent["id"]):
            return self._sync_iter(agent)

    def _sync_iter(self, agent):
        """Copy the pinned Iter into the worker when it lacks this revision; the Iter's own memory, experience and
        later self-edits are kept until the pin changes. The metta variant gets the omega clone (tools,
        transformations, prompt, channels) with the MeTTa loop of the metta clone in place of iter.py.
        The Iter may write anything in its folder, links included, so every read and write here goes through mindfs:
        nothing is read or written through a link it planted."""
        from ..core.providers import own_coding
        from ..runtime.core import specification
        root = mindfs.ensure_root(self.path(agent["id"]))
        variant = iter_variant(agent)
        coding = own_coding(agent)
        spec = specification(self.settings.core_root)
        revision = spec["iter"]["revision"] + ("+" + spec["iter_metta"]["revision"] + "+" + ",".join(ITER_METTA_OVERRIDES)
                                               if variant == "metta" else "") + "+kit:" + iter_kit_digest() \
            + iter_code_tools_stamp(coding)
        try:
            if mindfs.read_text(root, ITER_STAMP).strip() == revision:
                return root
        except OSError:          # missing, or not a plain file the hive may read (UnsafeMindPath): copy afresh
            pass
        source = self.iter_source()
        loop_source = self.iter_source("iter_metta") if variant == "metta" else None
        mindfs.copy_tree(source, root, skip=ITER_SKIP | ({"iter.py"} if variant == "metta" else set()))
        if variant == "metta":
            for name in ITER_METTA_LOOP + ITER_METTA_OVERRIDES:
                mindfs.copy_file(loop_source / name, root, name)
            mindfs.unlink(root, "iter.py")         # a worker switched from omega runs only the MeTTa loop
        mindfs.copy_tree(ITER_TEMPLATE, root)
        if coding:   # Iter's own shell, python and metta (a MeTTa-loop worker's own) in place of the kit's
            for name in ITER_CODE_TOOLS:
                own = loop_source if f"tools/{name}" in ITER_METTA_OVERRIDES and loop_source else source
                mindfs.copy_file(own / "tools" / name, root, f"tools/{name}")
        else:        # the kit's shell and metta have replaced any an earlier copy left; Iter's python goes too
            mindfs.unlink(root, "tools/python.py")
        # Iter loads only its first MAX_TOOLS tools, and its own tools plus the hive kit pass upstream's value, so the
        # worker's copy sets it to the tools this worker holds, never below upstream's: no tool is cut however the kit
        # or upstream grows. A fixed 40 cut two once the code tools and Create's tool joined the kit.
        loop, pattern, form = (("iter.metta", r"\n\(= \(MAX_TOOLS\) (\d+)\)\n", "\n(= (MAX_TOOLS) {})\n")
                               if variant == "metta" else
                               ("iter.py", r"\nMAX_TOOLS = (\d+)\n", "\nMAX_TOOLS = {}\n"))
        text = mindfs.read_text(root, loop)
        found = re.search(pattern, text)
        if found is None:
            raise RuntimeError(f"the pinned Iter's {loop} no longer sets MAX_TOOLS, so a worker can't make room for its "
                               "tools")
        limit = max(int(found[1]), iter_tool_count(root))
        mindfs.write_text(root, loop, text[:found.start()] + form.format(limit) + text[found.end():],
                          mode=stat.S_IMODE(mindfs.lstat(root, loop).st_mode))
        self._iter_home(root)
        mindfs.write_text(root, ITER_STAMP, revision)
        return root

    def _iter_home(self, root):
        """Upstream Iter tools use ~/PeTTa and ~/iter. The worker runs with HOME=<its folder>, so these resolve inside
        it: iter -> the worker itself, PeTTa -> a private folder (its own chroma_db and history) linking the shared
        PeTTa runtime and Omega's NAL/PLN libraries. Each link is made by mindfs, which replaces a file or link the
        Iter left there and refuses a real directory."""
        if mindfs.readlink(root, "iter") != ".":
            mindfs.symlink(root, "iter", ".")
        mindfs.ensure_dir(root, "PeTTa/repos/mettaclaw/memory")
        omega = self.settings.core_root / "third_party" / "Omega"
        links = {"run.sh": pathlib.Path(self.settings.petta_path) / "run.sh",
                 "src": pathlib.Path(self.settings.petta_path) / "src",
                 "lib": pathlib.Path(self.settings.petta_path) / "lib",
                 "lib_nal.metta": omega / "lib_nal.metta",
                 "lib_pln.metta": omega / "lib_pln.metta"}
        for name, target in links.items():
            mindfs.symlink(root, f"PeTTa/{name}", pathlib.Path(target).resolve())

    def command(self, agent, petta_path):
        root = self.path(agent["id"])
        if agent.get("kind") == "iter":
            self.sync_iter(agent)
            if iter_variant(agent) == "metta":
                # PeTTa runs the MeTTa loop; its workers (utils.py --invoke) are started as python3 from PATH
                return ["sh", str(pathlib.Path(petta_path) / "run.sh"), str(root / "iter.metta"), "--silent"]
            return [iter_interpreter(), str(root / "iter.py")]
        self.refresh_runtime(agent)
        # --silent stops PeTTa echoing every compiled clause; the mind's own output and errors still reach agent.log
        return ["sh", str(pathlib.Path(petta_path) / "run.sh"), str(root / "run.metta"), "--silent"]

    def base_prompt(self):
        """The personal-Omega base: WhatsApp, operator, energy. Minds off the hive keep it. A local memory/prompt.txt
        overrides the shipped seed, src/base_prompt.txt."""
        for prompt in (self.settings.core_root / "memory" / "prompt.txt", self.settings.core_root / "src" / "base_prompt.txt"):
            if prompt.exists():
                return prompt.read_text(encoding="utf-8")
        return "You are Omega, an always-on agent."

    def mind_base_prompt(self, agent):
        """A mind's base prompt. On the hive channel it is the hive-worker base (hive/templates/omega/prompt.txt:
        goals, protocol examples, when to share and when to stop, no WhatsApp or operator sections); otherwise, or
        if that file is missing, the personal-Omega base."""
        if COMMCHANNEL == "hive" and HIVE_BASE_PROMPT.exists():
            return HIVE_BASE_PROMPT.read_text(encoding="utf-8").replace("{name}", agent["name"])
        return self.base_prompt().replace("Omega", agent["name"])

    def write_iter_note(self, agent):
        with self._namespace(agent["id"]):
            return self._write_iter_note(agent)

    def _write_iter_note(self, agent):
        """An Iter's memory/hive.txt: its name, the hive kit protocol (template), its role and persona. An Iter reads
        all of memory/ only while it fits (see ITER_NOTE_CHARS), so the role and persona are cut to fit, and marked."""
        note = (ITER_TEMPLATE / "memory" / "hive.txt").read_text(encoding="utf-8")
        text = f"Your name is {agent['name']}.\n" + note
        for title, value in (("Your role", agent.get("role_prompt")), ("Persona", agent.get("persona"))):
            value = (value or "").strip()
            if not value:
                continue
            head, marker = f"\n{title}: ", f" [cut: {len(value)} characters in all]"
            room = ITER_NOTE_CHARS - len(text) - len(head) - 1
            if len(value) > room:
                if room - len(marker) < 80:
                    break                           # no useful room left: leave it out rather than show a stub
                value = value[:room - len(marker)] + marker
            text += head + value + "\n"
        mindfs.write_text(self.path(agent["id"]), "memory/hive.txt", text)

    def refresh_prompt(self, agent):
        """At every start (Supervisor.start): an omega mind's prompt is rebuilt from the hive's current template, role
        and persona. memory/prompt.txt is derived and nothing else writes it, yet it was written only at creation and on
        a rename, model or persona change, so a prompt fix shipped in an update never reached a mind made before it
        (tester report 11-13). A mind whose workspace has no prompt yet is left untouched, as write_studio_skills leaves
        one without a run.metta."""
        with self._namespace(agent["id"]):
            if agent.get("kind") != "omega" or not mindfs.lexists(self.path(agent["id"]), "memory/prompt.txt"):
                return
            self._write_prompt(agent)

    def write_prompt(self, agent):
        with self._namespace(agent["id"]):
            return self._write_prompt(agent)

    def _write_prompt(self, agent):
        if agent.get("kind") == "iter":
            if mindfs.lexists(self.path(agent["id"]), ITER_STAMP):
                self.write_iter_note(agent)   # a role or persona change reaches the Iter as it does an omega mind
            return
        text = self.mind_base_prompt(agent)
        # the commons' own connectives (sexpr.STATEMENT_HEADS): the rule a mind reads is the one it is held to
        text += HIVE_PROMPT.format(name=agent["name"], heads=" ".join(sorted(STATEMENT_HEADS)))
        if agent.get("personal"):
            text += OWN_MIND_PROMPT
        if agent.get("role_prompt"):
            text += f"\n## Your role\n{agent['role_prompt'].strip()}\n"
        if agent.get("persona"):
            text += f"\n## {'Also' if agent.get('role_prompt') else 'Persona'}\n{agent['persona'].strip()}\n"
        mindfs.write_text(self.path(agent["id"]), "memory/prompt.txt", text)

    def create(self, agent, token):
        with self._namespace(agent["id"]):
            return self._create(agent, token)

    def _create(self, agent, token):
        selection = (agent.get('options') or {}).get('tools', [])
        plan = self.tools_plan(agent) if selection else None
        if agent.get("kind") == "iter":
            return self.create_iter(agent, token)
        if agent.get("kind") == "module":
            # External member (another tool or agent runtime): it runs elsewhere and
            # only uses its token against the agent API, so no workspace is built.
            return mindfs.ensure_root(self.path(agent["id"]))
        root = mindfs.ensure_root(self.path(agent["id"]))
        mindfs.ensure_dir(root, "repos")
        mindfs.write_text(root, "run.metta", RUN_METTA)
        links = {"OmegaClaw-Core": self.runtime_core(), "petta_lib_chromadb": self.chromadb_lib()}
        for name, target in links.items():
            mindfs.symlink(root, f"repos/{name}", pathlib.Path(target).resolve())
        mindfs.write_text(root, "token", token, mode=0o600)
        self.write_prompt(agent)
        self.write_tools(agent, plan)
        return root

    def tools_plan(self, agent):
        if agent.get('kind') not in ('omega', 'iter', 'module'):
            raise ValueError('unsupported Tools caller kind')
        registry = ToolRegistry(self.settings.core_root, self.programs)
        plan = registry.plan((agent.get('options') or {}).get('tools', []), self.settings.petta_path,
                             os.environ.get('OMEGACLAW_PYTHON_EXECUTABLE') or sys.executable)
        registry.preflight(plan)
        return plan

    def write_tools(self, agent, plan=None):
        with self._namespace(agent["id"]):
            return self._write_tools(agent, plan)

    def _write_tools(self, agent, plan=None):
        root=self.path(agent['id']); mindfs.ensure_dir(root, 'memory')
        selected=(agent.get('options') or {}).get('tools',[])
        plan=plan or (self.tools_plan(agent) if selected else {'skills':{},'reviewed':{}})
        # Only declared wrappers/signatures/cards enter the mind. No donor law,
        # package mount, host plan or native evaluator is exposed to it.
        fragments=['!(import! &self (car-atom (collapse (library OmegaClaw-Core ./hive/runtime/extensions/helper_tools.py))))'] if selected else []
        for skill in plan['skills']:
            fragments.append('(= ('+skill+' $json) (sread (py-call (helper_tools.call '+json.dumps(skill)+' $json))))')
        fragment='\n'.join(fragments)+'\n'
        mindfs.write_text(root, 'memory/tools-loader.metta', fragment)
        mindfs.write_text(root, 'memory/tools-signatures.metta', ''.join('(SkillSignature '+skill+' (Arg rest-text json-arguments))\n' for skill in plan['skills']))
        mindfs.write_text(root, 'memory/tools-affordance.metta', ''.join('(SkillCardLine '+json.dumps(skill)+' '+json.dumps(skill+' JSON-argument-array; finite synthetic advisory data only')+')\n' for skill in plan['skills']))
        mindfs.write_text(root, 'run.metta', RUN_METTA.replace('!(omegaclaw)',fragment+'!(omegaclaw)') if selected else RUN_METTA)

    def write_studio_skills(self, agent, on):
        return self.write_module_imports(agent, {STUDIO_MODULE: on})

    def write_module_imports(self, agent, wanted):
        with self._namespace(agent["id"]):
            return self._write_module_imports(agent, wanted)

    def _write_module_imports(self, agent, wanted):
        """For each optional module named in `wanted` (module -> on), add (on) or remove (off) its import in an omega
        mind's run.metta, before !(omegaclaw). A file already in that state, a mind of another kind or a mind without a
        run.metta is left untouched (no write)."""
        if agent.get("kind") != "omega":
            return
        root = self.path(agent["id"])
        run = root / "run.metta"
        try:
            text = mindfs.read_text(root, "run.metta")
        except FileNotFoundError:
            return
        before = text
        for module, on in sorted(wanted.items()):
            line = module_import(module)
            has = line + "\n" in text
            other = [x for x in text.splitlines() if f"modules/{module}/" in x and x != line]
            if other or text.count(line) > (1 if has else 0):
                # R6.2 (Kimi #4): never add a second import next to a hand-edited one, nor leave one loading switched off
                raise ValueError(f"{run} has a hand-edited {module} import; restore it or remove it, then start again")
            if on and not has and "!(omegaclaw)" in text:
                text = text.replace("!(omegaclaw)", line + "\n!(omegaclaw)", 1)
            elif not on and has:
                text = text.replace(line + "\n", "")
        if text == before:
            return
        mindfs.write_text(root, "run.metta", text)

    def token(self, agent_id):
        # Every kind reaches this before launch, including Iter/module paths without write_studio_skills.
        with self._namespace(agent_id):
            return current_token(self.path(agent_id))

    def env(self, agent, hub_url, api_url, memory_dir=None):
        """Environment for an agent talking to this hive."""
        from ..core.providers import clean_options
        options = clean_options(agent.get("options"))
        token = self.token(agent["id"])
        if agent.get("kind") == "iter":
            api = f"{api_url.rstrip('/')}/llm/v1"
            # HOME is the worker's folder, so upstream tools' ~/PeTTa and ~/iter stay inside it (Workspace._iter_home);
            # its embedding calls (OpenAI()) go through the hive gateway with the member token.
            return {"LANG": "C.UTF-8", "HIVE_API_URL": api_url, "HIVE_TOKEN": token, "HIVE_AGENT_ID": agent["id"],
                    "BASE_URL": api, "AI_API_KEY": token, "LLM_MODEL": "hive",
                    "OPENAI_BASE_URL": api, "OPENAI_API_KEY": token, "HOME": str(self.path(agent["id"])),
                    # the kit's metta sandboxes itself with the hive's own Landlock helpers (tools/_think_sandbox.py)
                    "HIVE_THINK_SANDBOX_LIB": str(pathlib.Path(__file__).resolve().with_name("landlock.py")),
                    "PYTHONUSERBASE": site.getuserbase(),   # HOME moved: keep the real user site (openai, chromadb, ddgs)
                    # the MeTTa loop starts its workers as python3 from PATH and loads utils.py through janus: both
                    # follow the interpreter that has Iter's packages (iter_environment)
                    **iter_environment(iter_interpreter())}
        memory = memory_dir or str(self.path(agent["id"]) / "memory")
        llm = f"{api_url.rstrip('/')}/llm/v1"
        from hive.runtime.native_core import runtime_directory
        env = {
            "OMEGACLAW_RUNTIME_CACHE": str(runtime_directory(self.settings.core_root)),
            "LANG": "C.UTF-8",
            "commchannel": COMMCHANNEL,
            "HIVE_WS_URL": hub_url,
            "HIVE_WS_TOKEN": token,
            "HIVE_API_URL": api_url,
            "HIVE_AGENT_ID": agent["id"],
            "OMEGACLAW_MEMORY_DIR": memory,
            # the body this mind runs in, written by the hive it runs under (hive/core/placement.py)
            "OMEGACLAW_BODY_CONTAINER_CONFIG": str(pathlib.Path(memory) / "runtime" / "body" / "host.json"),
            "provider": "Hive",
            "HIVE_LLM_URL": llm,
            "HIVE_LLM_TOKEN": token,
            "OPENAI_BASE_URL": llm,
            "OPENAI_API_KEY": token,
            "embeddingprovider": "OpenAI",
        }
        # Core configure reads this before its 6000-token default. The actual
        # larger request reaches the gateway's existing worst-case budget check.
        if "max_output_tokens" in options:
            env["maxOutputToken"] = str(options["max_output_tokens"])
        if (agent.get('options') or {}).get('tools'):
            plan=self.tools_plan(agent)
            env['OMEGACLAW_EXTRA_LOADER']=str(self.path(agent['id'])/'memory/tools-loader.metta')
            env['OMEGACLAW_TOOLS_RECEIPT']=next(iter(plan['reviewed'].values()))
        return env
