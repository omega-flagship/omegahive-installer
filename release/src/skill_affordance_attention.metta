; Attention / immune affordance cards.

(SkillTopic "attention-status" "attention")
(SkillTopic "attention-ledger-status" "attention")
(SkillTopic "attention-scan-persistent" "attention")
(SkillTopic "immune-candidates" "attention")
(SkillTopic "attention-review" "attention")
(SkillTopic "attention-focus" "attention")
(SkillTopic "attention-retire-candidate" "attention")
(SkillTopic "attention-wage" "attention")
(SkillTopic "attention-rent" "attention")
(SkillTopic "ecan-pass" "attention")

(SkillCardLine "attention-status" "attention-status - inspect attention/immune organ state")
(SkillCardLine "immune-candidates" "immune-candidates limit - inspect candidate atoms for cleanup/review")
(SkillCardLine "attention-review" "attention-review hash - inspect one immune candidate before action")
(SkillCardLine "ecan-pass" "ecan-pass target_space mode budget - run a bounded ECAN-style review/action pass")
(SkillCardLine "attention-wage" "attention-wage hash amount reason - give salience credit")
(SkillCardLine "attention-rent" "attention-rent hash amount reason - charge salience rent")

(Risk "ecan-pass" "memory-mutation-if-action-mode")
(Effect "immune-candidates" "cleanup-candidates")
(Effect "attention-wage" "salience-accounting")

