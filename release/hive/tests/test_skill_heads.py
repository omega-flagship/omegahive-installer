"""Purpose: no skill a module gives minds is defined again by the mind's runtime, so one never shadows the other. A
mind's own query was rewritten on a hive to hive-query, the name of the commons skill too, so a mind asking the
commons got its memory recall back (HIVE-QUERY never answered in its trace). It was then named hive-recall, which the
screen's skill of that name (modules/hive, shown beside what a mind showed) answered too once both were in one hive; the
recall is hive-memory-query now. A module declares a skill by its equation in skills.metta and by name in module.toml,
so both are read."""

import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[2]
HEAD = re.compile(r"^\(= \(([^\s()]+)", re.M)
DECLARED = re.compile(r'"skill:([^"]+)"')


def names(paths, pattern):
    out = {}
    for path in paths:
        for name in pattern.findall(path.read_text(encoding="utf-8")):
            out.setdefault(name, set()).add(path.relative_to(ROOT).as_posix())
    return out


def module_skills():
    skills = names(ROOT.glob("modules/*/skills.metta"), HEAD)
    for name, where in names(ROOT.glob("modules/*/module.toml"), DECLARED).items():
        skills.setdefault(name, set()).update(where)
    return skills


def test_no_module_skill_is_defined_again_by_the_minds_runtime():
    skills = module_skills()
    runtime = names((ROOT / "hive/runtime/extensions").glob("*.metta"), HEAD)
    assert "hive-query" in skills and "hive-memory-query" in runtime
    assert {name: sorted(skills[name] | runtime[name]) for name in set(skills) & set(runtime)} == {}


def test_a_minds_own_query_recalls_its_memory_and_no_module_skill_is_rewritten():
    from hive.runtime.hive_services import command_expr
    assert command_expr('(query "green tea")') == '(hive-memory-query "green tea")'
    assert command_expr('(episodes "2026-11-16 09:00")') == '(hive-episodes "2026-11-16 09:00")'
    assert command_expr("(hive-query (Current $s $t $st))") == "(hive-query (Current $s $t $st))"
    assert command_expr("(hive-recall ar_7)") == "(hive-recall ar_7)"
    assert command_expr('(queryx "a")') == '(queryx "a")'
    assert not {"hive-memory-query", "hive-episodes"} & set(module_skills())
