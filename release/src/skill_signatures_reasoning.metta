; Reasoning command syntax declarations.
; Loaded by helper_command_parser from src/skill_signatures*.metta.

(SkillSignature metta (Arg metta expression))
(SkillSignature test-metta (Arg metta expression))
(SkillSignature run-metta-file (Arg filepath path))
(SkillSignature nal-step (Arg metta premise1) (Arg metta premise2))
(SkillSignature pln-step (Arg metta premise1) (Arg metta premise2))
(SkillSignature nars-query (Arg metta kb) (Arg metta term))
(SkillSignature nars-derive (Arg metta tasks) (Arg metta beliefs))
