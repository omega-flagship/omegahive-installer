#!/usr/bin/env python3
"""Cross-cutting contract tests for the live OmegaClaw patch set.

These checks are deliberately cheap and mostly static. They protect the
architectural boundaries that are easy to break while working quickly:
canonical-first persistence, core/body separation, dual mutation review,
private runtime state exclusion, and optional dependency disclosure.
"""

from __future__ import annotations

import importlib.util
import pathlib
import py_compile
import re
import subprocess
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


def read(relpath: str) -> str:
    return (ROOT / relpath).read_text(encoding="utf-8")


def skill_implementation_source() -> str:
    files = [ROOT / "src" / "skills.metta"]
    files.extend(sorted((ROOT / "src").glob("skills_*.metta")))
    files.extend(sorted((ROOT / "modules").glob("*/skills.metta")))
    return "\n".join(path.read_text(encoding="utf-8") for path in files if path.exists())


def form_body(text: str, name: str) -> str:
    match = re.search(rf"^\(= \({re.escape(name)}(?:\s|\))", text, flags=re.MULTILINE)
    if match is None:
        raise ValueError(f"MeTTa form not found: {name}")
    start = match.start()
    next_form = text.find("\n(= ", start + 1)
    return text[start:] if next_form < 0 else text[start:next_form]


class PatchBoundaryContractTests(unittest.TestCase):
    def test_python_and_js_sources_are_syntax_checkable_without_network(self):
        paths = [
            path
            for folder in ("src", "channels", "tests")
            for path in (ROOT / folder).rglob("*.py")
            if "__pycache__" not in path.parts
        ]
        with tempfile.TemporaryDirectory() as cache_dir:
            for idx, path in enumerate(paths):
                with self.subTest(path=path.relative_to(ROOT)):
                    cfile = pathlib.Path(cache_dir) / f"{idx}.pyc"
                    py_compile.compile(str(path), cfile=str(cfile), doraise=True)

        bridge = ROOT / "channels" / "whatsapp_bridge" / "bridge.mjs"
        if not bridge.exists():
            self.skipTest("WhatsApp bridge is not present in this checkout")
        result = subprocess.run(
            ["node", "--check", str(bridge)],
            cwd=str(ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=20,
        )
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_core_body_split_keeps_devices_out_of_cognitive_substrate(self):
        core = read("lib_omegaclaw_core.metta")
        body = read("lib_omegaclaw_body.metta")
        assume = read("modules/assume/entry.metta")
        attention = read("lib_omegaclaw_attention.metta")

        default_body_organs = [
            "./modules/media_imagegen/entry.metta",
            "./modules/media_videogen/entry.metta",
            "./modules/sense_vision/entry.metta",
            "./modules/sense_webcam/entry.metta",
            "./modules/sense_audio/entry.metta",
            "./modules/channel_web_control/entry.metta",
            "./modules/channel_router/entry.metta",
        ]
        optional_body_organs = [
            "./modules/home_assistant/entry.metta",
            "./modules/health_glucose/entry.metta",
            "./modules/channel_whatsapp/entry.metta",
        ]
        loader = read("modules/loader.metta")
        for organ in default_body_organs:
            with self.subTest(organ=organ):
                self.assertNotIn(organ, core)
                self.assertIn(organ, loader)
        for organ in optional_body_organs:
            with self.subTest(optional_organ=organ):
                self.assertNotIn(organ, core)
                self.assertNotIn(organ, loader)
        self.assertIn("./modules/loader.metta", body)

        self.assertIn("./src/energy.py", core)
        for organ in ("./modules/assume/src/assume.py", "./modules/assume/src/assume_client.py", "./modules/assume/skills.metta"):
            with self.subTest(assume_organ=organ):
                self.assertNotIn(organ, core)
                self.assertIn(organ, assume)
        for organ in ("./src/attention_ledger.py", "./src/skills_attention.metta"):
            with self.subTest(attention_organ=organ):
                self.assertNotIn(organ, core)
                self.assertIn(organ, attention)

        self.assertNotIn("&assume", core)
        self.assertNotIn("&attention", core)
        self.assertIn("!(bind! &assume (new-space))", assume)
        self.assertIn("!(bind! &assume_work (new-space))", assume)
        self.assertIn("!(bind! &attention (new-space))", attention)
    def test_skill_catalog_is_import_local_not_filesystem_global(self):
        catalog = read("src/skill_catalog.metta")
        affordance_skills = read("src/skills_affordance.metta") + read("src/skill_affordance_affordance.metta")
        core = read("lib_omegaclaw_core.metta")
        assume = read("modules/assume/entry.metta")
        attention = read("lib_omegaclaw_attention.metta")
        body = read("lib_omegaclaw_body.metta")

        self.assertIn("(match &self (SkillCatalog $line) $line)", catalog)
        self.assertIn("(match &self (SkillHelp $topic $line) $line)", catalog)
        self.assertIn("(repr $topic)", catalog)
        self.assertIn("(match &self (SkillHelp $symbol $line) $line)", catalog)
        self.assertNotIn("SkillHelpAlias", catalog)
        self.assertIn("list_to_set", catalog)
        self.assertNotIn("helper.skill_catalog", catalog)
        self.assertNotIn("helper.skill_help", catalog)
        self.assertIn('SkillTopic "query-skill-space" "skills"', affordance_skills)
        self.assertIn("(repr $topic)", affordance_skills)
        self.assertIn("(repr $situation)", affordance_skills)
        self.assertIn("(repr $skill)", affordance_skills)
        self.assertIn("skill-topic-cards-normalized &self", affordance_skills)
        self.assertIn("skill-topic-cards-via-alias-normalized &self", affordance_skills)
        self.assertIn("append (append (skill-topic-cards-normalized &skills", affordance_skills)

        self.assertIn("skill_catalog_core.metta", core)
        self.assertIn("skill_catalog_memory.metta", core)
        self.assertIn("skills_runtime_spaces.metta", core)
        self.assertIn("skill_catalog_energy.metta", core)
        self.assertIn("skill_catalog_reasoning.metta", core)
        self.assertNotIn("modules/assume/catalog.metta", core)
        self.assertNotIn("skill_catalog_attention.metta", core)
        self.assertNotIn("skill_catalog_body.metta", core)

        self.assertIn("modules/assume/catalog.metta", assume)
        self.assertIn("skill_catalog_attention.metta", attention)
        loader = read("modules/loader.metta")
        self.assertIn("modules/sense_vision/entry.metta", loader)
        self.assertIn("modules/channel_router/entry.metta", loader)
        self.assertIn("modules/publishing/entry.metta", loader)
        self.assertNotIn("modules/gameboy/entry.metta", loader)
        self.assertNotIn("modules/omega_vm/entry.metta", loader)
        self.assertNotIn("skill_catalog_web.metta", body)

    def test_skill_help_topics_are_string_canonical(self):
        catalog_paths = list((ROOT / "src").glob("skill_catalog*.metta"))
        catalog_paths.extend(sorted((ROOT / "modules").glob("*/catalog.metta")))
        symbol_topics = []
        for path in catalog_paths:
            for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                stripped = line.split(";", 1)[0].strip()
                if re.match(r"^\(SkillHelp\s+[^\"()\s]+(?:\s|$)", stripped):
                    symbol_topics.append(f"{path.relative_to(ROOT)}:{line_number}:{stripped}")
        self.assertEqual(symbol_topics, [])

    def test_local_runtime_state_and_credentials_are_excluded_by_ignore_rules(self):
        ignore = read(".gitignore")
        required_patterns = [
            "memory/chroma_db/",
            ".env",
            "memory/*.metta",
            "memory/*.jsonl",
            "memory/runtime/",
            "memory/*.db",
            "memory/web/public/",
            "channels/whatsapp_bridge/node_modules/",
            "channels/whatsapp_bridge/auth*/",
            "memory/home_assistant.json",
        ]
        for pattern in required_patterns:
            with self.subTest(pattern=pattern):
                self.assertIn(pattern, ignore)

    def test_runtime_loop_does_not_dump_full_prompt_to_terminal(self):
        loop = read("src/loop.metta")
        self.assertIn("(CHARS_SENT: (string_length $send))", loop)
        self.assertNotIn("(CHARS_SENT: (string_length $send) $send)", loop)

    def test_clean_boot_listens_without_spending_llm_turns(self):
        loop = read("src/loop.metta")
        init_loop = form_body(loop, "initLoop")
        self.assertIn("(configure maxNewInputLoops 12)", init_loop)
        self.assertIn("(change-state! &loops 0)", init_loop)
        self.assertNotIn("(change-state! &loops (get-state &maxNewInputLoops))", init_loop)

    def test_ignored_runtime_memory_files_are_loaded_by_runtime_not_source_imports(self):
        libs = "\n".join(
            read(path)
            for path in [
                "lib_omegaclaw.metta",
                "lib_omegaclaw_core.metta",
                "lib_omegaclaw_attention.metta",
            ]
        )
        memory = read("src/memory.metta")
        attention = read("src/skills_attention.metta")
        helper = read("src/helper_metta.py")
        runtime_spaces = read("src/skills_runtime_spaces.metta")

        self.assertNotRegex(libs, r"!\(import! &[a-z_]+ \./repos/OmegaClaw-Core/memory/[a-z_]+\.metta\)")
        for space in ("persistent", "agenda", "beliefs", "world", "events", "activity"):
            self.assertIn(f"!(bind! &{space} (new-space))", libs)
            self.assertIn(
                f'(register-space-persistence "{space}" (memory-file "{space}.metta") runtime-state)',
                runtime_spaces,
            )
        self.assertIn("(register-default-runtime-spaces)", memory)
        self.assertIn("(load-runtime-spaces-by-role memory)", memory)
        self.assertIn('(register-space-persistence "attention" (memory-file "attention.metta") runtime-state)', libs)
        self.assertIn('(load-runtime-space "attention")', attention)
        self.assertIn("def ensure_runtime_memory_files", helper)
        self.assertIn("def memory_file", helper)
        self.assertNotRegex(libs + runtime_spaces + memory, r"OmegaClaw-Core \./memory/")
        self.assertNotIn('allowed = {"persistent"', helper)
        self.assertNotIn("_DEFAULT_RUNTIME_MEMORY_NAMES", helper)

    def test_assume_skills_are_canonical_first_before_live_space_mutation(self):
        skills = skill_implementation_source()

        demo = form_body(skills, "assume-import-demo")
        self.assertLess(demo.index("persist_demo_result"), demo.index("assume-atomize-bundle &assume"))

        for name, atom_type in [
            ("assume-init-situation", "persist_structural_atom_result"),
            ("assume-add-context-feature", "persist_structural_atom_result"),
            ("assume-add-action", "persist_structural_atom_result"),
            ("assume-add-feature-edge", "persist_structural_atom_result"),
            ("assume-outcome", "persist_evidence_atom_result"),
            ("assume-error", "persist_evidence_atom_result"),
        ]:
            with self.subTest(skill=name):
                body = form_body(skills, name)
                self.assertLess(body.index(atom_type), body.index("add-atom &assume"))

        writeback = form_body(skills, "assume-apply-writeback")
        self.assertLess(writeback.index("commit_writeback_delta_result"), writeback.index("assume-apply-writeback-edge"))
        self.assertIn("AssumeWritebackCommitSucceeded", writeback)
        self.assertIn("AssumeWritebackApplied", writeback)

    def test_core_loop_initializes_runtime_organs_without_body_coupling(self):
        loop = read("src/loop.metta")
        core_skills = read("src/skills_core.metta")
        runtime_spaces = read("src/skills_runtime_spaces.metta")
        reasoning_spaces = read("src/skills_reasoning_spaces.metta")
        assume_lib = read("modules/assume/entry.metta")
        scratch = read("modules/scratch_space/entry.metta")
        body_container = read("modules/body_container/entry.metta")
        body_container_skills = read("modules/body_container/skills.metta")
        vm_policy = read("modules/vm_policy/entry.metta")
        vm_policy_skills = read("modules/vm_policy/skills.metta")

        self.assertIn("(initRuntimeOrgans)", loop)
        self.assertIn("(RuntimeOrgan $name $call)", loop)
        self.assertIn("(runtime-organ-trusted $name)", loop)
        self.assertIn("(run-runtime-hooks cycle)", loop)
        self.assertIn("(bound-runtime-spaces-by-role memory)", loop)
        self.assertNotIn("(scratch-gc)", loop)
        self.assertNotIn("(bound-space! &scratch", loop)
        self.assertNotIn("(initBody))", loop)
        self.assertNotIn("(= (initRuntimeOrgans)", core_skills)
        self.assertIn("(= (bound-runtime-spaces-by-role $role)", runtime_spaces)
        self.assertIn("(= (load-runtime-spaces-by-role $role)", runtime_spaces)
        self.assertIn("(= (space-registry-entry $name)", runtime_spaces)
        self.assertIn("(= (register-runtime-hook $phase $name $call)", reasoning_spaces)
        self.assertIn("(= (trust-runtime-organ $name)", reasoning_spaces)
        self.assertIn("(= (trust-runtime-hook $phase $name)", reasoning_spaces)
        self.assertIn("(= (runtime-organ-trusted $name)", reasoning_spaces)
        self.assertIn("(= (runtime-hook-trusted $phase $name)", reasoning_spaces)
        self.assertIn("(= (run-runtime-hooks $phase)", reasoning_spaces)
        self.assertIn("(RuntimeHookRejected $phase $name untrusted)", reasoning_spaces)
        self.assertIn('(RuntimeOrgan "assume" (initAssumeOrgan))', assume_lib)
        self.assertIn('(TrustedRuntimeOrgan "assume")', assume_lib)
        self.assertIn("(= (initAssumeOrgan)", assume_lib)
        self.assertNotIn("(= (initRuntimeOrgans)", assume_lib)
        self.assertIn("(RuntimeHook response scratch-space (scratch-gc))", scratch)   # decays per thinking step, not per idle tick
        self.assertIn('(TrustedRuntimeOrgan "scratch-space")', scratch)
        self.assertIn("(TrustedRuntimeHook response scratch-space)", scratch)
        self.assertIn('(RuntimeOrgan "body-container" (initBodyContainerOrgan))', body_container)
        self.assertIn('(TrustedRuntimeOrgan "body-container")', body_container)
        self.assertIn("(= (initBodyContainerOrgan)", body_container_skills)
        self.assertIn('(RuntimeOrgan "vm-policy" (initVMPolicyOrgan))', vm_policy)
        self.assertIn('(TrustedRuntimeOrgan "vm-policy")', vm_policy)
        self.assertIn("(= (initVMPolicyOrgan)", vm_policy_skills)

    def test_prompt_context_reads_promoted_memory_without_side_effects(self):
        loop = read("src/loop.metta")
        memory = read("src/memory.metta")
        promoted = form_body(memory, "promoted-memory-hints")

        self.assertIn("PROMOTED_MEMORY_HINTS", loop)
        self.assertIn("(promoted-memory-hints)", loop)
        self.assertNotIn("MOST_PROMOTED_MEMORIES", loop)
        self.assertNotIn("write-file", promoted)
        self.assertNotIn("append-file", promoted)

    def test_llm_provider_energy_accounting_is_optional_body_hook(self):
        provider = read("lib_llm_ext.py")

        self.assertNotIn("import energy", provider.splitlines())
        self.assertIn("import energy as _energy", provider)
        self.assertIn("def _log_provider_call", provider)

    def test_assume_mutation_reports_have_dual_fabric_and_symbolic_review_surface(self):
        fabricd = read("modules/assume/src/assume_fabricd.py")
        skills = skill_implementation_source()
        review = read("docs/review/assume-fabric-demo-review.md")

        fabric_atoms = [
            "AssumeWeightMutation",
            "AssumeWeightDelta",
            "AssumeMutationTarget",
            "AssumeMutationSignedError",
            "AssumeMutationEvidence",
            "AssumeMutationPressurePrimitive",
            "AssumeMutationConflictPrimitive",
            "AssumeMutationTopology",
            "AssumeAdjustmentPressure",
            "AssumeFabricMutationTruth",
            "AssumeFabricMutationVerdict",
            "AssumeFabricMutationReason",
        ]
        for atom in fabric_atoms:
            with self.subTest(atom=atom):
                self.assertIn(atom, fabricd)

        symbolic_atoms = [
            "assume-observe-writeback",
            "assume-review-mutation",
            "assume-adjustment-direction-ok",
            "assume-symbolic-mutation-truth",
            "AssumeSymbolicMutationTruth",
            "AssumeSymbolicMutationVerdict",
            "AssumeSymbolicMutationReason",
            "AssumeMutationVerdictComparison",
        ]
        for atom in symbolic_atoms:
            with self.subTest(atom=atom):
                self.assertIn(atom, skills)
                self.assertIn(atom, review)

    def test_assume_dependency_boundary_is_documented_and_tests_are_skip_safe(self):
        client = read("modules/assume/src/assume_client.py")
        fabricd = read("modules/assume/src/assume_fabricd.py")
        docs = (
            read("demos/assume/README.md")
            + read("docs/review/assume-fabric-demo-review.md")
            + read("docs/review/dependency-boundary-audit.md")
        )
        tests = read("tests/test_assume_fabricd.py") + read("tests/test_assume_demo_space.py")

        self.assertIn("FABRICPC_REPO", client)
        self.assertIn("FABRICPC_PYTHON", client)
        self.assertIn("import jax", fabricd)
        self.assertIn("import optax", fabricd)
        self.assertIn("from fabricpc", fabricd)
        self.assertIn("FABRICPC_REPO", docs)
        self.assertIn("FABRICPC_PYTHON", docs)
        self.assertIn("@unittest.skipUnless(FABRIC_PYTHON.exists()", tests)

    def test_docs_name_current_skill_catalog_and_organs(self):
        docs = "\n".join(
            read(path)
            for path in [
                "docs/tutorial-03-writing-a-custom-skill.md",
                "docs/reference-internals-extension-points.md",
                "docs/tutorial-06-remote-agentverse-skills.md",
                "docs/reference-skills-reasoning.md",
                "docs/reference-skills-memory.md",
                "docs/reference-skills-io.md",
                "docs/reference-skills-remote-agents.md",
                "docs/review/clean-patch-boundary.md",
                "docs/review/dependency-boundary-audit.md",
                "modules/assume/README.md",
            ]
        )
        self.assertIn("src/skill_catalog.metta", docs)
        self.assertIn("src/skills_core.metta", docs)
        self.assertIn("src/skills_memory.metta", docs)
        self.assertIn("modules/assume/skills.metta", docs)
        self.assertNotIn("getSkills` (`src/skills.metta`)", docs)
        self.assertNotIn("inside the `getSkills` list", read("docs/tutorial-03-writing-a-custom-skill.md"))

    def test_metta_smoke_runner_classifies_safe_and_risky_surfaces(self):
        spec = importlib.util.spec_from_file_location(
            "run_metta_smokes", ROOT / "tests" / "run_metta_smokes.py"
        )
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)

        isolated = module.classify(ROOT / "tests" / "assume_fabricd_skill_smoke.metta")
        self.assertTrue(isolated.isolated)
        self.assertIn("mutates-assume", isolated.reasons)

        risky_path = ROOT / "tests" / "attention_ledger_smoke.metta"
        if not risky_path.exists():
            self.skipTest("attention_ledger_smoke.metta is not present in this checkout")
        risky = module.classify(risky_path)
        self.assertFalse(risky.isolated)
        self.assertIn("imports-full-runtime", risky.reasons)
        self.assertIn("mutates-persistent", risky.reasons)

    def test_review_audit_is_git_aware_and_avoids_runtime_secret_trees(self):
        audit = read("docs/review/review_audit.py")

        self.assertIn('run_git(["ls-files"])', audit)
        self.assertIn('run_git(["ls-files", "--others", "--exclude-standard"])', audit)
        self.assertIn('"channels/whatsapp_bridge/auth"', audit)
        self.assertIn('"node_modules"', audit)
        self.assertNotIn("os.walk", audit)
        self.assertNotIn(".rglob(\"*\")", audit)

    def test_module_contract_keeps_manifest_secondary_to_metta_surface(self):
        docs = read("docs/reference-omegaclaw-module-contract.md")
        entry = read("tests/fixtures/modules/whatsapp_channel/entry.metta")
        manifest = read("tests/fixtures/modules/whatsapp_channel/module.toml")

        self.assertIn("The cognitive contract must be expressed in MeTTa atoms", docs)
        self.assertIn("(Module omegaclaw.channel.whatsapp)", entry)
        self.assertIn("(Provides omegaclaw.channel.whatsapp (Skill send-channel))", entry)
        self.assertIn("(ChannelCapability whatsapp file-send)", entry)
        self.assertIn("(TraceWrites omegaclaw.channel.whatsapp ChannelMessageReceived)", entry)
        self.assertIn('id = "omegaclaw.channel.whatsapp"', manifest)
        self.assertIn("runtime_state = true", manifest)


    def test_loop_dispatches_parsed_commands_without_superpose_side_effects(self):
        loop = read("src/loop.metta")

        self.assertIn("(configure LLM gpt-5.4)", loop)
        self.assertIn("(configure provider OpenAI)", loop)
        self.assertNotIn("(and (> $k 1) $msgnew)", loop)
        self.assertIn("($_ (if $msgnew", loop)
        self.assertIn("(= (command-results $items)", loop)
        self.assertIn("($cmd (car-atom $items))", loop)
        self.assertIn("(reduce $cmd)", loop)
        self.assertIn("(COMMAND_RETURN: ($cmd $result))", loop)
        self.assertNotIn("superpose $sexpr", loop)
        self.assertIn("($results (RESULTS: (command-results $sexpr)))", loop)

    def test_optional_organs_use_canonical_single_library_imports(self):
        files = [
            "run.metta",
            "lib_omegaclaw_attention.metta",
            "modules/publishing/entry.metta",
            "modules/body_container/entry.metta",
            "modules/gameboy/entry.metta",
            "modules/omega_vm/entry.metta",
            "modules/codex_code/entry.metta",
        ]
        for relpath in files:
            with self.subTest(file=relpath):
                content = read(relpath)
                self.assertNotRegex(content, r"!\(import! &self \(library OmegaClaw-Core")
                if "OmegaClaw-Core" in content:
                    self.assertIn("!(import! &self (car-atom (collapse (library OmegaClaw-Core", content)


if __name__ == "__main__":
    unittest.main(verbosity=2)
