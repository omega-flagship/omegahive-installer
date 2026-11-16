; Attention command syntax declarations.
; Loaded by helper_command_parser from src/skill_signatures*.metta.

(SignatureSpace attention)

(SkillSignature attention-ledger-status)
(SkillSignature attention-scan-persistent (Arg number limit))
(SkillSignature attention-review (Arg text hash))
(SkillSignature attention-retire-candidate (Arg text hash) (Arg rest-text reason))
(SkillSignature attention-wage (Arg text hash) (Arg number amount) (Arg rest-text reason))
(SkillSignature attention-rent (Arg text hash) (Arg number amount) (Arg rest-text reason))
(SkillSignature attention-focus (Arg number limit))
(SkillSignature immune-candidates (Arg number limit))
(SkillSignature attention-native-candidates)
(SkillSignature attention-reload)
(SkillSignature ecan-pass (Arg space target) (Arg text mode) (Arg number budget))
