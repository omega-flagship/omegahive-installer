; Skill affordance catalog.
;
; The affordance organ is a symbolic skill directory. It helps the agent ask which
; body part/module fits a situation while leaving the final choice to the agent.

(SkillContextHint "affordance" "Discovery: skill-help topic, query-skill-space topic, choose-skill-for situation, explain-skill skill, skill-card skill. Use skill-aliases topic when wording misses.")
(SkillCatalog "Affordance: query-skill-space topic, choose-skill-for situation, explain-skill skill, skill-card skill")
(SkillCatalog "Attention triggers: skill-suggestions-for signal, suggest-skill-trigger skill signal confidence reason, promote-skill-trigger skill signal confidence reason, add-skill-trigger skill signal confidence reason, skill-trigger-candidates")
(SkillCatalog "Skill aliases: skill-aliases topic, suggest-skill-alias alias topic confidence reason, promote-skill-alias alias topic confidence reason, add-skill-alias alias topic confidence reason, skill-alias-candidates")
(SkillHelp "affordance" "Skill affordance directory:")
(SkillHelp "affordance" "query-skill-space topic - list skills registered for a topic such as whatsapp, house, memory")
(SkillHelp "affordance" "choose-skill-for situation - return candidate skills with confidence and why for a named situation")
(SkillHelp "affordance" "explain-skill skill - show structured arguments, risks, and effects for a skill")
(SkillHelp "affordance" "skill-card skill - show compact card lines for a skill")
(SkillHelp "affordance" "skill-suggestions-for signal - list skills whose symbolic triggers match an observed signal")
(SkillHelp "affordance" "suggest-skill-trigger skill signal confidence reason - record a candidate attention trigger after a missed affordance")
(SkillHelp "affordance" "promote-skill-trigger skill signal confidence reason - promote a reviewed candidate trigger into active suggestions")
(SkillHelp "affordance" "add-skill-trigger skill signal confidence reason - add an active symbolic trigger directly when already justified")
(SkillHelp "affordance" "skill-trigger-candidates - list candidate triggers waiting for review")
(SkillHelp "affordance" "skill-aliases topic - list active alias topics for a canonical topic, or the canonical topic for an alias")
(SkillHelp "affordance" "suggest-skill-alias alias topic confidence reason - record a candidate wording alias without activating it")
(SkillHelp "affordance" "promote-skill-alias alias topic confidence reason - promote a reviewed candidate alias into active query-skill-space expansion")
(SkillHelp "affordance" "add-skill-alias alias topic confidence reason - add an active symbolic alias directly when already justified")
(SkillHelp "affordance" "skill-alias-candidates - list candidate aliases waiting for review")
(SkillHelp "affordance" "Use this as attention guidance, not automation. It suggests organs; the agent still senses, reasons, chooses, acts, verifies, and remembers.")
