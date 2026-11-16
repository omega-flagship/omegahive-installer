; Words said in the hive, wherever a look draws them: a mind's reply, a person's message, the hive's own note to a mind,
; a room's talk, a goal's detail, and a statement as written. Every look composes this one screen for them, through
; features/views/Words.tsx, so in every look an artifact id in the words reads as the artifact's title in a chip that
; opens it, and a statement or truth value is said in English with its exact words a press away.
;
; Words.tsx states two flags: words.said, draw the words; words.written, offer them as written (when the words held
; notation that was said in English, or when the place shows only that, as a belief's "as written" does). A look may
; draw the words its own way by preferring another block for the role (looks.metta, LookPrefers).
(Screen words "Words said in the hive")
(RolePart words 10 utterance ((text (bind text))))
(When words 10 (on words.said))
(Part words 20 written ((text (bind text)) (label (bind label)) (class (bind class))))
(When words 20 (on words.written))
