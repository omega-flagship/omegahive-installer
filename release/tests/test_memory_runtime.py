#!/usr/bin/env python3
"""Regression checks for runtime memory boundary helpers."""

import importlib
import os
import pathlib
import sys
import tempfile
import types
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))


class MemoryRuntimeTests(unittest.TestCase):
    def import_with_memory(self, module_name, memory_dir):
        sys.modules.pop(module_name, None)
        with mock.patch.dict(os.environ, {"OMEGACLAW_MEMORY_DIR": str(memory_dir)}, clear=False):
            return importlib.import_module(module_name)

    def test_context_and_episodes_are_safe_when_live_memory_absent(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            memory_dir = pathlib.Path(tmpdir)
            helper_metta = self.import_with_memory("helper_metta", memory_dir)
            helper_history = self.import_with_memory("helper_history", memory_dir)

            self.assertEqual(helper_metta.context_prompt(), "")
            self.assertEqual(helper_metta.context_history_tail(), "")
            self.assertEqual(
                helper_history.episodes_at("2026-05-17 21:00"),
                "EPISODES-NOT-FOUND 2026-05-17 21:00:00",
            )

    def test_date_only_episodes_returns_recent_index_not_truncated_midnight_blob(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            memory_dir = pathlib.Path(tmpdir)
            history_path = memory_dir / "history.metta"
            history_path.write_text(
                '("2026-05-27 00:01:00"\n'
                ' ((write-file-base64 "/tmp/big" "' + ("A" * 2000) + '"))\n'
                ' "RESULTS: " "ok"\n)\n'
                '("2026-05-27 01:55:14"\n'
                ' "HUMAN_MESSAGE: " WHATSAPP: Quinn: Omega?\n'
                ' ((reply-whatsapp-to "523@lid" "I used 🛉 here"))\n'
                ' "RESULTS: " "ok"\n)\n',
                encoding="utf-8",
            )
            helper_history = self.import_with_memory("helper_history", memory_dir)

            result = helper_history.episodes_at("2026-05-27", k=20, max_chars=1200)

            self.assertIn("EPISODES-ON 2026-05-27", result)
            self.assertIn("2026-05-27 01:55:14", result)
            self.assertIn("🛉", result)
            self.assertIn("<long-token chars=2000>", result)
            self.assertNotIn("EPISODES-CONTEXT-TRUNCATED", result)

    def test_context_history_compacts_skill_declared_payloads_only(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            memory_dir = pathlib.Path(tmpdir)
            helper_metta = self.import_with_memory("helper_metta", memory_dir)
            big_html = "<html>" + ("payload: keep raw history exact " * 120) + "</html>"
            history = (
                '(remember "'
                + ("thought stays visible " * 80)
                + '")\n'
                + f'(write-file "memory/page.html" "{big_html}")\n'
            )
            history_path = memory_dir / "history.metta"
            history_path.write_text(history, encoding="utf-8")

            view = helper_metta.context_history_tail(20000)
            raw = history_path.read_text(encoding="utf-8")

            self.assertIn("thought stays visible", view)
            self.assertIn('(write-file "memory/page.html"', view)
            self.assertIn("<context-omitted-payload", view)
            self.assertIn("raw-history-preserved", view)
            self.assertNotIn(big_html, view)
            self.assertIn(big_html, raw)

    def test_context_history_does_not_compact_command_mentions_inside_strings(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            memory_dir = pathlib.Path(tmpdir)
            helper_metta = self.import_with_memory("helper_metta", memory_dir)
            big_payload = "quoted command mention " * 120
            history = (
                '(remember "literal syntax mention: '
                f'(write-file \"memory/page.html\" \"{big_payload}\")'
                ' should remain thought text")\n'
            )
            history_path = memory_dir / "history.metta"
            history_path.write_text(history, encoding="utf-8")

            view = helper_metta.context_history_tail(20000)

            self.assertIn("literal syntax mention", view)
            self.assertIn(big_payload, view)
            self.assertNotIn("<context-omitted-payload", view)

    def test_current_frame_reads_real_commands_not_quoted_result_payloads(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            memory_dir = pathlib.Path(tmpdir)
            helper_metta = self.import_with_memory("helper_metta", memory_dir)
            history_path = memory_dir / "history.metta"
            history_path.write_text(
                '("2026-05-27 10:00:00"\n'
                ' ((pin "REAL | current task | next action"))\n'
                ' "RESULTS: " "(RESULTS: ((COMMAND_RETURN: ((query _quote_x_quote_) [[_apostrophe_t_apostrophe_, _apostrophe_(pin \\"STALE | quoted result\\")_apostrophe_]]))))"\n'
                ')\n',
                encoding="utf-8",
            )

            frame = helper_metta.context_current_frame(" DO NOT RE-SEND OR SPAM!", "", 1400)

            self.assertIn("latest_pin=REAL | current task | next action", frame)
            self.assertNotIn("STALE | quoted result", frame)
            self.assertIn("view_policy=no interpretation", frame)

    def test_recent_history_uses_whole_entries_with_result_size_markers(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            memory_dir = pathlib.Path(tmpdir)
            helper_metta = self.import_with_memory("helper_metta", memory_dir)
            history_path = memory_dir / "history.metta"
            history_path.write_text(
                '("2026-05-27 10:00:00"\n'
                ' ((query "first"))\n'
                ' "RESULTS: " "' + ("A" * 3000) + '"\n'
                ')\n'
                '("2026-05-27 10:01:00"\n'
                ' ((pin "SECOND | intact"))\n'
                ' "RESULTS: " "ok"\n'
                ')\n',
                encoding="utf-8",
            )

            view = helper_metta.context_recent_history_entries(1800, 2)

            self.assertIn("ENTRY line=1 time=2026-05-27 10:00:00 results=present raw_result_chars=3000", view)
            self.assertIn("ENTRY line=5 time=2026-05-27 10:01:00 results=present raw_result_chars=2", view)
            self.assertIn('((pin "SECOND | intact"))', view)
            self.assertNotIn("A" * 500, view)
            self.assertIn("truncation_policy=drop-oldest-whole-entry", view)

            tiny_view = helper_metta.context_recent_history_entries(360, 2)

            self.assertTrue(tiny_view.startswith("RECENT-HISTORY view_kind=whole-top-level-entries"))
            self.assertNotIn("first", tiny_view)
            self.assertIn("ENTRY line=5 time=2026-05-27 10:01:00", tiny_view)
            self.assertIn("older_entries_omitted=1", tiny_view)

    def test_input_recall_uses_recent_dialogue_topic_for_pronoun_utterance(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            memory_dir = pathlib.Path(tmpdir)
            history_path = memory_dir / "history.metta"
            history_path.write_text(
                '("2026-05-27 10:00:00"\n'
                ' "HUMAN_MESSAGE: " WHATSAPP: FAMILY id=family@lid::m1 at=2026-05-27T10:00:00Z: Maren: I love dogs\n'
                ' ((reply-whatsapp-to "maren" "noted"))\n'
                ' "RESULTS: " "ok"\n'
                ')\n'
                '("2026-05-27 10:01:00"\n'
                ' "HUMAN_MESSAGE: " WHATSAPP: OTHER id=other@lid::m2 at=2026-05-27T10:01:00Z: Rowan: I like tea\n'
                ' ((reply-whatsapp-to "rowan" "heard"))\n'
                ' "RESULTS: " "ok"\n'
                ')\n'
                '("2026-05-27 10:02:00"\n'
                ' "HUMAN_MESSAGE: " WHATSAPP: FAMILY id=family@lid::m3 at=2026-05-27T10:02:00Z: Quinn: Coffee is too bitter for me\n'
                ' ((reply-whatsapp-to "quinn" "heard"))\n'
                ' "RESULTS: " "ok"\n'
                ')\n',
                encoding="utf-8",
            )
            helper_recall = self.import_with_memory("helper_recall", memory_dir)
            embedded = []

            fake_llm = types.SimpleNamespace(
                useLocalEmbedding=lambda text: embedded.append(text) or [0.1, 0.2],
                initLocalEmbedding=lambda: None,
            )
            fake_chroma = types.SimpleNamespace(
                query_with_ids_and_dists=lambda embedding, count: [
                    ("coffee-id", "2026-05-27 10:01:00", "Quinn dislikes bitter coffee", 0.11),
                    ("dogs-id", "2026-05-27 10:00:00", "Maren likes dogs", 0.42),
                ]
            )

            with mock.patch.dict(sys.modules, {"lib_llm_ext": fake_llm, "lib_chromadb": fake_chroma}):
                current = "WHATSAPP: FAMILY id=family@lid::m4 at=2026-05-27T10:03:00Z: Maren: I don't like it"
                view = helper_recall.context_input_recall_text(
                    current,
                    max_items=2,
                    current_time=0,
                )

            self.assertEqual(len(embedded), 2)
            self.assertEqual(embedded[0], current)
            self.assertIn("Maren: I love dogs", embedded[1])
            self.assertIn("Quinn: Coffee is too bitter for me", embedded[1])
            self.assertIn("Maren: I don't like it", embedded[1])
            self.assertNotIn("Rowan: I like tea", embedded[1])
            self.assertIn(
                'DIALOGUE_FRAME view_kind=recent-speaker-turns-no-resolution current_speaker="Maren" current_channel="WHATSAPP:family@lid"',
                view,
            )
            self.assertIn(
                'TURN rel=-2 speaker_relation=same-speaker source="WHATSAPP" channel="WHATSAPP:family@lid" time="2026-05-27 10:00:00" age_seconds=180',
                view,
            )
            self.assertIn('same_speaker_gap_seconds=180 speaker="Maren" text="I don\'t like it"', view)
            self.assertIn("channel_gap_seconds=60 same_speaker_gap_seconds=180", view)
            self.assertIn("Coffee is too bitter for me", view)
            self.assertNotIn("I like tea", view)
            self.assertIn("LANE current_utterance_semantic", view)
            self.assertIn("LANE dialogue_context_semantic", view)

    def test_runtime_memory_files_and_promotion_db_use_configured_memory_dir(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            memory_dir = pathlib.Path(tmpdir)
            helper_metta = self.import_with_memory("helper_metta", memory_dir)
            helper_promotion = self.import_with_memory("helper_promotion", memory_dir)

            report = helper_metta.ensure_runtime_memory_files("persistent agenda beliefs world events activity")
            self.assertIn("created=persistent,agenda,beliefs,world,events,activity", report)
            for name in ("persistent", "agenda", "beliefs", "world", "events", "activity"):
                self.assertTrue((memory_dir / f"{name}.metta").exists())

            helper_promotion.promotion_open_map()
            helper_promotion.promotion_commit()
            helper_promotion.promotion_close_map()
            self.assertTrue((memory_dir / "promotions.db").exists())

    def test_runtime_memory_files_without_names_does_not_choose_policy(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            memory_dir = pathlib.Path(tmpdir)
            helper_metta = self.import_with_memory("helper_metta", memory_dir)

            report = helper_metta.ensure_runtime_memory_files("")

            self.assertIn("created=", report)
            self.assertFalse(any(memory_dir.glob("*.metta")))

    def test_runtime_memory_files_accept_registered_module_names_not_paths(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            memory_dir = pathlib.Path(tmpdir)
            helper_metta = self.import_with_memory("helper_metta", memory_dir)

            report = helper_metta.ensure_runtime_memory_files("dream assume ../escape nested/path")

            self.assertIn("created=dream,assume", report)
            self.assertIn("rejected=../escape,nested/path", report)
            self.assertTrue((memory_dir / "dream.metta").exists())
            self.assertTrue((memory_dir / "assume.metta").exists())
            self.assertFalse((memory_dir.parent / "escape.metta").exists())

    def test_reboot_note_uses_configured_memory_dir(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            memory_dir = pathlib.Path(tmpdir)
            helper_reboot = self.import_with_memory("helper_reboot", memory_dir)

            trace = helper_reboot.prepare_reboot("test restart")

            self.assertIn("REBOOT-CHECK", trace)
            note = memory_dir / "reboot_note.txt"
            self.assertTrue(note.exists())
            self.assertIn("test restart", note.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
