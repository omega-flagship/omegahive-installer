; Getting started (#/setup), declared as atoms (screens/lib_screens.metta composes them). The checklist itself is drawn
; by SetupChecklist (it is also the hive view's own checklist), so the page places it as an island; what the page
; decides is its opening words and the line about the checklist on the hive view: shown or hidden there, and the
; button that changes it, for a signed-in person only. The steps set up the hive itself, an admin's job, so only an
; admin view sees any of them; a member is told whose job they are; nothing shows until the hive has said who is
; signed in.
;
; Facts the page states each time: signed.in setup.hidden viewer.admin viewer.known.

(Screen setup "Getting started")

; a member, once the hive has said so: whose job the steps are
(Part setup 5 empty ((icon shield) (title "For this hive's admins") (body "These steps set up the hive itself: its AI provider, who pays and its spending limit. An admin of this hive looks after them.")))
(When setup 5 (on viewer.known))
(When setup 5 (off viewer.admin))

(Part setup 10 paragraph ((text "Five things that make a hive work. Each is ticked from what the hive reports, never from a guess; a question mark means this hive or your role cannot tell.")))
(When setup 10 (on viewer.admin))
(Part setup 20 island ((name setup-checklist)))
(When setup 20 (on viewer.admin))

; shown on the hive view, with a way to hide it there
(Part setup 30 paragraph ((text "Shown on your hive view until every step is done.")))
(When setup 30 (on viewer.admin))
(When setup 30 (on signed.in))
(When setup 30 (off setup.hidden))
(Row setup 30 on-hive)
(Part setup 31 buttons ((items ((button "Hide it there" hide-on-hive ((variant ghost)))))))
(When setup 31 (on viewer.admin))
(When setup 31 (on signed.in))
(When setup 31 (off setup.hidden))
(Row setup 31 on-hive)

; hidden from the hive view, with a way to show it there again
(Part setup 32 paragraph ((text "Hidden from your hive view.")))
(When setup 32 (on viewer.admin))
(When setup 32 (on signed.in))
(When setup 32 (on setup.hidden))
(Row setup 32 on-hive)
(Part setup 33 buttons ((items ((button "Show it there again" show-on-hive ((variant ghost)))))))
(When setup 33 (on viewer.admin))
(When setup 33 (on signed.in))
(When setup 33 (on setup.hidden))
(Row setup 33 on-hive)
