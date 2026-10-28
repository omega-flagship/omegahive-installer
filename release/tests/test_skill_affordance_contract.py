#!/usr/bin/env python3
"""Static contract checks for symbolic skill affordance declarations."""

from __future__ import annotations

import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "src"


def _text(pattern: str) -> str:
    return "\n".join(path.read_text(encoding="utf-8") for path in sorted(SRC.glob(pattern)))


def _help_topics() -> set[str]:
    topics: set[str] = set()
    for match in re.finditer(r'\(SkillHelp\s+"([^"]+)"\s+', _text("skill_catalog*.metta")):
        topics.add(match.group(1))
    return topics


def _context_hints() -> list[tuple[str, str]]:
    return [
        (match.group(1), match.group(2))
        for match in re.finditer(
            r'\(SkillContextHint\s+"([^"]+)"\s+"([^"]+)"\)', _text("skill_catalog*.metta")
        )
    ]


def _affordance_topics() -> set[str]:
    topics: set[str] = set()
    for match in re.finditer(r'\(SkillTopic\s+"[^"]+"\s+"([^"]+)"\)', _text("skill_affordance*.metta")):
        topics.add(match.group(1))
    return topics


def _affordance_signatures() -> set[str]:
    source = (SRC / "skill_signatures_affordance.metta").read_text(encoding="utf-8")
    return set(re.findall(r"\(SkillSignature\s+([^\s()]+)", source))


def _affordance_implementations() -> set[str]:
    source = (SRC / "skills_affordance.metta").read_text(encoding="utf-8")
    return set(re.findall(r"\(=\s+\(([^\s()]+)", source))


class SkillAffordanceContractTests(unittest.TestCase):
    def test_affordance_commands_are_implemented(self):
        self.assertLessEqual(_affordance_signatures(), _affordance_implementations())

    def test_help_topics_are_discoverable_through_affordance_topics(self):
        missing = sorted(_help_topics() - _affordance_topics())
        self.assertEqual(missing, [])

    def test_affordance_declarations_are_loaded_by_composition_after_space_exists(self):
        declaration_files = [
            "skill_affordance_core.metta",
            "skill_affordance_memory.metta",
            "skill_affordance_reasoning.metta",
            "skill_affordance_affordance.metta",
        ]
        organ = (SRC / "skills_affordance.metta").read_text(encoding="utf-8")
        for filename in declaration_files:
            self.assertNotIn(filename, organ)

        for relative in ["src/skills.metta", "lib_omegaclaw_core.metta"]:
            source = (ROOT / relative).read_text(encoding="utf-8")
            organ_index = source.index("skills_affordance.metta")
            for filename in declaration_files:
                self.assertGreater(source.index(filename), organ_index)

    def test_getskills_is_context_bootstrap_not_full_catalogue(self):
        source = (SRC / "skill_catalog.metta").read_text(encoding="utf-8")
        getskills_body = re.search(r"\(=\s+\(getSkills\).*?\n\n\(=", source, re.S)
        self.assertIsNotNone(getskills_body)
        self.assertIn("SkillContextHint", getskills_body.group(0))
        self.assertNotIn("SkillCatalog", getskills_body.group(0))
        self.assertIsNotNone(re.search(r"\(=\s+\(getFullSkills\).*SkillCatalog", source, re.S))

        hints = _context_hints()
        domains = [domain for domain, _line in hints]
        self.assertIn("core", domains)
        self.assertIn("affordance", domains)
        self.assertEqual(len(hints), len(set(hints)))
        self.assertLess(sum(len(line) for _domain, line in hints), 700)

    def test_context_hints_only_reference_loaded_help_topics(self):
        missing = sorted({domain for domain, _line in _context_hints()} - _help_topics())
        self.assertEqual(missing, [])


    def test_pin_is_always_visible_and_has_continuity_schema(self):
        context = "\n".join(line for _domain, line in _context_hints())
        self.assertIn("pin state-continuity", context)

        source = (
            (SRC / "skill_affordance_core.metta").read_text(encoding="utf-8")
            + (SRC / "skill_catalog_core.metta").read_text(encoding="utf-8")
        )
        for expected in [
            'SkillTopic "pin" "continuity"',
            'SkillTopic "pin" "working-memory"',
            'SkillTopic "pin" "agenda"',
            'SkillTopic "pin" "beliefs"',
            'SkillTopic "pin" "persistent"',
            "primary: agenda/<goal>",
            "meta: beliefs/<self-belief> or persistent/<self-model>",
            "not permanent memory",
            "reboot shape",
            "reply-debt",
        ]:
            self.assertIn(expected, source)

    def test_space_merge_atoms_is_symbolic_wrapper_over_transform(self):
        source = (
            (SRC / "skills_space_mutation.metta").read_text(encoding="utf-8")
            + (SRC / "skill_affordance_memory.metta").read_text(encoding="utf-8")
            + (SRC / "skill_catalog_memory.metta").read_text(encoding="utf-8")
        )
        signatures = _text("skill_signatures*.metta")

        for expected in [
            "(= (space-merge-atoms $space $patternstr $replacementstr $reason)",
            '(= (persistent-merge-atoms $patternstr $replacementstr $reason)',
            '(trace-atom "merge-remove" $space $pattern $reason)',
            'SkillTopic "persistent-merge-atoms" "persistent"',
            "EXPERT exact atom merge; prefer persistent-cleanup workflow",
            "persistent-cleanup-candidates limit",
            "persistent-cleanup-propose candidate-id action reason",
            "persistent-cleanup-commit proposal-id",
            "merge same-space duplicates; exact pattern match; saves runtime space; no accept/finalize step",
            "move/rewrite atoms; exact pattern match; no accept/finalize step; use merge tools for same-space duplicates",
            "reviewed-cross-space-rewrite",
            "cleanup-duplicate-persistent-atoms",
            "cleanup-duplicate-same-space-atoms",
            "move-or-archive-atoms-across-spaces",
            "save-runtime-space $space",
        ]:
            self.assertIn(expected, source)
        self.assertIn("(SkillSignature space-merge-atoms", signatures)
        self.assertIn("(SkillSignature persistent-merge-atoms", signatures)
        self.assertIn("(SkillSignature persistent-cleanup-candidates", signatures)
        self.assertIn("(SkillSignature persistent-cleanup-propose", signatures)
        self.assertIn("(SkillSignature persistent-cleanup-commit", signatures)


    def test_pln_affordance_requires_truth_valued_premises(self):
        source = (
            (SRC / "skill_affordance_reasoning.metta").read_text(encoding="utf-8")
            + (SRC / "skill_catalog_reasoning.metta").read_text(encoding="utf-8")
        )
        for expected in [
            "truth-valued PLN statements",
            "((Inheritance A B) (stv f c))",
            "premises must be truth-valued",
            "Best first shape",
            "Do not use OpenCog-style ImplicationLink/InheritanceLink",
            "direct two-premise PLN",
        ]:
            self.assertIn(expected, source)
        self.assertIn("not ImplicationLink", source)
        self.assertNotIn("use PLN atoms such as Inheritance", source)


    def test_image_media_inputs_recall_vision_not_text_file_reading(self):
        body = ((ROOT / "modules" / "sense_vision" / "affordance.metta").read_text(encoding="utf-8") + "\n" + (ROOT / "modules" / "sense_webcam" / "affordance.metta").read_text(encoding="utf-8"))
        imagegen = ((ROOT / "modules" / "media_imagegen" / "affordance.metta").read_text(encoding="utf-8") + "\n" + (ROOT / "modules" / "media_imagegen" / "catalog.metta").read_text(encoding="utf-8"))
        core = (SRC / "skill_affordance_core.metta").read_text(encoding="utf-8")

        for expected in [
            'SkillCardLine "observe-image"',
            'SkillTopic "inspect-image" "vision"',
            'SkillTopic "inspect-image" "photo"',
            'SkillTopic "inspect-webcam" "camera"',
            'SkillTrigger "inspect-image" "mentions-word:image"',
            'SkillTrigger "inspect-image" "mentions-word:imagemessage"',
            'SkillTrigger "inspect-image" "mentions-word:jpg"',
            'SkillTrigger "inspect-image" "mentions-word:png"',
        ]:
            self.assertIn(expected, body)
        self.assertIn("use vision, not text file reading", body)
        self.assertIn("WEBCAM-CAPTURE-FAILED means camera config is unavailable", body)
        self.assertIn("for JPG/PNG/media use inspect-image", core)
        for expected in [
            'SkillTopic "generate-image" "imagegen"',
            'SkillTopic "generate-image" "draw"',
            'SkillAlias "imagegen" "media"',
            'SkillAlias "draw" "media"',
            'SkillTrigger "generate-image" "mentions-word:imagegen"',
            'SkillTrigger "generate-image" "mentions-word:draw"',
            "returns IMAGE-GENERATED path=... artifact_id=...",
        ]:
            self.assertIn(expected, imagegen)

        catalog = ((ROOT / "modules" / "sense_vision" / "catalog.metta").read_text(encoding="utf-8") + "\n" + (ROOT / "modules" / "sense_webcam" / "catalog.metta").read_text(encoding="utf-8"))
        self.assertIn('SkillHelp "vision"', catalog)
        self.assertIn('SkillHelp "image"', catalog)
        self.assertIn("instead of read-file", catalog)



    def test_whatsapp_file_send_cards_disambiguate_primary_and_explicit_routes(self):
        source = (
            (ROOT / "modules" / "channel_whatsapp" / "affordance.metta").read_text(encoding="utf-8")
            + "\n"
            + (ROOT / "modules" / "channel_whatsapp" / "catalog.metta").read_text(encoding="utf-8")
        )

        for expected in [
            "send-file-caption path caption - send a file/image with caption to the current primary/control route",
            "for a different WhatsApp chat use send-whatsapp-file-caption-to jid path caption",
            "send-whatsapp-file-caption-to jid path caption - send a file/image to a specific different WhatsApp chat",
            "jid is route metadata",
            "never caption/body text",
            "use the exact generated path returned by IMAGE-GENERATED",
        ]:
            self.assertIn(expected, source)


    def test_attention_trigger_surface_is_symbolic(self):
        source = (SRC / "skills_affordance.metta").read_text(encoding="utf-8")
        declarations = (SRC / "skill_affordance_affordance.metta").read_text(encoding="utf-8")
        signatures = _affordance_signatures()
        expected = {
            "skill-suggestions-for",
            "suggest-skill-trigger",
            "add-skill-trigger",
            "promote-skill-trigger",
            "skill-trigger-candidates",
            "skill-aliases",
            "suggest-skill-alias",
            "add-skill-alias",
            "promote-skill-alias",
            "skill-alias-candidates",
        }
        self.assertLessEqual(expected, signatures)
        for atom in [
            "SkillTrigger",
            "CandidateSkillTrigger",
            "AttentionSkillSuggestion",
            "SkillRecall",
            "SkillAlias",
            "CandidateSkillAlias",
            "SkillAliasTarget",
        ]:
            self.assertIn(atom, source + declarations)
        self.assertIn('register-space "skill-triggers" &skill_triggers memory', source)
        self.assertIn('register-space-persistence "skill-triggers"', source)
        self.assertIn('(save-runtime-space "skill-triggers")', source)
        self.assertIn("add-atom &skill_triggers", source)
        self.assertNotIn("import helper_command_parser", source)

    def test_skill_recall_uses_symbolic_cards_not_hidden_python_routing(self):
        affordance = (SRC / "skills_affordance.metta").read_text(encoding="utf-8")
        helper = (ROOT / "src" / "helper_skill_recall.py").read_text(encoding="utf-8")

        self.assertIn("(skill-recall $msgnew $msg)", affordance)
        self.assertIn("(match $space (SkillTrigger", affordance)
        self.assertIn("(match $space (SkillCardLine", affordance)
        self.assertIn("helper.input_skill_signals_expr", affordance)
        self.assertNotIn("(SkillTrigger", helper)
        self.assertNotIn("(SkillCardLine", helper)

    def test_affordance_files_do_not_contain_deployment_secrets(self):
        source = _text("skill_affordance*.metta") + _text("skill_catalog_affordance.metta")
        forbidden_patterns = {
            "api token": (
                r"\b(?:" + "|".join(["sk", "g" + "hp", "github" + "_pat"]) + r")_[A-Za-z0-9_\-]{12,}"
            ),
            "private key block": r"BEGIN [A-Z ]*PRIVATE KEY",
            "email address": r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",
            "user home path": r"/(?:home|Users)/[^\s\"()]+",
            "phone-like number": r"\b0\d{10}\b",
        }
        leaked = [name for name, pattern in forbidden_patterns.items() if re.search(pattern, source)]
        self.assertEqual(leaked, [])


if __name__ == "__main__":
    unittest.main()
