; Experimental command syntax membrane declarations.
;
; The command reader loads every src/skill_signatures*.metta file. Keep this
; file as the common orientation layer; organs add their own signature files
; beside it so the syntax membrane remains generic and composable.
;
; Format:
; (SkillSignature command-name (Arg argument-type argument-name) ...)
; (SignatureSpace symbolic-space-name)
; (SignatureLowering command-name lowered-command-name)
; (SignatureShorthand command-name pipe|collapsed (Field argument-type name) ...)
; (SignatureNoActionHead word)
; (SignatureRecoveryHint error-kind "compact recovery hint")

(SignatureNoActionHead no)
(SignatureNoActionHead none)
(SignatureNoActionHead quiet)
(SignatureNoActionHead silence)
(SignatureNoActionHead genuine)
(SignatureNoActionHead waiting)

(SignatureRecoveryHint unknown-head "recover: use wait \"reason\" for prose/no-action, or query-skill-space \"topic\" / choose-skill-for \"situation\" for discovery")
(SignatureRecoveryHint syntax-error "recover: inspect skill-card/explain-skill for the command, after two failures stop this shape")
(SignatureRecoveryHint missing-argument "recover: check required args with skill-card or explain-skill")
(SignatureRecoveryHint unexpected-trailing "recover: quote text args, use the exact arity, or switch to a rest-text discovery skill")
(SignatureRecoveryHint unknown-space "recover: use registered space names such as beliefs, persistent, events, never raw &handles")
(SignatureRecoveryHint metta-syntax "recover: test the MeTTa expression with test-metta before retrying")
(SignatureRecoveryHint invalid-number "recover: use bare numeric values for number args, not words")
(SignatureRecoveryHint pipe-shape "recover: use the exact pipe field count shown by the skill card")
