; Purpose: what the Ask says when this person has no model to ask (omegahive-feedback#135), declared as atoms that
; screens/lib_screens.metta composes for the look being worn. Every Ask skin draws it in the place its other panels
; open (ClassicAsk PanelView), so the bar never looks ready and then fails.
;
; Facts the Ask states each time (connect.ts): (on ask.needs_model) while the hive lists no provider this person can
; pay or reach with (no key, no free inference, no plan, no model on this computer); (on ask.held) when they pressed
; Enter on words for a mind, which were kept in the field and not sent.

(Screen ask-connect "Connect a model")
; at rest: say it before anything is typed
(Part ask-connect 10 notice ((tone warn) (text "Connect a model to start asking. This hive has no model you can use yet.")))
(When ask-connect 10 (on ask.needs_model))
(When ask-connect 10 (off ask.held))
; after Enter: the words stay, nothing was sent, no mind was woken
(Part ask-connect 11 notice ((tone warn) (text "Connect a model first. Your request wasn’t sent. Your words are kept.")))
(When ask-connect 11 (on ask.needs_model))
(When ask-connect 11 (on ask.held))
; the one press that helps: You and your keys, with the add-key form open
(Part ask-connect 20 buttons ((items ((button "Add a key" add-key ((aria "Add a key in You and your keys")))))))
(When ask-connect 20 (on ask.needs_model))
