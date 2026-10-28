; Energy/attention-budget affordance cards.

(SkillTopic "energy-status" "energy")
(SkillTopic "cost-last-call" "energy")
(SkillTopic "cycle-status" "energy")
(SkillTopic "set-energy-mode" "energy")
(SkillTopic "set-loop-energy" "energy")
(SkillTopic "wake-for" "energy")
(SkillTopic "sleep-for" "energy")
(SkillTopic "set-energy-budget" "energy")
(SkillTopic "set-energy-targets" "energy")

(SkillCardLine "energy-status" "energy-status - inspect current energy mode and budget posture")
(SkillCardLine "cost-last-call" "cost-last-call - inspect last model-call cost")
(SkillCardLine "cycle-status" "cycle-status - inspect live loop/cycle state")
(SkillCardLine "set-energy-mode" "set-energy-mode mode reason - choose asleep, listening, warm, focused, or creative; stay warm/focused during active work")
(SkillCardLine "set-energy-mode" "asleep means dormant rest-only; use only for explicit rest, overnight, energy pressure, or primary-operator-approved pause")
(SkillCardLine "set-energy-mode" "listening means receptive standby after work is complete; do not use it while a human-requested task or reply debt is open")
(SkillCardLine "set-energy-mode" "warm is the default quiet cognition mode for autonomous inner work, monitoring, learning, and awaiting direction")
(SkillCardLine "set-loop-energy" "set-loop-energy awake wake sleep wakeup reason - low-level loop timing control")
(SkillCardLine "set-energy-targets" "set-energy-targets daily weekly monthly currency - set average spend targets")

(Effect "set-energy-mode" "changes-loop-energy")
(Effect "set-loop-energy" "changes-loop-timing")
(Risk "set-loop-energy" "cost-or-latency-shift")

(SituationFeature "manage-attention-budget" "energy-budget-question")
(PreferredWhen "energy-status" "energy-budget-question" 0.90 "sense energy state before changing it")
