; Purpose: compose Create's Make bench, from one sentence to the deployed app and every change made to it after.
;
; Create's Make bench (#/program/omegadesign, bench Make): one sentence becomes a plan, the plan's pieces go to whoever
; takes them (any number of teams, specialist minds, capabilities or whole hives), the work shows as it happens with the
; code beside the running page, and at the end the person's one go deploys it. Declared as atoms; screens/lib_screens.metta
; composes them. The board, the questions, the stream, the code beside the running page and the deploy go are islands
; the page draws (features/createPlan/PlanCanvas.tsx); every one of them shows or hides here.
;
; Once deployed, the app is changed in place: the person asks for a change, a later round on the same plan builds it from
; what the app is now, checks it and asks the go again; every deployed round is a version they can put back, and Undo
; puts back the version the current one was made from.
;
; The page states one set of facts for all three screens (features/createPlan/planFacts.ts):
;   flags  can.plan (this hive makes things from a sentence) start.busy plan.stopped plan.blocked plan.installed
;          plan.live (a file is being written or the page has run) can.stop stop.asking plan.unreviewed
;          plan.held (a build held on the person or the hive that the empty canvas does not show)
;          plan.leavable (this build is held on the person or the hive, so the empty canvas would name it: planModel.isHeld)
;          plan.changing (a later round is at work on the installed app) can.revise (the hive changes a made app in
;          place) revise.refused (it can't take a change just now) can.undo
;   counts pieces questions.open questions.answered revisions made (the apps the person made, on the empty canvas)
;   values start (idle or failed)

; ---------- the empty canvas: one sentence
(Screen plan-start "Make something")
(Part plan-start 10 island ((name plan-say)))
(When plan-start 10 (on can.plan))
; a build left held (Make something else while it waited): one way back to the newest one, its question intact
(Part plan-start 15 note ((text (words "Waiting for you: “" (bind held.sentence) "”"))))
(Row plan-start 15 held)
(When plan-start 15 (on plan.held))
(Part plan-start 16 buttons ((items ((button "Open it" open-held ((variant ghost) (aria (words "Open “" (bind held.sentence) "”"))))))))
(Row plan-start 16 held)
(When plan-start 16 (on plan.held))
(Part plan-start 20 notice ((tone bad) (text (words "That didn't start: " (bind start.error)))))
(When plan-start 20 (is start failed))
(Part plan-start 30 note ((text "It plans who makes each piece, builds it with you watching, checks it, asks you when something needs you, and tells you when it's ready to deploy.")))
(When plan-start 30 (on can.plan))
(Part plan-start 40 empty ((icon sparkles) (title "Making from one sentence isn't on this hive yet")
  (body "This hive doesn't plan and build from a sentence. Studio, Code and Flow still work as before.")))
(When plan-start 40 (off can.plan))
; the apps the person made: any of them opens here to be changed from what it is now, its versions and Undo with it
(Part plan-start 50 section ((title "Or change something you made") (body "Open one to ask for a change, see its versions or undo its last change.")))
(When plan-start 50 (on can.plan))
(When plan-start 50 (has made))
(Part plan-start 51 stack ((source made.rows) (frame inset) (label "Apps you made")))
(When plan-start 51 (on can.plan))
(When plan-start 51 (has made))

; ---------- one app the person made, opened on the bench to change it
(Screen plan-made "An app you made")
(Part plan-made 10 line ((title (bind made.title)) (meta (bind made.meta))))
(Row plan-made 10 made)
(Part plan-made 20 buttons ((items ((button "Change it" open-made ((variant ghost) (icon edit) (aria "Change {made.title}")))))))
(Row plan-made 20 made)

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
; a later round: which change is being made, and that the app the person has stays as it is until its go
(Part plan 13 notice ((tone info) (text (words "Changing it: " (bind round.words)))))
(When plan 13 (on plan.changing))
(Part plan 14 note ((text "Your app stays as it is until this change is checked and you deploy it.")))
(When plan 14 (on plan.changing))
(Part plan 20 notice ((tone warn) (text "Stopped. Nothing more is being built; what was made so far stays here.")))
(When plan 20 (on plan.stopped))
(Part plan 21 notice ((tone warn) (text (words "Waiting on something: " (bind plan.status)))))
(When plan 21 (on plan.blocked))
(Part plan 22 buttons ((items ((button "Make something else" fresh ((variant primary)))))))
; each mind the plan waits on that can't go on now, a row a mind (plan-waiting): why, and the press that moves it
(Part plan 23 stack ((source waiting.rows)))
(When plan 23 (on plan.waiting))
; held (it waits on the person or the hive): it never holds Make; the person may make something else meanwhile, and
; this build stays as it is, its question with it. Offered only where the empty canvas names the build again (the same
; test, plan.leavable): a question asked while the build still works is answered here, not left.
(Part plan 25 note ((text "You can make something else meanwhile. This build stays here as it is, with its question.")))
(Row plan 25 leave)
(When plan 25 (on plan.leavable))
(Part plan 26 buttons ((items ((button "Make something else" fresh ((variant ghost) (aria "Make something else; this build stays here with its question")))))))
(Row plan 26 leave)
(When plan 26 (on plan.leavable))

; ---------- one mind the plan waits on: refused for spending (in the hive's words, with where its limits are), or
; stopped, asleep, stopped with an error or never started, with Start or Wake where this person may press it
(Screen plan-waiting "A mind the plan waits on")
(Part plan-waiting 10 notice ((tone warn) (text (words (bind name) " is waiting on a spending limit: " (bind message)))))
(When plan-waiting 10 (on spending))
(Part plan-waiting 11 notice ((tone warn) (text (words "Waiting for " (bind step) ": " (bind name) " is stopped."))))
(When plan-waiting 11 (on stopped))
(Part plan-waiting 12 notice ((tone warn) (text (words "Waiting for " (bind step) ": " (bind name) " is asleep."))))
(When plan-waiting 12 (on asleep))
(Part plan-waiting 13 notice ((tone warn) (text (words "Waiting for " (bind step) ": " (bind name) " stopped with an error."))))
(When plan-waiting 13 (on error))
(Part plan-waiting 14 notice ((tone warn) (text (words "Waiting for " (bind step) ": " (bind name) " hasn't been started."))))
(When plan-waiting 14 (on created))
(Part plan-waiting 20 buttons ((items ((button "See limits" open-limits ((variant ghost) (icon gauge) (aria "See the spending limits")))))))
(When plan-waiting 20 (on spending))
(Part plan-waiting 21 buttons ((items ((button (words "Start " (bind name)) start-mind ((variant ghost) (aria (words "Start " (bind name)))))))))
(When plan-waiting 21 (on can.start))
(Part plan-waiting 22 buttons ((items ((button (words "Wake " (bind name)) wake-mind ((variant ghost) (aria (words "Wake " (bind name)))))))))
(When plan-waiting 22 (on can.wake))
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
; a later round ready for its go: the change it makes; a later round stopped: the app is as it was
(Part plan-ready 25 notice ((tone info) (text (words "The change: " (bind round.words)))))
(When plan-ready 25 (on plan.changing))
(Part plan-ready 26 notice ((tone warn) (text (words "Stopped making the change " (bind round.words) ". Your app is as it was."))))
(When plan-ready 26 (on plan.stopped))
(Part plan-ready 30 island ((name deploy-go)))
(When plan-ready 30 (any ((off plan.installed) (on plan.changing))))
; before the first deploy, beside the go: where a change is asked for, since the change box comes only once the app is
; deployed and a person who has just seen Deploy looks for it there
(Part plan-ready 31 note ((text "After you deploy it, you can ask for changes here. Each change is kept, and Undo puts it back.")))
(When plan-ready 31 (on can.revise))
(When plan-ready 31 (off plan.installed))
(Part plan-ready 40 notice ((tone info) (text (words "Installed as " (bind installed.name) ". It's in your Apps now."))))
(Row plan-ready 40 installed)
(When plan-ready 40 (on plan.installed))
(When plan-ready 40 (off plan.changing))
(Part plan-ready 41 buttons ((items ((button "Open" open-app ((variant primary) (icon external) (aria (words "Open " (bind installed.name)))))))))
(Row plan-ready 41 installed)
(When plan-ready 41 (on plan.installed))
(When plan-ready 41 (off plan.changing))
(Part plan-ready 42 buttons ((items ((button "Make something else" fresh ((variant ghost)))))))
(Row plan-ready 42 installed)
(When plan-ready 42 (on plan.installed))
(When plan-ready 42 (off plan.changing))
; how it was made, beside the page
(Part plan-ready 50 island ((name plan-stream) (region_label "How it was made")))
(Region plan-ready 50 aside)

; ---------- changing it: the installed app at rest takes a change in the person's words, keeps every version, and undoes
(Part plan-ready 60 section ((title "Change it") (body "Say what should be different. It's changed from what it is now, checked again, and put in your Apps when you say so.")))
(When plan-ready 60 (on can.revise))
(When plan-ready 60 (on plan.installed))
(When plan-ready 60 (off plan.changing))
(Part plan-ready 61 fields ((items ((field long "What should change?" revise.words ((rows 2) (placeholder "e.g. make the board blue") (waits revise.busy)))))))
(When plan-ready 61 (on can.revise))
(When plan-ready 61 (on plan.installed))
(When plan-ready 61 (off plan.changing))
(Part plan-ready 62 actions ((items ((action "Change it" revise-send revise.held))) (tone primary)))
(When plan-ready 62 (on can.revise))
(When plan-ready 62 (on plan.installed))
(When plan-ready 62 (off plan.changing))
; why it can't take a change just now, in the hive's words
(Part plan-ready 63 note ((text (bind revise.why_not))))
(When plan-ready 63 (on revise.refused))
(When plan-ready 63 (on plan.installed))
(When plan-ready 63 (off plan.changing))
; every deployed version once there is more than one, the one in the person's Apps marked
(Part plan-ready 70 section ((title "Versions") (body "Each change you deploy is kept. Undo puts back the version this one was made from, or put back any of them.")))
(When plan-ready 70 (none-of ((below revisions 2))))
(When plan-ready 70 (off plan.changing))
(Part plan-ready 71 buttons ((items ((button "Undo the last change" undo ((variant ghost) (icon back) (aria (words "Undo the last change: put back version " (bind undo.round)))))))))
(When plan-ready 71 (on can.undo))
(When plan-ready 71 (off plan.changing))
(Part plan-ready 72 stack ((source revisions.rows) (frame inset) (label "Versions of this app") (current (bind revisions.current))))
(When plan-ready 72 (none-of ((below revisions 2))))
(When plan-ready 72 (off plan.changing))

; ---------- one version of the app: the change it made, when it went in, and putting it back
(Screen plan-revision "One version of the app")
(Part plan-revision 10 line ((title (bind rev.title)) (meta (bind rev.meta)) (badge "In your Apps") (tone good)))
(Row plan-revision 10 version)
(When plan-revision 10 (on rev.current))
(Part plan-revision 11 line ((title (bind rev.title)) (meta (bind rev.meta))))
(Row plan-revision 11 version)
(When plan-revision 11 (off rev.current))
(Part plan-revision 20 buttons ((items ((button "Put back" revert-to ((variant ghost) (icon history) (aria "Put back {rev.title}")))))))
(Row plan-revision 20 version)
(When plan-revision 20 (off rev.current))
(When plan-revision 20 (on can.revert))
