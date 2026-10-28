"""The Omega code membrane (modules/code): edits against what the mind read; exact retry after approval."""

import importlib.util
import json
import pathlib

import pytest

SRC = pathlib.Path(__file__).resolve().parents[2] / "modules" / "code" / "src" / "omega_code.py"
spec = importlib.util.spec_from_file_location("omega_code_under_test", SRC)
oc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oc)


class FakeService:
    """Plays OmegaCode: one file, generations, approvals for mutating actions."""

    def __init__(self):
        self.files = {"calc.py": "def add(a, b):\n    return a - b\n"}
        self.generation, self.calls, self.approved = 1, [], set()

    def digest(self, path):
        return "d" + str(abs(hash(self.files[path])))

    def call(self, action, task, repo, payload):
        self.calls.append((action, json.loads(json.dumps(payload))))
        if action in ("workspace", "edit", "run", "verify") and payload.get("approval_id") not in self.approved:
            # OmegaCode's real error shape: "error" is a string, with top-level message and details
            return {"ok": False, "phase": "operation", "http_status": 403,
                    "result": {"error": "approval_required", "message": "exact operation approval required",
                               "details": {"approval_id": f"p_{len(self.calls)}", "skill": f"code-{action}", "binding": {}}}}
        if action == "workspace":
            return {"ok": True, "result": {"id": "ws_1", "generation": self.generation, "tree_digest": "t" + str(self.generation)}}
        if action == "read":
            p = payload["path"]
            return {"ok": True, "result": {"path": p, "content": self.files[p], "digest": self.digest(p), "generation": self.generation, "tree_digest": "t" + str(self.generation)}}
        if action == "edit":
            e = payload["edits"][0]
            if payload["expected_generation"] != self.generation or e["expected_digest"] != self.digest(e["path"]):
                return {"ok": False, "phase": "operation", "http_status": 409, "result": {"error": "stale_workspace", "message": "changed"}}
            self.files[e["path"]] = e["content"]
            self.generation += 1
            return {"ok": True, "result": {"workspace": {"id": "ws_1", "generation": self.generation, "tree_digest": "t" + str(self.generation)}, "change": {}}}
        return {"ok": True, "result": {}}

    def close(self):
        pass


@pytest.fixture()
def svc(tmp_path, monkeypatch):
    s = FakeService()
    monkeypatch.setenv("OMEGACLAW_MEMORY_DIR", str(tmp_path))
    monkeypatch.setattr(oc, "_client", lambda: (s, None))
    oc._save({"goal": "g_1", "repo": "synthetic", "ws": "ws_1", "generation": 1, "tree_digest": "t1", "files": {}, "pending": {}})
    return s


def approve_last(svc, reply):
    approval = reply.split()[1]
    svc.approved.add(approval)
    return approval


def test_edit_needs_a_read_then_approval_then_exact_retry(svc):
    assert oc.replace("calc.py", "a - b ==> a + b").startswith("CODE-READ-FIRST")
    assert "return a - b" in oc.read("calc.py")
    first = oc.replace("calc.py", "return a - b ==> return a + b")
    assert first.startswith("CODE-APPROVAL-NEEDED")
    approval = approve_last(svc, first)
    again = oc.replace("calc.py", "return a - b ==> return a + b")
    assert again.startswith("CODE-CHANGED"), again
    sent = [p for a, p in svc.calls if a == "edit"]
    assert sent[0]["operation_id"] == sent[1]["operation_id"] and sent[1]["approval_id"] == approval
    assert {k: v for k, v in sent[1].items() if k != "approval_id"} == sent[0]
    assert svc.files["calc.py"].endswith("return a + b\n")


def test_a_persons_edit_in_between_makes_the_minds_edit_stale(svc):
    oc.read("calc.py")
    svc.files["calc.py"] = "def add(a, b):\n    return a - b  # checked by Quinn\n"
    svc.generation += 1  # a person saved in the Workbench
    first = oc.replace("calc.py", "return a - b ==> return a + b")
    approve_last(svc, first)
    stale = oc.replace("calc.py", "return a - b ==> return a + b")
    assert stale.startswith("CODE-STALE")
    assert "checked by Quinn" in svc.files["calc.py"]  # never silently overwritten
    assert "checked by Quinn" in oc.read("calc.py")


def test_bad_changes_are_refused_locally(svc):
    oc.read("calc.py")
    assert "bad_change" in oc.replace("calc.py", "return a + b")
    assert "no_unique_match" in oc.replace("calc.py", "nothing like this ==> x")


def test_reads_are_fresh_after_a_persons_edit(svc):
    oc.read("calc.py")
    svc.generation += 3  # people saved several times
    oc.read("calc.py")
    reads = [p for a, p in svc.calls if a == "read"]
    assert all("expected_generation" not in p for p in reads)
    assert oc._load()["files"]["calc.py"]["generation"] == svc.generation


SEMI, LIT = "\u204f", "\\u204f"


def test_semicolons_and_literal_lookalikes_survive_exactly(svc):
    raw = 'x = "a;b"  ; comment\ny = "' + SEMI + '"  # a literal look-alike\nz = 1\n'
    svc.files["calc.py"] = raw
    shown = oc.read("calc.py")
    assert ";" not in shown and LIT in shown
    assert oc.decode(oc.encode(raw)) == raw
    # change only z; everything else, including the literal look-alike and both semicolons, is untouched
    first = oc.replace("calc.py", "z = 1 ==> z = 2" + SEMI + " w = 3")
    approve_last(svc, first)
    assert oc.replace("calc.py", "z = 1 ==> z = 2" + SEMI + " w = 3").startswith("CODE-CHANGED")
    assert svc.files["calc.py"] == raw.replace("z = 1", "z = 2; w = 3")
    # an old text that cuts through an encoded character is refused, not guessed
    oc.read("calc.py")
    assert "no_unique_match" in oc.replace("calc.py", "\\u20 ==> x")
    # a literal look-alike typed back as LIT stays a literal look-alike
    first = oc.replace("calc.py", 'y = "' + LIT + '" ==> y = "' + LIT + LIT + '"')
    approve_last(svc, first)
    oc.replace("calc.py", 'y = "' + LIT + '" ==> y = "' + LIT + LIT + '"')
    assert ('y = "' + SEMI + SEMI + '"') in svc.files["calc.py"]


def test_open_after_approval_retries_exactly(svc, monkeypatch):
    """The live Coder run found this: code-open lost its waiting approval, so the retry asked again."""
    import io
    import urllib.request

    class Reply(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    monkeypatch.setenv("HIVE_API_URL", "http://hive.test")
    monkeypatch.setattr(urllib.request, "urlopen", lambda *a, **k: Reply(json.dumps([{"id": "synthetic", "commit": "c1"}]).encode()))
    first = oc.open_workspace("g_2", "synthetic")
    assert first.startswith("CODE-APPROVAL-NEEDED"), first
    approval = approve_last(svc, first)
    again = oc.open_workspace("g_2", "synthetic")
    assert again.startswith("CODE-OPEN ws_1"), again
    sent = [p for a, p in svc.calls if a == "workspace"]
    assert sent[1]["approval_id"] == approval and {k: v for k, v in sent[1].items() if k != "approval_id"} == sent[0]
    # a different goal never inherits that approval
    assert oc.open_workspace("g_3", "synthetic").startswith("CODE-APPROVAL-NEEDED")


def test_no_mind_skill_reuses_a_reserved_service_operation_name():
    """The live Coder run found this: a skill called code-run was refused by the gate as a non-canonical bound operation."""
    import re
    from hive.core.services import CODE_MUTATING

    module = SRC.parents[1]
    skills = set(re.findall(r'"skill:([\w-]+)"', (module / "module.toml").read_text()))
    skills |= set(re.findall(r"\(Skill ([\w-]+)\)", (module / "entry.metta").read_text()))
    assert skills and not skills & CODE_MUTATING, skills & CODE_MUTATING
