; Purpose: make the app action skill and its resume, after an approval or a lost answer, discoverable.
(SkillTopic "app-act" "apps")
(SkillTopic "app-resume" "apps")
(SkillCardLine "app-act" "app-act JSON - call any app's agent-facing action with {program, action, items?, params?}; host policy decides; results are authority-none data")
(SkillCardLine "app-resume" "app-resume JSON - send the saved request again under its key: {key, approval_id} after a person approves in the hive, or {key} after AppOutcomeUnknown once you have checked whether it took effect")
(Effect "app-act" "requests-app-action-under-host-policy")
(Effect "app-resume" "resends-saved-app-action-under-its-key")
