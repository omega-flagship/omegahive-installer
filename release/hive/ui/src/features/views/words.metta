; Purpose: words said in the hive, wherever a look draws them: a mind's reply, a person's message, the hive's own note to a mind,
; a room's talk, a goal's detail, and a statement as written. Every look composes this one screen for them, through
; features/views/Words.tsx, so in every look an artifact id in the words reads as the artifact's title in a chip that
; opens it, and a statement or truth value is said in English with its exact words a press away.
;
; Words.tsx states two flags: words.said, draw the words; words.written, offer them as written (when the words held
; notation that was said in English, or when the place shows only that, as a belief's "as written" does). A look may
; draw the words its own way by preferring another block for the role (looks.metta, LookPrefers).
(Screen words "Words said in the hive")
; what an artifact's chip says while its title is read, and for one this person cannot open, in the words and as written
(RolePart words 10 utterance ((text (bind text)) (unnamed "Artifact") (missing "Artifact not available")
  (missing_why "It is no longer here, or not shown to you.")))
(When words 10 (on words.said))
(Part words 20 written ((text (bind text)) (show "Show as written") (hide "Hide as written") (class (bind class))
  (unnamed "Artifact") (missing "Artifact not available") (missing_why "It is no longer here, or not shown to you.")))
(When words 20 (on words.written))
