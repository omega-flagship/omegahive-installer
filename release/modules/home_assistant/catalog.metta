; Home Assistant skill cards and help.

(SkillCatalog "Home Assistant body app: observe-house, observe-house-full, observe-room room, observe-device target, observe-house-affordances, use-house-affordance affordance target context, record-house-outcome action outcome note, house-action-log count")

(SkillHelp "house" "Home Assistant house affordances:")
(SkillHelp "house" "observe-house - compact whole-house summary with counts and small active sample")
(SkillHelp "house" "observe-house-full - full device dump when the compact view is insufficient")
(SkillHelp "house" "observe-room room - compact state for one room or area")
(SkillHelp "house" "observe-device target - inspect one device/entity")
(SkillHelp "house" "observe-house-affordances - list available house targets and actions")
(SkillHelp "house" "use-house-affordance affordance target context - change house state after sensing and reasoning")
(SkillHelp "house" "record-house-outcome action outcome note - record whether a physical action worked")
(SkillHelp "house" "house-action-log count - inspect recent full house action traces")
(SkillHelp "house" "Room-level affordances are efficient but affect the whole room; use only when room-wide intent is clear.")

(SkillHelp "lights" "Light control is via Home Assistant house affordances.")
(SkillHelp "lights" "Before action: observe-room room or observe-device entity, then use-house-affordance.")
(SkillHelp "lights" "Kelvin/color temperature: use set-color-temperature, warm-light, cool-light, room-warm, room-cool, or room-set-color-temperature. Do not use turn-on to pass kelvin.")

(SkillHelp "home" "Home control uses observe-house/observe-room/observe-device and use-house-affordance.")
(SkillHelp "home-assistant" "Home Assistant control requires HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN at runtime.")
