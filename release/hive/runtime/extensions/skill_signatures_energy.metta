; Energy command syntax declarations.
; Loaded by helper_command_parser from src/skill_signatures*.metta.

(SkillSignature attention-status)
(SkillSignature energy-status)
(SkillSignature start-cycle-practice (Arg rest-text label))
(SkillSignature sleep-for (Arg number seconds) (Arg rest-text reason))
(SkillSignature wake-for (Arg number loops) (Arg rest-text reason))
(SkillSignature set-loop-energy (Arg number awake_loops) (Arg number wake_loops) (Arg number sleep_seconds) (Arg number wakeup_seconds) (Arg rest-text reason))
(SkillSignature set-energy-mode (Arg text mode) (Arg rest-text reason))
(SkillSignature set-energy-budget (Arg number amount) (Arg text currency) (Arg text period))
(SkillSignature set-energy-targets (Arg number daily) (Arg number weekly) (Arg number monthly) (Arg text currency))
