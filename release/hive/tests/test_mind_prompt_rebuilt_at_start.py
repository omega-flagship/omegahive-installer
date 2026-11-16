# Purpose: tests that an omega mind's prompt is rebuilt from the hive's current template, role and persona at every
# start, so a prompt fix shipped in an update reaches a mind made before it, and that a start writes no prompt into a
# workspace that has none.
"""A prompt fix reaches minds made before it (tester report 11-13).

The mind prompt said "Use only listed SKILLS", and minds told a tester they lacked permissions for skills they had.
The template was fixed, but memory/prompt.txt, which only the supervisor writes, was written at creation and on a
rename, model or persona change alone, so the tester's existing minds would have kept the old text after updating.

Invented lives: Juno is a mind made by an earlier release, calm and brief.
"""
from hive.supervisor import workspace as ws
from hive.supervisor.drivers import Supervisor
from hive.tests.test_core_api import client  # noqa: F401  (fixture)


class StubDriver:
    """A process driver that starts nothing: the real Supervisor.start runs around it."""

    def __init__(self):
        self.running = {}

    def start(self, agent, env):
        self.running[agent["id"]] = f"stub:{len(self.running) + 1}"

    def stop(self, agent_id):
        self.running.pop(agent_id, None)

    def status(self, agent_id):
        return "running" if agent_id in self.running else "absent"

    def execution(self, agent_id):
        return self.running.get(agent_id)

    def logs(self, agent_id, tail=200):
        return []


def _juno(client):
    hive = client.app.state.hive
    driver = StubDriver()
    sup = Supervisor(hive.settings, drivers={"local": driver, "docker": driver})
    sup.attach(hive)
    sup.env = lambda agent: {}
    juno = client.post("/api/agents", json={"name": "Juno", "kind": "omega", "persona": "Calm and brief."}).json()
    return sup, juno, sup.workspace.path(juno["id"]) / "memory" / "prompt.txt"


def test_a_start_rebuilds_a_minds_prompt_from_the_current_template_role_and_persona(client):
    sup, juno, prompt = _juno(client)
    prompt.parent.mkdir(parents=True, exist_ok=True)
    stale = "You are Juno, a mind made by an earlier release.\nCommand discipline: Use only listed SKILLS.\n"
    prompt.write_text(stale, encoding="utf-8")
    sup.start(juno["id"])
    text = prompt.read_text(encoding="utf-8")
    assert text.startswith(ws.HIVE_BASE_PROMPT.read_text(encoding="utf-8").replace("{name}", "Juno"))
    assert "earlier release" not in text and "\n## Persona\nCalm and brief.\n" in text
    sup.start(juno["id"])
    assert prompt.read_text(encoding="utf-8") == text                     # a second start writes the same prompt


def test_a_start_writes_no_prompt_into_a_workspace_that_has_none(client):
    sup, juno, prompt = _juno(client)
    sup.start(juno["id"])
    assert not prompt.exists()
