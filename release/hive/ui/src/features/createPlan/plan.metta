; Create's Make bench (#/program/omegadesign, bench Make): one sentence becomes a plan, the plan's pieces go to whoever
; takes them (any number of teams, specialist minds, capabilities or whole hives), the work shows as it happens with the
; code beside the running page, and at the end the person's one go deploys it. Declared as atoms; screens/lib_screens.metta
; composes them. The board, the questions, the stream, the code beside the running page and the deploy go are islands
; the page draws (features/createPlan/PlanCanvas.tsx); every one of them shows or hides here.
;
; The page states one set of facts for all three screens (features/createPlan/planFacts.ts):
;   flags  can.plan (this hive makes things from a sentence) start.busy plan.stopped plan.blocked plan.installed
;          plan.live (a file is being written or the page has run) can.stop stop.asking plan.unreviewed
;   counts pieces questions.open questions.answered
;   values start (idle or failed)

; ---------- the empty canvas: one sentence
(Screen plan-start "Make something")
(Part plan-start 10 island ((name plan-say)))
(When plan-start 10 (on can.plan))
(Part plan-start 20 notice ((tone bad) (text (words "That didn't start: " (bind start.error)))))
(When plan-start 20 (is start failed))
(Part plan-start 30 note ((text "It plans who makes each piece, builds it with you watching, checks it, asks you when something needs you, and tells you when it's ready to deploy.")))
(When plan-start 30 (on can.plan))
(Part plan-start 40 empty ((icon sparkles) (title "Making from one sentence isn't on this hive yet")
  (body "This hive doesn't plan and build from a sentence. Studio, Code and Flow still work as before.")))
(When plan-start 40 (off can.plan))

; ---------- the plan at work: the sentence and its one Stop, the questions, who takes what, the work, and the live pair
(Screen plan "Making it")
(Part plan 10 island ((name plan-head)))
(Row plan 10 head)
(Part plan 11 buttons ((items ((button "Stop" stop-ask ((variant ghost) (icon stop) (aria "Stop making this")))))))
(Row plan 11 head)
(When plan 11 (on can.stop))
(When plan 11 (off stop.asking))
(Part plan 12 confirm ((text "Stop making this? What's made so far stays here; nothing more is built.") (yes "Stop") (yes_action stop-yes) (no "Keep going") (no_action stop-no)))
(When plan 12 (on can.stop))
(When plan 12 (on stop.asking))
(Part plan 20 notice ((tone warn) (text "Stopped. Nothing more is being built; what was made so far stays here.")))
(When plan 20 (on plan.stopped))
(Part plan 21 notice ((tone warn) (text (words "Waiting on something: " (bind plan.status)))))
(When plan 21 (on plan.blocked))
(Part plan 22 buttons ((items ((button "Make something else" fresh ((variant primary)))))))
(When plan 22 (on plan.stopped))
; questions never hold the rest: they sit above the board and settle once answered
(Part plan 30 island ((name plan-questions)))
(When plan 30 (any ((has questions.open) (has questions.answered))))
(Part plan 40 island ((name plan-board)))
(When plan 40 (has pieces))
(Part plan 41 island ((name plan-forming)))
(When plan 41 (none pieces))
(When plan 41 (off plan.stopped))
(Part plan 50 island ((name plan-stream)))
; beside it on a wide screen: the file being written next to the running page
(Part plan 60 island ((name live-pair) (region_label "The code and the running page")))
(Region plan 60 aside)
(When plan 60 (on plan.live))
(Part plan 61 empty ((icon play) (title "The running page appears here") (region_label "The code and the running page")
  (body "As the first piece is written its code streams in here, and the page runs beside it once it's put together.")))
(Region plan 61 aside)
(When plan 61 (off plan.live))

; ---------- ready: the page large, what was built, and the person's one go
(Screen plan-ready "Ready to deploy")
(Part plan-ready 10 island ((name plan-head)))
(Part plan-ready 15 island ((name plan-questions)))
(When plan-ready 15 (has questions.open))
(Part plan-ready 20 island ((name ready-preview)))
(Part plan-ready 30 island ((name deploy-go)))
(When plan-ready 30 (off plan.installed))
(Part plan-ready 40 notice ((tone info) (text (words "Installed as " (bind installed.name) ". It's in your Apps now."))))
(Row plan-ready 40 installed)
(When plan-ready 40 (on plan.installed))
(Part plan-ready 41 buttons ((items ((button "Open" open-app ((variant primary) (icon external) (aria (words "Open " (bind installed.name)))))))))
(Row plan-ready 41 installed)
(When plan-ready 41 (on plan.installed))
(Part plan-ready 42 buttons ((items ((button "Make something else" fresh ((variant ghost)))))))
(Row plan-ready 42 installed)
(When plan-ready 42 (on plan.installed))
; how it was made, beside the page
(Part plan-ready 50 island ((name plan-stream) (region_label "How it was made")))
(Region plan-ready 50 aside)
