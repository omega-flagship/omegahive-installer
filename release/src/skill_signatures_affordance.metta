; Skill affordance signatures.
;
; These expose a small symbolic directory of "what should I use for this?"
; guidance without hiding routing decisions in Python.

(SignatureSpace skills)

(SkillSignature query-skill-space (Arg text topic))
(SkillSignature choose-skill-for (Arg rest-text situation))
(SkillSignature explain-skill (Arg text skill))
(SkillSignature skill-card (Arg text skill))
(SkillSignature skill-suggestions-for (Arg text signal))
(SkillSignature suggest-skill-trigger (Arg text skill) (Arg text signal) (Arg number confidence) (Arg rest-text reason))
(SkillSignature add-skill-trigger (Arg text skill) (Arg text signal) (Arg number confidence) (Arg rest-text reason))
(SkillSignature promote-skill-trigger (Arg text skill) (Arg text signal) (Arg number confidence) (Arg rest-text reason))
(SkillSignature skill-trigger-candidates)
(SkillSignature skill-aliases (Arg text topic))
(SkillSignature suggest-skill-alias (Arg text alias) (Arg text topic) (Arg number confidence) (Arg rest-text reason))
(SkillSignature add-skill-alias (Arg text alias) (Arg text topic) (Arg number confidence) (Arg rest-text reason))
(SkillSignature promote-skill-alias (Arg text alias) (Arg text topic) (Arg number confidence) (Arg rest-text reason))
(SkillSignature skill-alias-candidates)
