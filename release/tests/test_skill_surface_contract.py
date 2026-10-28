#!/usr/bin/env python3
"""Static contract checks for the agent's skill syntax and help surface."""

from __future__ import annotations

import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


PROLOG_IMPLEMENTED_SKILLS = {
    # shell/1 is provided by src/skills.pl and exposed to MeTTa through the
    # existing Prolog bridge, so it deliberately has no (= (shell ...)) form.
    "shell",
}


def _text(paths):
    return "\n".join(path.read_text(encoding="utf-8") for path in paths if path.exists())


def _metta_lines(text):
    for raw in text.splitlines():
        line = raw.split(";", 1)[0].strip()
        if line:
            yield line


def _skill_signatures():
    source = _text(
        sorted((ROOT / "src").glob("skill_signatures*.metta"))
        + sorted((ROOT / "modules").glob("*/signatures.metta"))
    )
    return {
        match.group(1)
        for line in _metta_lines(source)
        for match in [re.match(r"^\(SkillSignature\s+([^\s()]+)(?:\s|\))", line)]
        if match
    }


def _skill_implementations():
    source = _text(sorted((ROOT / "src").glob("*.metta")) + sorted((ROOT / "modules").glob("*/skills.metta")))
    return set(re.findall(r"\(=\s+\(([A-Za-z0-9_-]+)(?:\s|\))", source))


def _module_provided_skills():
    source = _text(sorted((ROOT / "modules").glob("*/entry.metta")))
    return set(re.findall(r"\(Provides\s+[^\s()]+\s+\(Skill\s+([A-Za-z0-9_-]+)\)\)", source))


def _catalog_and_help_text():
    return _text(sorted((ROOT / "src").glob("skill_catalog*.metta")) + sorted((ROOT / "modules").glob("*/catalog.metta")))


def _skill_help_topics():
    source = _catalog_and_help_text()
    return {
        match.group(1)
        for line in _metta_lines(source)
        for match in [re.match(r'^\(SkillHelp\s+"([^"]+)"\s+', line)]
        if match
    }


def _skill_affordance_topics():
    source = _text(
        sorted((ROOT / "src").glob("skill_affordance*.metta"))
        + [ROOT / "src" / "skills_affordance.metta"]
        + sorted((ROOT / "modules").glob("*/affordance.metta"))
    )
    return {
        match.group(1)
        for line in _metta_lines(source)
        for match in [re.search(r'\(SkillTopic\s+"[^"]+"\s+"([^"]+)"\)', line)]
        if match
    }


class SkillSurfaceContractTests(unittest.TestCase):
    def test_all_declared_skill_signatures_have_a_runtime_implementation(self):
        signatures = _skill_signatures()
        implementations = _skill_implementations() | PROLOG_IMPLEMENTED_SKILLS
        missing = sorted(signatures - implementations)
        self.assertEqual(missing, [])

    def test_module_provided_skills_are_declared_and_implemented(self):
        provided = _module_provided_skills()
        signatures = _skill_signatures()
        implementations = _skill_implementations() | PROLOG_IMPLEMENTED_SKILLS

        self.assertEqual(sorted(provided - signatures), [])
        self.assertEqual(sorted(provided - implementations), [])

    def test_every_skill_signature_has_a_discoverable_help_or_catalog_mention(self):
        catalog = _catalog_and_help_text()
        missing = sorted(name for name in _skill_signatures() if name not in catalog)
        self.assertEqual(missing, [])

    def test_skill_help_topics_have_symbolic_affordance_cards(self):
        help_topics = _skill_help_topics()
        affordance_topics = _skill_affordance_topics()
        missing = sorted(help_topics - affordance_topics)
        self.assertEqual(missing, [])

    def test_web_search_is_canonical_live_web_surface(self):
        signatures = _skill_signatures()
        implementations = _skill_implementations()
        catalog = _catalog_and_help_text()

        self.assertIn("web-search", signatures)
        self.assertIn("web-search", implementations)
        self.assertIn("web-search query", catalog)
        self.assertIn("legacy alias for web-search", catalog)
        self.assertNotIn("tavily-search", signatures)

if __name__ == "__main__":
    unittest.main()
