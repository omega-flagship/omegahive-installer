; Purpose: what a person sees around a view: the page a view opens on and the place under a mind's message where it
; sits (view-page, view-chat), the card that asks before a view runs (view-run), and everything around a view while it
; runs, in both paths (view-host): its bar, what it asks for, what it reaches, and why it is not drawn.

; ---------- where a view is opened (features/views/ViewFrame.tsx states these): on a page, opening it, a hive that
; can't show views, or a view that could not be opened; then the card before it runs or the view itself, the islands
; run and view the page offers. Under a mind's message in a chat, only what was made to be a view, once it is in hand: a
; view the chat cannot open leaves the message as it is.
;   the standard resource facts (screens/resourceFacts.ts): the value resource, and the data resource.error
;   flags  view.gone      the hive has no such view for this person (404: gone, or not shown to them)
;          view.ran       the person ran this revision, and the hive handed out its text or document
;          view.document  it is a plan's HTML page, which a chat leaves as text
(Screen view-page "A view on a page")
(Resource view-page 10 ((waiting "Opening the view")
  (part unsupported notice ((tone info) (text "This hive can't show views here. Ask the mind that made it to send you the text.")))))
(Part view-page 20 notice ((tone bad) (text (words "Could not open the view: " (bind resource.error)))))
(When view-page 20 (any ((is resource failed) (is resource forbidden))))
(When view-page 20 (off view.gone))
(Part view-page 21 notice ((tone bad) (text "Could not open the view: it is no longer here, or not shown to you.")))
(When view-page 21 (any ((is resource failed) (is resource forbidden))))
(When view-page 21 (on view.gone))
(Part view-page 22 actions ((items ((action "Try again" retry)))))
(When view-page 22 (any ((is resource failed) (is resource forbidden))))
(Part view-page 30 island ((name run)))
(When view-page 30 (is resource ready))
(When view-page 30 (off view.ran))
(Part view-page 31 island ((name view)))
(When view-page 31 (is resource ready))
(When view-page 31 (on view.ran))

(Screen view-chat "A view under a mind's message")
(Part view-chat 10 island ((name run)))
(When view-chat 10 (is resource ready))
(When view-chat 10 (off view.document))
(When view-chat 10 (off view.ran))
(Part view-chat 11 island ((name view)))
(When view-chat 11 (is resource ready))
(When view-chat 11 (off view.document))
(When view-chat 11 (on view.ran))

; ---------- before a view runs: a card with Run it (features/views/ViewConsent.tsx states these). No view runs until the
; person asks, and nothing loads from a declared domain until they allow it for that revision (hive/core/views.py Grants).
;   counts view.asks  how many domains it declares that wait on the person (an HTML view only)
;          view.maker 1 when the person can see the mind that made it
;   flags  view.busy  their answer is on its way; view.failed  it could not be recorded (view.error says why)
;   data   view.title, view.maker, view.asks (the domains, joined), view.error
(Screen view-run "A view to run")
(Part view-run 10 paragraph ((text (words (bind view.title) ", a view made by " (bind view.maker) ". It runs only when you ask it to."))))
(When view-run 10 (has view.maker))
(Part view-run 11 paragraph ((text (words (bind view.title) ", a view made by a mind. It runs only when you ask it to."))))
(When view-run 11 (none view.maker))
(Part view-run 20 note ((text (words "It asks to reach " (bind view.asks) ". Until you allow that for this version, it can't load anything from there."))))
(When view-run 20 (has view.asks))
(Part view-run 30 actions ((tone primary) (items ((action "Run it" run view.busy)))))
(Part view-run 40 notice ((tone bad) (text (words "Could not run it: " (bind view.error)))))
(When view-run 40 (on view.failed))

; ---------- everything around a running view, in both paths. The page states these facts each time and draws this
; screen, the view itself in the island named view: a view written in MeTTa is its own composed screen
; (features/views/MettaFrame.tsx, mettaView.ts), an HTML view its sandboxed frame (features/views/ViewFrame.tsx).
;   flags  view.full       the view is full screen (also data, for the bar)
;          view.starting   a MeTTa view's worker is starting and has not drawn yet
;          view.drawn      the view is drawn
;          view.broken     a MeTTa view cannot be drawn at all (view.problem says why)
;          view.slipped    a MeTTa view is drawn, but the latest change or press could not be (view.problem says why)
;          view.newer      what could not be drawn is a newer revision its mind saved (view.newer, its number)
;          view.other      that newer revision is not one this view can take up (no longer a view written in MeTTa)
;          view.stopped    a MeTTa view stopped responding, and its worker was ended
;          view.unsafe     this browser left a way out of a MeTTa view's worker open, so it is not drawn
;          view.asks-link  an HTML view asked, after a click inside it, to open view.link; the person opens it or not
;          view.asks-file  an HTML view asked, after a click inside it, to save a file; the person saves it or not
;          view.folded     an HTML view asked to be put away
;          view.left       an HTML view's frame loaded a second page: its own document loads it once, so a later load
;                          is the view going somewhere else, and the frame is taken down (the page's frame-src keeps
;                          that page on the hive's own origin, hive/core/app.py page_csp)
;          view.allow-failed  allowing an HTML view's domains could not be recorded (view.allow-error says why)
;   counts view.maker      1 when the person can see the mind that made it
;          view.reaches    the domains an HTML view may load from now; view.refused  what the hive dropped of its asks
;          view.asks       the domains an HTML view declares that wait on the person
;   data   view.title, and view.title-id (the id the bar's title carries, which names the view's dialog and frame);
;          view.problem the reason, in words; view.maker the name of the mind that made it; view.link; the file's
;          view.file-name and view.file-size; view.reaches, view.refused and view.asks, each joined; view.allowing (the
;          person's Allow is on its way)
(Screen view-host "A view")
; the bar above every view: its title, and Full screen, which becomes Close in full screen (one button, so the person's
; focus stays on it)
(Part view-host 5 bar ((icon apps) (title (bind view.title)) (title_id (bind view.title-id)) (edge view.full) (flush yes)
  (items ((button "Full screen" fullscreen ((icon unfold) (variant ghost) (off view.full)))
          (button "Close" inline ((icon x) (variant ghost) (on view.full)))))))
(When view-host 5 (none-of ((on view.folded) (on view.left))))
(Part view-host 10 waiting ((label "Opening the view")))
(When view-host 10 (on view.starting))
(Part view-host 20 notice ((tone bad) (text (words "This view can't be drawn: " (bind view.problem) "."))))
(When view-host 20 (on view.broken))
(When view-host 20 (off view.newer))
(Part view-host 21 notice ((tone bad) (text (words "Revision " (bind view.newer) " can't be drawn: " (bind view.problem) "."))))
(When view-host 21 (on view.broken))
(When view-host 21 (on view.newer))
(When view-host 21 (off view.other))
(Part view-host 30 notice ((tone bad) (text "This view stopped responding, so it was ended.")))
(When view-host 30 (on view.stopped))
(Part view-host 40 actions ((items ((action "Start it again" restart)))))
(When view-host 40 (on view.stopped))
(Part view-host 50 notice ((tone bad) (text "This browser can't keep the view apart from your hive, so it isn't drawn.")))
(When view-host 50 (on view.unsafe))
; the view takes the height its screen is given in full screen
(Part view-host 60 island ((name view) (fill yes)))
(When view-host 60 (on view.drawn))
; what an HTML view asks for, which the person opens or saves themselves
(Part view-host 62 confirm ((alert yes) (tone plain) (label "Open a link from the view")
  (text (words "This view wants to open " (bind view.link) ".")) (yes "Open") (yes_action open) (no "Cancel") (no_action decline)))
(When view-host 62 (on view.asks-link))
(Part view-host 64 confirm ((alert yes) (tone plain) (label "Save a file from the view")
  (text (words "Save " (bind view.file-name) " (" (bind view.file-size) ") from this view?")) (yes "Save") (yes_action save) (no "Cancel") (no_action decline)))
(When view-host 64 (on view.asks-file))
(Part view-host 70 notice ((tone warn) (text (words "The view kept its last state: " (bind view.problem) "."))))
(When view-host 70 (on view.slipped))
(When view-host 70 (off view.newer))
(Part view-host 71 notice ((tone warn) (text (words "The view kept its last state: revision " (bind view.newer) " can't be drawn: " (bind view.problem) "."))))
(When view-host 71 (on view.slipped))
(When view-host 71 (on view.newer))
(When view-host 71 (off view.other))
(Part view-host 72 notice ((tone warn) (text (words "Revision " (bind view.newer) " is not one this view can take up, so open the view again to see it."))))
(When view-host 72 (on view.other))
; who made it and what it reaches, under the view inline (full screen gives the view the whole screen)
(Part view-host 80 note ((text (words "View made by " (bind view.maker) ". It runs on its own and cannot see your hive."))))
(When view-host 80 (has view.maker))
(When view-host 80 (none-of ((on view.starting) (on view.unsafe) (on view.folded) (on view.left) (on view.full))))
(Part view-host 81 note ((text "View made by a mind. It runs on its own and cannot see your hive.")))
(When view-host 81 (none view.maker))
(When view-host 81 (none-of ((on view.starting) (on view.unsafe) (on view.folded) (on view.left) (on view.full))))
(Part view-host 82 note ((text (words "It reaches " (bind view.reaches) "."))))
(When view-host 82 (has view.reaches))
(When view-host 82 (on view.drawn))
(When view-host 82 (off view.full))
(Part view-host 84 note ((text (words "Not allowed: " (bind view.refused) "."))))
(When view-host 84 (has view.refused))
(When view-host 84 (on view.drawn))
(When view-host 84 (off view.full))
; an HTML view running without the domains it declares, under it inline: allowing them is for this revision only
(Part view-host 86 notice ((tone warn) (text (words "This view asks to reach " (bind view.asks) ". It can't load anything from there until you allow that for this version."))))
(When view-host 86 (has view.asks))
(When view-host 86 (on view.drawn))
(When view-host 86 (off view.full))
(Part view-host 87 actions ((items ((action "Allow for this version" allow view.allowing)))))
(When view-host 87 (has view.asks))
(When view-host 87 (on view.drawn))
(When view-host 87 (off view.full))
(Part view-host 88 notice ((tone bad) (text (words "Could not allow it: " (bind view.allow-error)))))
(When view-host 88 (on view.allow-failed))
(When view-host 88 (has view.asks))
(When view-host 88 (off view.full))
; put away at its own request, or closed because its frame went somewhere else: what MeTTa says in its place
(Part view-host 90 notice ((tone warn) (text (words (bind view.title) " tried to open another page in its place, so it was closed."))))
(When view-host 90 (on view.left))
(Part view-host 92 actions ((items ((action (words "Show " (bind view.title) " again") again)))))
(When view-host 92 (any ((on view.folded) (on view.left))))
