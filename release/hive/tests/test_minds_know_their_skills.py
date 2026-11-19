# Purpose: tests that what a mind reads every turn (its SKILLS line and its prompt) and what a person's words recall
# for it (SKILL_RECALL) say what hive-create, an artifact, a view, a revision and web search are each for and when to
# use them, so a mind builds through Create, shows its work in the chat, revises what it saved and looks things up.
"""A mind is told, in its own context, what each hive skill it holds does and when to use it.

On a tester's v0.38 hive their mind made the tic-tac-toe they asked for itself, as a view, then told them to ask Create,
and remade the game from scratch when they asked for a change (17 and 19 Nov). Its prompt told it to save "a
calculator, a planner, a checklist" as a view while hive-create's help called hive-create the one way to make an app,
with a tip calculator as its example, and no trigger brought hive-create's, a revision's or web search's card when a
person said build, change or today's weather; "website" brought publishing's HTML writer.

Invented lives: Rosa runs a bakery swarm whose mind Juno builds them an order form through Create, shows them the
week's plan in the chat, changes the plan when they ask, and looks up flour prices.
"""
import os
import pathlib
import subprocess
import sys
import textwrap

import pytest

from hive.core import views
from hive.supervisor import workspace as ws
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_skills_line_lists_allowed_skills import _juno, _skills_line

ROOT = pathlib.Path(__file__).resolve().parents[2]


def test_the_skills_line_says_when_to_build_show_change_and_look_things_up(client, monkeypatch):
    line = _skills_line(client, monkeypatch, _juno(client))
    create = line[line.index("Build software:"):]
    assert "hive-create" in create.split("Never build it yourself")[0]
    for asked in ("app", "game", "website", "calculator", "a change to one"):
        assert asked in create.split("hive-create")[0], asked
    assert "Never build it yourself, as code or as a view" in create
    show = line[line.index("Show and keep work:"):]
    assert "hive-artifact-create" in show and "drawn under your message" in show
    assert "hive-revision ar_id" in show and "keeps its id" in show and "never a new one for a change" in show
    assert "the chat shows it" in show
    web = line[line.index("Web:"):]
    assert web.index("for anything current") < web.index("web-search") < web.index("web-fetch")
    assert "news" in web and "cite" in web


def _bullet(text, opening):
    [bullet] = [b for b in text.split("\n- ") if b.startswith(opening)]
    return bullet.split("\n\n")[0]


def _view_body(bullet):
    """The MeTTa body of the hive-artifact-create example in a prompt bullet, unescaped as the mind reads it."""
    body = bullet.split('"body":"', 1)[1].split('"}', 1)[0]
    return body.replace('\\"', '"')


def test_the_prompt_sends_an_app_to_create_a_showing_to_a_view_a_change_to_a_revision_and_today_to_the_web():
    text = ws.HIVE_BASE_PROMPT.read_text(encoding="utf-8")
    create = _bullet(text, "Build software through Create:")
    assert "hive-create" in create and "Never build it yourself, as code or as a view" in create
    show = _bullet(text, "To show something in the chat")
    # the view the prompt models shows something: valid view MeTTa, with nothing the person types and nothing worked out
    body = _view_body(show)
    assert views.metta_problem(body) is None and isinstance(views.view_of("view", body), views.MettaView)
    assert "field" not in body and "(= (value" not in body
    change = _bullet(text, "To change something you saved")
    assert "hive-revision ar_id" in change and "keeps the id" in change and "a new artifact starts the work over" in change
    web = _bullet(text, "For anything current")
    assert web.index("web-search") < web.index("web-fetch") and "cite" in web
    # reading the web is no action that needs a person's yes, which the care line used to imply ("leave the hive")
    care = text[text.index("Care:"):].split("\n")[0]
    assert "web-search and web-fetch changes nothing outside" in care
    # the build rule comes before every saving rule, so a mind reads where an app goes first
    assert text.index("Build software through Create:") < text.index("To show something in the chat")


def test_the_view_help_models_a_valid_view_that_shows_a_plan():
    catalog = (ROOT / "modules/hive/catalog.metta").read_text(encoding="utf-8")
    [line] = [l for l in catalog.splitlines() if l.startswith('(SkillHelp "hive-artifact-create" "A view')]
    text = line.split('" "', 1)[1].rsplit('")', 1)[0].replace('\\"', '"')
    forms, at = [], 0
    # Time: one pass over the help line; each declaration is cut at its balancing parenthesis, strings skipped.
    while at < len(text):
        if text.startswith(("(Screen ", "(Part ", "(When ", "(Start ", "(= ("), at):
            depth, end, quoted = 0, at, False
            while True:
                ch = text[end]
                if ch == '"' and text[end - 1] != "\\":
                    quoted = not quoted
                elif not quoted and ch == "(":
                    depth += 1
                elif not quoted and ch == ")":
                    depth -= 1
                    if depth == 0:
                        break
                end += 1
            form = text[at:end + 1]
            if "..." not in form and "$id" not in form:   # the help's own placeholders, not view source
                forms.append(form)
            at = end + 1
        else:
            at += 1
    body = " ".join(forms)
    assert body.startswith('(Screen day "Saturday")') and len(forms) == 10, forms
    assert views.metta_problem(body) is None and isinstance(views.view_of("view", body), views.MettaView)


RECALL = textwrap.dedent(r'''
    import json, os, pathlib, sys, tempfile
    root, petta = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
    sys.path.insert(0, str(petta / "python"))
    sys.path.insert(0, str(root / "hive/runtime/extensions"))
    from petta import PeTTa
    import janus_swi
    from helper_skill_recall import input_skill_signals
    metta = PeTTa(petta_path=str(petta))
    link = pathlib.Path(tempfile.mkdtemp()) / "OmegaClaw-Core"
    link.symlink_to(root, target_is_directory=True)
    janus_swi.query_once("asserta(library_path(Path))", {"Path": str(link)})
    for name in ("skills_runtime_spaces.metta", "skills_affordance.metta"):
        metta.load_metta_file(str(root / "hive/runtime/extensions" / name))
    for module in ("hive", "web_search", "publishing"):
        metta.load_metta_file(str(root / "modules" / module / "affordance.metta"))
    out = {}
    for text in json.loads(sys.argv[3]):
        signals = "(" + " ".join(json.dumps(s) for s in input_skill_signals(text)) + ")"
        out[text] = metta.process_metta_string("!(skill-recall-cards-for-signals " + signals + ")")
    print("RECALL " + json.dumps(out))
''')


def test_a_persons_words_recall_the_card_of_the_skill_they_need():
    # HIVE_TEST_PETTA is what CI's runtime step sets (scripts/ci/runtime-tests.sh); PETTA_PATH serves a local run
    petta = pathlib.Path(os.environ.get("HIVE_TEST_PETTA") or os.environ.get("PETTA_PATH") or str(pathlib.Path.home() / "PeTTa"))
    if not (petta / "src/main.pl").is_file():
        pytest.skip("needs PeTTa")
    asks = {"Build me a tic tac toe app": "hive-create",
            "Make me a website for my bakery": "hive-create",
            "Change it so the tip starts at 20%": "hive-revision",
            "Show me the week's plan as a table": "hive-artifact-create",
            "What's the weather in Oaxaca today?": "web-search",
            "Read https://example.org/flour for me": "web-fetch"}
    import json
    result = subprocess.run([sys.executable, "-c", RECALL, str(ROOT), str(petta), json.dumps(list(asks))],
                            capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    recalled = json.loads(result.stdout.split("RECALL ", 1)[1])
    for text, skill in asks.items():
        [cards] = recalled[text]
        assert f'"{skill}"' in cards, (text, cards)
        # a web page a person asks for is software Create builds, never publishing's HTML writer
        assert '"write-web-page"' not in cards, (text, cards)
