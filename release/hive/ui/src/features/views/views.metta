; Purpose: what a person sees around a view: the card that asks before a view runs (view-run), the prompt under an
; HTML view that asks before it reaches the domains it declares (view-reach), and around a view written in MeTTa the
; view itself while it is drawn, and otherwise why not (view-host).
; For view-host the page (features/views/MettaFrame.tsx) states these facts each time and draws this screen; the
; mind's view is its own composed screen (features/views/mettaView.ts), placed in the island named view.
;   flags  view.starting  the view's worker is starting and has not drawn yet
;          view.drawn     the view is drawn
;          view.broken    the view cannot be drawn at all (view.problem says why)
;          view.slipped   the view is drawn, but the latest change or press could not be (view.problem says why)
;          view.stopped   the view stopped responding, and its worker was ended
;          view.unsafe    this browser left a way out of the view's worker open, so it is not drawn
;   data   view.problem   the reason, in words; view.maker the name of the mind that made it

(Screen view-host "A view")
(Part view-host 10 waiting ((label "Opening the view")))
(When view-host 10 (on view.starting))
(Part view-host 20 notice ((tone bad) (text (words "This view can't be drawn: " (bind view.problem) "."))))
(When view-host 20 (on view.broken))
(Part view-host 30 notice ((tone bad) (text "This view stopped responding, so it was ended.")))
(When view-host 30 (on view.stopped))
(Part view-host 40 actions ((items ((action "Start it again" restart)))))
(When view-host 40 (on view.stopped))
(Part view-host 50 notice ((tone bad) (text "This browser can't keep the view apart from your hive, so it isn't drawn.")))
(When view-host 50 (on view.unsafe))
(Part view-host 60 island ((name view)))
(When view-host 60 (on view.drawn))
(Part view-host 70 notice ((tone warn) (text (words "The view kept its last state: " (bind view.problem) "."))))
(When view-host 70 (on view.slipped))
(Part view-host 80 note ((text (words "View made by " (bind view.maker) ". It runs on its own and cannot see your hive."))))
(When view-host 80 (none-of ((on view.starting) (on view.unsafe))))

; ---------- before a view runs: a card with Run it (features/views/ViewConsent.tsx states these). No view runs until the
; person asks, and a declared domain is reached only once they allow it for that revision (hive/core/views.py Grants).
;   counts view.asks  how many domains it declares that wait on the person (an HTML view only)
;   flags  view.busy  their answer is on its way; view.failed  it could not be recorded (view.error says why)
;   data   view.title, view.maker, view.asks (the domains, joined), view.error
(Screen view-run "A view to run")
(Part view-run 10 paragraph ((text (words (bind view.title) ", a view made by " (bind view.maker) ". It runs only when you ask it to."))))
(Part view-run 20 note ((text (words "It asks to reach " (bind view.asks) ". Until you allow that for this version, it runs with no network."))))
(When view-run 20 (has view.asks))
(Part view-run 30 actions ((tone primary) (items ((action "Run it" run view.busy)))))
(Part view-run 40 notice ((tone bad) (text (words "Could not run it: " (bind view.error)))))
(When view-run 40 (on view.failed))

; an HTML view running without the domains it declares, under its frame: allowing them is for this revision only
(Screen view-reach "A view asking to reach the network")
(Part view-reach 10 notice ((tone warn) (text (words "This view asks to reach " (bind view.asks) ". It runs with no network until you allow that for this version."))))
(When view-reach 10 (has view.asks))
(Part view-reach 20 actions ((items ((action "Allow for this version" allow view.busy)))))
(When view-reach 20 (has view.asks))
(Part view-reach 30 notice ((tone bad) (text (words "Could not allow it: " (bind view.error)))))
(When view-reach 30 (on view.failed))
