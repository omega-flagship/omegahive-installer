; Purpose: compose why a mind is quiet in its chat panel, from the refusal its own model calls last met.
; Why a mind is quiet (its chat panel, DotPanel): the refusal its own model calls last met, from the hive's one table of
; refusals (hive/core/refusals.py), declared as atoms that screens/lib_screens.metta composes for the look being worn.
; The words are the hive's sentence for the person; MeTTa decides which parts show and which presses help.
;
; Facts the page states each time (refused.ts): (on refused.here) while a refusal is kept on the mind,
; (on refused.noted) when there is a line to say (more than one call refused, or a time it tries again), and
; (is refused.remedy wait|credit|key|model), what the person can do about it.

(Screen mind-refused "Why this mind is quiet")
; a refusal that passes by itself (a provider's limit, a busy free route): a warning, not a fault
(Part mind-refused 10 notice ((tone warn) (text (bind refused.say))))
(When mind-refused 10 (on refused.here))
(When mind-refused 10 (is refused.remedy wait))
; one only someone can fix (credit, a key, another model)
(Part mind-refused 11 notice ((tone bad) (text (bind refused.say))))
(When mind-refused 11 (on refused.here))
(When mind-refused 11 (none-of ((is refused.remedy wait))))
; how many calls in a row, and when it tries again by itself (the hive's own refusals name no time)
(Part mind-refused 12 note ((text (bind refused.when))))
(When mind-refused 12 (on refused.here))
(When mind-refused 12 (on refused.noted))
; a key is what helps when the key was refused or its account ran out of credit
(Part mind-refused 20 buttons ((items ((button "Your keys" open-keys ((variant ghost)))))))
(When mind-refused 20 (on refused.here))
(When mind-refused 20 (any ((is refused.remedy key) (is refused.remedy credit))))
(Row mind-refused 20 remedies)
; another model goes on at once, whatever the refusal
(Part mind-refused 21 buttons ((items ((button "Choose a model" choose-model ((variant ghost)))))))
(When mind-refused 21 (on refused.here))
(Row mind-refused 21 remedies)
