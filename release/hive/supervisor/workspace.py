"""Per-agent workspace on disk, shared by every driver.

    <data>/agents/<id>/
      run.metta            entry file (PeTTa resolves imports against its dir)
      repos/OmegaClaw-Core -> the shared checkout (git-import! finds it here)
      repos/petta_lib_chromadb
      memory/              OMEGACLAW_MEMORY_DIR: spaces, history, hive channel files
      memory/prompt.txt    base prompt + persona
      token                the agent's hive token (0600)
      agent.log
"""

from __future__ import annotations

import os
import contextlib
import pathlib
import shutil
import subprocess
import json
import sys

from ..core.tools import ToolRegistry

RUN_METTA = """!(import! &self (library lib_import))
!(git-import! "https://github.com/asi-alliance/OmegaClaw-Core.git")
!(import! &self (car-atom (collapse (library OmegaClaw-Core lib_omegaclaw))))
!(omegaclaw)
"""

# J3 host R6.1: the Studio maker skills (modules/hive_studio) enter an omega mind only while Studio sessions are on: this
# one line in its run.metta and OMEGACLAW_EXTRA_MODULES in its environment (Supervisor.start). Off, neither exists.
STUDIO_MODULE = "hive_studio"
STUDIO_IMPORT = "!(import! &self (library OmegaClaw-Core ./modules/hive_studio/entry.metta))"

CHROMADB_LIB_URL = "https://github.com/patham9/petta_lib_chromadb.git"
ITER_URL = "https://github.com/patham9/iter.git"
ITER_TEMPLATE = pathlib.Path(__file__).resolve().parents[1] / "templates" / "iter"
# Every omega mind this workspace builds talks to its hive (env below), so its base prompt is the hive-worker base.
COMMCHANNEL = "hive"
HIVE_BASE_PROMPT = pathlib.Path(__file__).resolve().parents[1] / "templates" / "omega" / "prompt.txt"
# Iter (upstream iter.py) reads every memory/ file only while together they fit MAX_MEMORY_CHARS = 3000; past that it
# sees an index of names. Its hive note keeps well under that, leaving room for what the Iter writes itself.
ITER_NOTE_CHARS = 2200
# Iter files copied into a worker.  Its shell and python tools are left out on
# purpose: an Iter rewrites its own tools, so it is not covered by the policy
# gate and must run in a sandbox (docker driver).
ITER_FILES = ["iter.py", "prompt.txt", "reprogramming.txt", "LICENSE", "tools/send.py", "tools/nop.py"]

HIVE_PROMPT = """

## You are {name}, a mind in an OmegaHive
You run continuously. People and other minds reach you through the hive channel;
reply with `send`. To reach a swarm-mate, post in your swarm's room and @Name them
(`hive-rooms` lists it, `hive-room-post r_id @Name text`). You belong to a swarm that shares a commons of beliefs:
- `hive-publish <statement> <f> <c>` shares a belief, e.g. `hive-publish (--> sky blue) 0.9 0.8`.
  Statements are MeTTa expressions; f is how true, c how confident (0 < c < 1).
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


def current_token(root):
    """The credential a mind starts with. J3 host R3 (handoff spec r2.4 §3): a Studio maker's workspace holds one file
    per token epoch (token-e<j>) and a `current` pointer naming j; only token-e<current> is ever read, never a
    pending-token-e* or current.tmp. Every other mind has no pointer and keeps its single `token` file, read as before."""
    root = pathlib.Path(root)
    pointer = root / "current"
    if pointer.exists():
        epoch = pointer.read_text(encoding="utf-8").strip()
        if not epoch.isdigit():
            raise RuntimeError(f"{root.name}: the credential pointer is unreadable")
        return (root / f"token-e{int(epoch)}").read_text(encoding="utf-8").strip()
    return (root / "token").read_text(encoding="utf-8").strip()


class Workspace:
    def __init__(self, settings, programs=None):
        self.settings = settings
        self.programs = programs

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

    def iter_source(self) -> pathlib.Path:
        source = self.settings.data_dir / "libs" / "iter"
        if not (source / "iter.py").exists():
            source.parent.mkdir(parents=True, exist_ok=True)
            local = os.environ.get("HIVE_ITER_SRC")
            if local and pathlib.Path(local, "iter.py").exists():
                shutil.copytree(local, source, dirs_exist_ok=True)
            else:
                subprocess.run(["git", "clone", "-q", "--depth", "1", ITER_URL, str(source)], check=True)
        return source

    def create_iter(self, agent, token):
        with self._namespace(agent["id"]):
            return self._create_iter(agent, token)

    def _create_iter(self, agent, token):
        root = self.path(agent["id"])
        source = self.iter_source()
        for name in ITER_FILES:
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(source / name, target)
        shutil.copytree(ITER_TEMPLATE, root, dirs_exist_ok=True)
        self.write_iter_note(agent)
        token_file = root / "token"
        token_file.write_text(token, encoding="utf-8")
        token_file.chmod(0o600)
        return root

    def command(self, agent, petta_path):
        root = self.path(agent["id"])
        if agent.get("kind") == "iter":
            return ["python3", str(root / "iter.py")]
        # --silent stops PeTTa echoing every compiled clause; the mind's own output and errors still reach agent.log
        return ["sh", str(pathlib.Path(petta_path) / "run.sh"), str(root / "run.metta"), "--silent"]

    def base_prompt(self):
        """The personal-Omega base (memory/prompt.txt): WhatsApp, operator, energy. Minds off the hive keep it."""
        prompt = self.settings.core_root / "memory" / "prompt.txt"
        return prompt.read_text(encoding="utf-8") if prompt.exists() else "You are Omega, an always-on agent."

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
        memory = self.path(agent["id"]) / "memory"
        memory.mkdir(parents=True, exist_ok=True)
        (memory / "hive.txt").write_text(text, encoding="utf-8")

    def write_prompt(self, agent):
        with self._namespace(agent["id"]):
            return self._write_prompt(agent)

    def _write_prompt(self, agent):
        if agent.get("kind") == "iter":
            if (self.path(agent["id"]) / "iter.py").exists():
                self.write_iter_note(agent)   # a role or persona change reaches the Iter as it does an omega mind
            return
        memory = self.path(agent["id"]) / "memory"
        memory.mkdir(parents=True, exist_ok=True)
        text = self.mind_base_prompt(agent)
        text += HIVE_PROMPT.format(name=agent["name"])
        if agent.get("role_prompt"):
            text += f"\n## Your role\n{agent['role_prompt'].strip()}\n"
        if agent.get("persona"):
            text += f"\n## {'Also' if agent.get('role_prompt') else 'Persona'}\n{agent['persona'].strip()}\n"
        (memory / "prompt.txt").write_text(text, encoding="utf-8")

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
            root = self.path(agent["id"])
            root.mkdir(parents=True, exist_ok=True)
            return root
        root = self.path(agent["id"])
        (root / "repos").mkdir(parents=True, exist_ok=True)
        (root / "run.metta").write_text(RUN_METTA, encoding="utf-8")
        links = {"OmegaClaw-Core": self.settings.core_root, "petta_lib_chromadb": self.chromadb_lib()}
        for name, target in links.items():
            link = root / "repos" / name
            if link.is_symlink() or link.exists():
                link.unlink()
            link.symlink_to(pathlib.Path(target).resolve())
        token_file = root / "token"
        token_file.write_text(token, encoding="utf-8")
        token_file.chmod(0o600)
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
        root=self.path(agent['id']); memory=root/'memory'; memory.mkdir(exist_ok=True)
        selected=(agent.get('options') or {}).get('tools',[])
        plan=plan or (self.tools_plan(agent) if selected else {'skills':{},'reviewed':{}})
        # Only declared wrappers/signatures/cards enter the mind. No donor law,
        # package mount, host plan or native evaluator is exposed to it.
        fragments=['!(import! &self (car-atom (collapse (library OmegaClaw-Core ./src/helper_tools.py))))'] if selected else []
        for skill in plan['skills']:
            fragments.append('(= ('+skill+' $json) (sread (py-call (helper_tools.call '+json.dumps(skill)+' $json))))')
        fragment='\n'.join(fragments)+'\n'
        (memory/'tools-loader.metta').write_text(fragment)
        (memory/'tools-signatures.metta').write_text(''.join('(SkillSignature '+skill+' (Arg rest-text json-arguments))\n' for skill in plan['skills']))
        (memory/'tools-affordance.metta').write_text(''.join('(SkillCardLine '+json.dumps(skill)+' '+json.dumps(skill+' JSON-argument-array; finite synthetic advisory data only')+')\n' for skill in plan['skills']))
        (root/'run.metta').write_text(RUN_METTA.replace('!(omegaclaw)',fragment+'!(omegaclaw)') if selected else RUN_METTA)

    def write_studio_skills(self, agent, on):
        with self._namespace(agent["id"]):
            return self._write_studio_skills(agent, on)

    def _write_studio_skills(self, agent, on):
        """Add (on) or remove (off) the Studio module's import in an omega mind's run.metta, before !(omegaclaw). A file
        already in that state, a mind of another kind or a mind without a run.metta is left untouched (no write)."""
        if agent.get("kind") != "omega":
            return
        run = self.path(agent["id"]) / "run.metta"
        try:
            text = run.read_text(encoding="utf-8")
        except FileNotFoundError:
            return
        has = STUDIO_IMPORT + "\n" in text
        other = [line for line in text.splitlines() if f"modules/{STUDIO_MODULE}/" in line and line != STUDIO_IMPORT]
        if other or text.count(STUDIO_IMPORT) > (1 if has else 0):
            # R6.2 (Kimi #4): never add a second import next to a hand-edited one, nor leave one loading with Studio off
            raise ValueError(f"{run} has a hand-edited {STUDIO_MODULE} import; restore it or remove it, then start again")
        if on and not has and "!(omegaclaw)" in text:
            text = text.replace("!(omegaclaw)", STUDIO_IMPORT + "\n!(omegaclaw)", 1)
        elif not on and has:
            text = text.replace(STUDIO_IMPORT + "\n", "")
        else:
            return
        run.write_text(text, encoding="utf-8")

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
            return {"LANG": "C.UTF-8", "HIVE_API_URL": api_url, "HIVE_TOKEN": token, "HIVE_AGENT_ID": agent["id"],
                    "BASE_URL": f"{api_url.rstrip('/')}/llm/v1", "AI_API_KEY": token, "LLM_MODEL": "hive"}
        memory = memory_dir or str(self.path(agent["id"]) / "memory")
        llm = f"{api_url.rstrip('/')}/llm/v1"
        env = {
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
