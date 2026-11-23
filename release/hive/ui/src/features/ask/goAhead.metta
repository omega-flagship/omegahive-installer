; Purpose: compose the question an Ask turn asks when its spend looks expensive, and what became of the person's
; answer, for the look being worn.
;
; Jon on omega-flagship/omegahive#294 (design item 2): no per-answer cap and no per-thread cap; only an outlier asks
; once, "this one looks expensive (about $X), go ahead?", and anyone can turn that off. The turn waits for the answer
; while its latest frame is go_ahead (POST /api/ask/{op}/go-ahead): Go ahead carries it on and it asks nothing more for
; that turn; Stop stops it as the Ask's own Stop does.
;
; Facts the page states each time (goAhead.ts goAheadScreen): go.asking (the question stands: unanswered, its answer in
; flight, or its answer not sent), go.figured (the hive gave the turn's spend so far), and the value go.said (went
; stopping failed gone) once the person answered.

(Screen ask-go-ahead "This one looks expensive")

; the question, with the spend so far when the hive gave it; an alertdialog, so a screen reader says it as it appears
(Part ask-go-ahead 10 confirm ((text (words "This one looks expensive (about " (bind go.spent) " so far). Go ahead?"))
  (yes "Go ahead") (yes_action go-ahead) (no "Stop") (no_action go-stop) (tone plain) (alert yes) (label "This one looks expensive")))
(When ask-go-ahead 10 (on go.asking))
(When ask-go-ahead 10 (on go.figured))
(Part ask-go-ahead 11 confirm ((text "This one looks expensive. Go ahead?")
  (yes "Go ahead") (yes_action go-ahead) (no "Stop") (no_action go-stop) (tone plain) (alert yes) (label "This one looks expensive")))
(When ask-go-ahead 11 (on go.asking))
(When ask-go-ahead 11 (off go.figured))

; what became of the answer
(Part ask-go-ahead 20 note ((text "Going ahead. It won’t ask again for this one.")))
(When ask-go-ahead 20 (is go.said went))
(Part ask-go-ahead 21 note ((text "Stopping.")))
(When ask-go-ahead 21 (is go.said stopping))
(Part ask-go-ahead 22 notice ((tone bad) (text (words "Your answer didn’t reach the hive: " (bind go.error)))))
(When ask-go-ahead 22 (is go.said failed))
(Part ask-go-ahead 23 note ((text "It isn’t waiting for your answer any more.")))
(When ask-go-ahead 23 (is go.said gone))
