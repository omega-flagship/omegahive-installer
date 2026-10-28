; Energy skill catalog declarations.
; Imported as SkillCatalog / SkillHelp atoms by the core loader.

(SkillCatalog "Energy: energy-status, cost-last-call, cycle-status, set-energy-mode mode reason, wake-for loops reason, sleep-for seconds reason")
(SkillHelp "energy" "Energy affordances:")
(SkillHelp "energy" "energy-status, cost-last-call - inspect spend and provider cost")
(SkillHelp "energy" "cycle-status, start-cycle-practice label")
(SkillHelp "energy" "set-energy-mode mode reason - mode must be asleep, listening, warm, focused, or creative; invalid mode warns and does not change energy")
(SkillHelp "energy" "Mode meanings: warm is default quiet cognition; focused/creative are active work; listening is receptive standby after work is complete; asleep is dormant rest-only")
(SkillHelp "energy" "Do not choose listening/asleep while a human-requested task, live test, open reply debt, or unreported result is active unless the primary operator explicitly pauses it")
(SkillHelp "energy" "set-loop-energy awake_loops wake_loops sleep_seconds wakeup_seconds reason - low-level custom controls")
(SkillHelp "energy" "wake-for loops reason, sleep-for seconds reason")
(SkillHelp "energy" "set-energy-budget amount currency period - set financial allowance target")
(SkillHelp "energy" "set-energy-targets daily weekly monthly currency - set average spend targets the agent can reason over")
