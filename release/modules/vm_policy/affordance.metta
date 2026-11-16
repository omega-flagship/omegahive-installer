; VM policy / immune boundary affordance cards.

(SkillTopic "vm-policy-status" "vm-policy")
(SkillTopic "vm-policy-exits" "vm-policy")
(SkillTopic "vm-policy-atoms" "vm-policy")
(SkillTopic "vm-policy-connections" "vm-policy")
(SkillTopic "vm-policy-metrics" "vm-policy")
(SkillTopic "vm-policy-audit" "vm-policy")
(SkillTopic "vm-policy-enforcement-plan" "vm-policy")
(SkillTopic "vm-policy-maintenance-window" "vm-policy")
(SkillTopic "vm-policy-record-exit" "vm-policy")
(SkillTopic "vm-policy-exit-history" "vm-policy")
(SkillTopic "vm-policy-exit-summary" "vm-policy")
(SkillTopic "vm-policy-last-trace" "vm-policy")

(SkillCardLine "vm-policy-status" "vm-policy-status - inspect VM containment boundary")
(SkillCardLine "vm-policy-audit" "vm-policy-audit - report boundary risks and hardening suggestions without changing the system")
(SkillCardLine "vm-policy-record-exit" "vm-policy-record-exit service decision reason - trace an exit decision")

(SkillTrigger "vm-policy-status" "mentions-word:sandbox" 0.78 "sandbox wording may need VM policy status")
(SkillTrigger "vm-policy-audit" "mentions-word:security" 0.70 "security wording may need VM policy audit")
(SkillTrigger "vm-policy-status" "mentions-word:boundary" 0.66 "boundary wording may need VM policy status")
(SkillTrigger "vm-policy-status" "mentions-word:network" 0.52 "network wording may need boundary context")

(Risk "vm-policy-enforcement-plan" "security-policy-change-proposal")
(Effect "vm-policy-record-exit" "boundary-trace")
