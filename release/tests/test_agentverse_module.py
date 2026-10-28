#!/usr/bin/env python3
"""Regression checks for the optional Agentverse remote-agent module."""

import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import helper_command_parser as parser  # noqa: E402
import helper_metta_syntax as metta  # noqa: E402


def skill_implementation_source():
    files = [ROOT / "src" / "skills.metta"]
    files.extend(sorted((ROOT / "src").glob("skills_*.metta")))
    return "\n".join(path.read_text(encoding="utf-8") for path in files)


class AgentverseModuleTests(unittest.TestCase):
    def test_agentverse_remote_skills_are_modular_optional_surface(self):
        core = (ROOT / "lib_omegaclaw.metta").read_text(encoding="utf-8")
        loader = (ROOT / "modules" / "loader.metta").read_text(encoding="utf-8")
        skills = skill_implementation_source()
        module_entry = (ROOT / "modules" / "agentverse" / "entry.metta").read_text(encoding="utf-8")
        module_skills = (ROOT / "modules" / "agentverse" / "skills.metta").read_text(encoding="utf-8")
        module_impl = (ROOT / "modules" / "agentverse" / "src" / "agentverse_bridge.py").read_text(encoding="utf-8")
        listener_impl = (ROOT / "modules" / "agentverse" / "src" / "agentverse_listener.py").read_text(encoding="utf-8")
        requirements = (ROOT / "requirements.txt").read_text(encoding="utf-8")

        self.assertIn("./modules/loader.metta", core)
        self.assertNotIn("./modules/agentverse/entry.metta", loader)
        self.assertNotIn("./src/agentverse.py", core)
        self.assertIn("(Module omegaclaw.remote.agentverse)", module_entry)
        self.assertIn("(Space agentverse)", module_entry)
        self.assertIn("(RuntimeOrgan \"agentverse\" (initAgentverseOrgan))", module_entry)
        self.assertIn("(Provides omegaclaw.remote.agentverse (Skill agentverse-discover))", module_entry)
        self.assertIn("(Provides omegaclaw.remote.agentverse (Skill agentverse-call))", module_entry)
        self.assertIn("(Provides omegaclaw.remote.agentverse (Skill agentverse-listener-start))", module_entry)
        self.assertIn("(Provides omegaclaw.remote.agentverse (Skill agentverse-inbox))", module_entry)
        self.assertNotIn("(= (agentverse-discover $query)", skills)
        self.assertNotIn("(= (agentverse-register-agent $name $address $schema $capability)", skills)
        self.assertIn("(= (agentverse-discover $query $limit)", module_skills)
        self.assertIn("(= (agentverse-discover $query)", module_skills)
        self.assertIn("(= (agentverse-register-agent $name $address $schema $capability)", module_skills)
        self.assertIn("RemoteAgentAlreadyRegistered", module_skills)
        self.assertIn("(= (agentverse-call $name $payload)", module_skills)
        self.assertIn("agentverse_bridge.agentverse_call", module_skills)
        self.assertIn("(= (agentverse-listener-start)", module_skills)
        self.assertIn("(= (agentverse-inbox)", module_skills)
        self.assertIn("(RemoteAgent $name $address $schema $capability)", module_skills)
        self.assertIn("AgentChatProtocol", module_impl)
        self.assertIn("ChatMessage", module_impl)
        self.assertIn("ChatAcknowledgement", module_impl)
        self.assertIn("AGENTVERSE-ACK", module_impl)
        self.assertIn("AGENTVERSE-QUEUED", module_impl)
        self.assertIn("OMEGACLAW_AGENTVERSE_ENDPOINT", module_impl)
        self.assertIn("chat_protocol_spec", listener_impl)
        self.assertIn("AgentverseInbound", listener_impl)
        self.assertNotIn("TAVILY_SEARCH_AGENT_ADDRESS", module_entry)
        self.assertNotIn("TECHNICAL_ANALYSIS_AGENT_ADDRESS", module_entry)
        self.assertIn("uagents", requirements)

    def test_agentverse_signature_rejects_prose_as_limit(self):
        old_state = (
            parser.SIGNATURE_COMMANDS,
            parser.SIGNATURE_KNOWN_SPACES,
            parser.SIGNATURE_MULTILINE_LOWERING,
            parser.SIGNATURE_NO_ACTION_HEADS,
            parser.SIGNATURE_SHORTHANDS,
            parser.SIGNATURE_RECOVERY_HINTS,
            parser.SIGNATURE_SKILL_CARDS,
            parser.SIGNATURE_PROSE_FALLBACK,
        )
        try:
            parser.reload_signature_commands(ROOT / "modules" / "agentverse" / "signatures.metta")
            cases = {
                'agentverse-discover "weather" 5': '((agentverse-discover "weather" 5))',
                'agentverse-discover "weather forecast"': '((agentverse-discover "weather forecast" 5))',
            }
            for raw, expected in cases.items():
                actual = parser.signature_balance_parentheses(raw)
                self.assertEqual(actual, expected)
                self.assertEqual(metta.test_metta_expression(actual), "METTA-SYNTAX-OK")
            self.assertIn(
                '(syntax-error "agentverse-discover" "limit must be number',
                parser.signature_balance_parentheses('agentverse-discover "weather" report text'),
            )
        finally:
            (
                parser.SIGNATURE_COMMANDS,
                parser.SIGNATURE_KNOWN_SPACES,
                parser.SIGNATURE_MULTILINE_LOWERING,
                parser.SIGNATURE_NO_ACTION_HEADS,
                parser.SIGNATURE_SHORTHANDS,
                parser.SIGNATURE_RECOVERY_HINTS,
                parser.SIGNATURE_SKILL_CARDS,
                parser.SIGNATURE_PROSE_FALLBACK,
            ) = old_state


if __name__ == "__main__":
    unittest.main()
