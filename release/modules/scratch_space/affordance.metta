; Scratch working-memory affordance cards.

(SkillTopic "scratch-status" "scratch")
(SkillTopic "scratch-add" "scratch")
(SkillTopic "scratch-remove" "scratch")
(SkillTopic "scratch-touch" "scratch")
(SkillTopic "scratch-find" "scratch")
(SkillTopic "scratch-examples" "scratch")
(SkillTopic "scratch-all-with-ttl" "scratch")
(SkillTopic "scratch-pressure" "scratch")
(SkillTopic "scratch-gc" "scratch")
(SkillTopic "scratch-promote" "scratch")
(SkillTopic "promote-scratch" "scratch")

(SkillCardLine "scratch-add" "scratch-add atom ttl - put a provisional MeTTa atom in transient working memory")
(SkillCardLine "scratch-find" "scratch-find pattern - match provisional atoms in &scratch")
(SkillCardLine "scratch-promote" "scratch-promote atom reason - deliberately move a verified draft into durable memory")
(SkillCardLine "scratch-gc" "scratch-gc - run one TTL decay/expiry pass")

(SkillTrigger "scratch-add" "mentions-word:scratch" 0.78 "scratch wording may need transient working memory")
(SkillTrigger "scratch-add" "mentions-word:draft" 0.64 "draft wording may need transient working memory")
(SkillTrigger "scratch-add" "mentions-word:temporary" 0.58 "temporary wording may need transient working memory")

(Risk "scratch-promote" "memory-commit")
(Effect "scratch-add" "transient-atom")
(Effect "scratch-promote" "beliefs-write")
