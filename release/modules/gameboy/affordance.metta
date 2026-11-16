; Game Boy simulation affordance cards.

(SkillTopic "gb-status" "gameboy")
(SkillTopic "gb-load" "gameboy")
(SkillTopic "gb-observe" "gameboy")
(SkillTopic "gb-step" "gameboy")
(SkillTopic "gb-screenshot" "gameboy")
(SkillTopic "gb-save-state" "gameboy")
(SkillTopic "gb-load-state" "gameboy")
(SkillTopic "gb-stop" "gameboy")
(SkillTopic "gb-last-trace" "gameboy")

(SkillCardLine "gb-observe" "gb-observe - inspect current emulator state")
(SkillCardLine "gb-step" "gb-step buttons frames - advance emulator control")
(SkillCardLine "gb-screenshot" "gb-screenshot - capture current emulator frame")

(SkillTrigger "gb-observe" "mentions-word:gameboy" 0.82 "Game Boy wording may need emulator observation")
(SkillTrigger "gb-observe" "mentions-word:pokemon" 0.78 "Pokemon wording may need emulator observation")
(SkillTrigger "gb-observe" "mentions-word:emulator" 0.76 "emulator wording may need simulator observation")
(SkillTrigger "gb-observe" "mentions-word:rom" 0.62 "ROM wording may need emulator state")

(Risk "gb-step" "simulation-action")
(Effect "gb-observe" "game-state-observed")
