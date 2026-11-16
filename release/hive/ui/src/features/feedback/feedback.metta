; Purpose: the feedback and bug-report area, declared as atoms (screens/lib_screens.metta composes them): what the person
; writes, everything their report carries, shown whole before anything leaves, and the ways it can leave, chosen by
; where this hive sends reports (HIVE_FEEDBACK_TO, hive/core/feedback.py).
;
; Facts the page states each time (features/feedback/data.ts):
;   value report.kind   bug | ux | idea
;   value to.route      service   the hive hands the report to the team's report service
;                       board     the feedback board is public: its form opens filled in, for a GitHub account
;                       copy      no direct route yet: the person copies it for the testers' group, or saves it
;                       invalid   the destination setting is wrong (data to.reason says how)
;   value report.done   none | sent | opened | copied | saved   what the person did with it last
;   flags picture.drawing picture.kept picture.failed   the picture of the screen, which the person adds
;         picture.goes    the picture is drawn and kept, so it goes with the report
;         errors.kept     the hive's recent errors go with it
;         report.empty    nothing written yet: nothing can leave
;         report.failed   the last send did not go through (data report.error)
;         report.copied_too  the board's address could not hold it all, so it is on the clipboard too
;         device.share    this device can hand the picture to its share sheet
;         report.drafted  the report was made from a draft (data report.drafted_by names who drafted it)
;   count report.errors   the hive's and the page's recent errors
;   count drafts          drafts waiting: what the hive noticed going wrong, and what minds drafted (features/feedback/drafts.ts)
;   data  to.host         the report service's host (service); to.board the board as owner/repo (board)

(Screen feedback "Feedback")
(Part feedback 1 header ((title "Send feedback or report a bug")
  (body "Tell the team what went wrong or what would make the hive better. Everything that goes with it is shown below, and nothing leaves your hive until you press one of the buttons at the end.")))

; ---------- what the hive noticed and what minds drafted, waiting for the person's yes
(Part feedback 2 section ((title "Drafted for you")
  (body "The hive noticed these going wrong, or one of your minds drafted them. Nothing has been sent. Use one to start a report you can change, or dismiss it.")))
(When feedback 2 (has drafts))
(Part feedback 3 entries ((label "Drafted for you") (source drafts) (title title) (meta meta) (detail detail)
  (row_actions ((action "Use it" use-draft "Use the draft: {title}") (action "Dismiss" dismiss-draft "Dismiss the draft: {title}")))))
(When feedback 3 (has drafts))
(Part feedback 4 notice ((tone info) (text (words "Started from a draft by " (bind report.drafted_by) ". Change anything before it goes."))))
(When feedback 4 (on report.drafted))

; ---------- what it is, and the person's words
(Part feedback 5 segmented ((label "What is it?") (bind report.kind)
  (options ((option bug "Something is broken") (option ux "Something is hard to use") (option idea "An idea")))))
(Part feedback 10 fields ((items ((field long "What went wrong?" report.words ((rows 4) (placeholder "What you were doing, and what happened")))
  (field long "What did you expect instead?" report.expected ((rows 2)))
  (field long "Steps: the screens you opened, then what you did" report.steps ((rows 3)))))))
(When feedback 10 (is report.kind bug))
(Part feedback 11 fields ((items ((field long "What was hard?" report.words ((rows 4) (placeholder "Where you were, and what got in the way")))
  (field long "What would have made it easy?" report.expected ((rows 2)))))))
(When feedback 11 (is report.kind ux))
(Part feedback 12 fields ((items ((field long "What do you need?" report.words ((rows 4) (placeholder "What you were trying to do")))
  (field long "What would you like the hive to do?" report.expected ((rows 2)))))))
(When feedback 12 (is report.kind idea))

; ---------- everything that goes with it
(Part feedback 20 section ((title "What goes with it")
  (body "All of this goes with your report. Leave the errors out if you would rather not send them. A picture of this page goes only if you add one.")))
(Part feedback 21 facts ((label "About this hive") (rows ((row "Report" (bind report.id)) (row "Version" (bind facts.version))
  (row "Hive" (bind facts.which)) (row "Device" (bind facts.device)) (row "Look" (bind facts.look)) (row "Page" (bind facts.page))
  (row "Window" (bind facts.window)) (row "Time" (bind facts.time))))))
(Part feedback 22 note ((text "Drawing a picture of the screen…")))
(When feedback 22 (on picture.drawing))
(Part feedback 23 picture ((source (bind picture.url)) (alt "This page as it was when you added the picture")
  (caption (words "Goes as " (bind report.id) ".png")) (action remove-picture) (action_label "Remove the picture")))
(When feedback 23 (on picture.goes))
; the picture is the person's to add: what it shows, then a word if it could not be drawn, then the press
(Part feedback 24 note ((text "A picture shows everything on this page as it is now, other people's names and messages included, and it isn't cleaned the way your words are. Add one only if it helps the team see what happened.")))
(When feedback 24 (off picture.kept))
(When feedback 24 (off picture.drawing))
(Part feedback 25 notice ((tone warn) (text "The hive could not draw a picture of this screen. Your words and the rest still go.")))
(When feedback 25 (on picture.failed))
(Part feedback 26 actions ((items ((action "Add a picture of this page" add-picture)))))
(When feedback 26 (off picture.kept))
(When feedback 26 (off picture.drawing))
(Part feedback 30 section ((title "The hive's recent errors")
  (body "The newest errors your hive and this page met, each with its id, so the team can find it.")))
(When feedback 30 (has report.errors))
(When feedback 30 (on errors.kept))
(Part feedback 31 list ((label "The hive's recent errors") (source report.errors) (title what) (summary message) (meta (at id))))
(When feedback 31 (has report.errors))
(When feedback 31 (on errors.kept))
(Part feedback 32 actions ((items ((action "Leave the errors out" drop-errors)))))
(When feedback 32 (has report.errors))
(When feedback 32 (on errors.kept))
(Part feedback 33 actions ((items ((action "Put the errors back" keep-errors)))))
(When feedback 33 (has report.errors))
(When feedback 33 (off errors.kept))
(Part feedback 40 section ((title "Your report, as it goes")))
(Part feedback 41 code ((label "Your report, as it goes") (text (bind report.text))))

; ---------- the ways it leaves, by where this hive sends reports
(Part feedback 48 note ((text (words "Sends your report, and the picture if you added one, to " (bind to.host) ", the report service this hive is set to send reports to."))))
(When feedback 48 (is to.route service))
(Part feedback 49 note ((text "Write a few words first.")))
(When feedback 49 (on report.empty))
(Part feedback 50 actions ((tone primary) (items ((action "Send to the team" send report.held send)))))
(When feedback 50 (is to.route service))
(Part feedback 51 actions ((tone primary) (items ((action "Open it on GitHub" open-board report.held external)))))
(When feedback 51 (is to.route board))
(Part feedback 52 note ((text (words "Opens a new issue on the team's feedback board on GitHub, " (bind to.board) ", filled in. The issue is public, so anyone can read it once you press Submit new issue there: leave out anything private. It needs a GitHub account."))))
(When feedback 52 (is to.route board))
(Part feedback 53 actions ((tone primary) (items ((action "Copy for the testers' group" copy report.held copy)))))
(When feedback 53 (any ((is to.route copy) (is to.route invalid))))
(Part feedback 54 note ((text "Paste it where you talk with the team, such as the testers' WhatsApp group. The team files it from there.")))
(When feedback 54 (is to.route copy))
(Part feedback 55 notice ((tone warn) (text (words "This hive's report destination is set wrongly: " (bind to.reason) ". Copy or save your report meanwhile."))))
(When feedback 55 (is to.route invalid))
(Part feedback 56 actions ((items ((action "Copy for the testers' group" copy report.held) (action "Save as files" save report.held)))))
(When feedback 56 (any ((is to.route service) (is to.route board))))
(Part feedback 57 actions ((items ((action "Save as files" save report.held)))))
(When feedback 57 (any ((is to.route copy) (is to.route invalid))))
(Part feedback 58 actions ((items ((action "Share the picture" share-picture)))))
(When feedback 58 (on device.share))
(When feedback 58 (on picture.goes))

; ---------- what happened, after a press
(Part feedback 60 notice ((tone info) (text (words "Copied. Paste it in the group, then send the picture as its own message with "
  (bind report.id) " as its caption."))))
(When feedback 60 (is report.done copied))
(When feedback 60 (on picture.goes))
(Part feedback 61 notice ((tone info) (text "Copied. Paste it in the group.")))
(When feedback 61 (is report.done copied))
(When feedback 61 (off picture.goes))
(Part feedback 62 notice ((tone info) (text (words "Saved " (bind report.id) ".txt and the picture beside it as " (bind report.id)
  ".png, where your browser keeps downloads."))))
(When feedback 62 (is report.done saved))
(When feedback 62 (on picture.goes))
(Part feedback 63 notice ((tone info) (text (words "Saved " (bind report.id) ".txt where your browser keeps downloads."))))
(When feedback 63 (is report.done saved))
(When feedback 63 (off picture.goes))
(Part feedback 64 notice ((tone info) (text "The board's form opened in a new tab. Press Submit new issue there.")))
(When feedback 64 (is report.done opened))
(Part feedback 65 notice ((tone info) (text "The whole report did not fit in the form's address, so it is on your clipboard too: paste it into Evidence.")))
(When feedback 65 (is report.done opened))
(When feedback 65 (on report.copied_too))
(Part feedback 66 notice ((tone info) (text (words "The picture is saved as " (bind report.id) ".png: drag it into Evidence."))))
(When feedback 66 (is report.done opened))
(When feedback 66 (on picture.goes))
(Part feedback 67 notice ((tone info) (text (words "Sent. Thank you. The team's reference: " (bind report.reference)))))
(When feedback 67 (is report.done sent))
(Part feedback 68 notice ((tone bad) (text (words "Not sent: " (bind report.error) " Copy or save it instead."))))
(When feedback 68 (on report.failed))
