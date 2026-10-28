; Tiny VM workspace-device affordance cards.

(SkillTopic "vm-status" "vm")
(SkillTopic "vm-boot" "vm")
(SkillTopic "vm-shell" "vm")
(SkillTopic "vm-last-trace" "vm")

(SkillCardLine "vm-status" "vm-status - inspect the tiny VM workspace-device")
(SkillCardLine "vm-shell" "vm-shell command - run a command inside the tiny VM device")

(SkillTrigger "vm-status" "mentions-word:vm" 0.74 "VM wording may need VM status")
(SkillTrigger "vm-status" "mentions-word:linux" 0.62 "Linux wording may need VM status")
(SkillTrigger "vm-shell" "mentions-word:shell" 0.55 "shell wording may need VM shell context")

(Risk "vm-shell" "nested-vm-command")
(Effect "vm-shell" "vm-device-action")
