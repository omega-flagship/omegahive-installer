; Home Assistant command syntax declarations.

(SkillSignature observe-house)
(SkillSignature observe-house-full)
(SkillSignature observe-room (Arg rest-text room))
(SkillSignature observe-device (Arg rest-text target))
(SkillSignature observe-house-affordances)
(SkillSignature use-house-affordance (Arg text affordance) (Arg text target) (Arg rest-text context))
(SkillSignature record-house-outcome (Arg text action) (Arg text outcome) (Arg rest-text note))
(SkillSignature house-action-log (Arg number count))
