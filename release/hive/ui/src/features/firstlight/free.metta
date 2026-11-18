; Purpose: First Light's free inference way to think, declared as atoms (screens/lib_screens.metta composes them).
; Where the hive's deploy supplies a key for an inference endpoint (hive/core/free_inference.py), a person's mind can
; think with no key of their own, up to their model calls a day. The single screen (SingleScreen.tsx) places this among
; its ways to think and carries out the press, which moves the person's mind onto the free route; what it offers and
; says is decided here.
;
; Facts the card states each time: free.offered (the hive lists the free route as there for this person, with a model,
; and has not seen it fail to answer), free.chosen (the person's mind thinks with it now), free.lapse (off: the mind is
; set to it but the hive no longer offers it to this person; model: it does, but no longer the mind's model; none).
; Data: free.model (the mind's model once chosen, else the one the press moves it to), free.daily_calls (each person's
; model calls a day), free.host (where what a person writes goes), mind.name.

(Screen first-light-free "Free inference")

; offered, not yet chosen: the one press, then what it is, who provides it, what counts and where the words go
(Part first-light-free 10 buttons ((items ((button "Use free inference" use-free-inference ((aria "Use this hive's free inference for {mind.name}")))))))
(When first-light-free 10 (on free.offered))
(When first-light-free 10 (off free.chosen))
(Part first-light-free 20 note ((text (words "This hive's deploy provides " (bind free.model) " for free: up to " (bind free.daily_calls) " model calls a day for you, with no key of your own, counting your mind's replies in rooms and its goals too. What you write goes to " (bind free.host) " to be answered."))))
(When first-light-free 20 (on free.offered))
(When first-light-free 20 (off free.chosen))

; chosen: how the mind thinks now
(Part first-light-free 30 note ((text (words "Thinking with " (bind free.model) ", which this hive's deploy provides: up to " (bind free.daily_calls) " model calls a day, its replies in rooms and its goals included. What you write goes to " (bind free.host) " to be answered."))))
(When first-light-free 30 (on free.chosen))

; set to it, but it can't serve the mind now: why, and what to do, read first (the card keeps the other ways open)
(Part first-light-free 4 note ((text (words (bind mind.name) " can't think with free inference now: this hive doesn't offer it to you. Choose another way for it to think."))))
(When first-light-free 4 (is free.lapse off))
(Part first-light-free 6 note ((text (words (bind mind.name) " was set to a model this hive's free inference no longer offers. Use free inference to move it to " (bind free.model) ", or choose another way."))))
(When first-light-free 6 (is free.lapse model))
