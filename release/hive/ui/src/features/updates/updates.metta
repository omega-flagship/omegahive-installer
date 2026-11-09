; The Updates and holds page, one hold on it and one app on it, declared as atoms (screens/lib_screens.metta composes
; them). The page composes each hold and each app for its own facts, and the updates screen stacks them.
;
; Facts the page states each time:
;   updates: the resource facts (value resource, resource.stale; data resource.error), updates.loaded; can.hold can.apply
;            can.request;
;            platform.update platform.supervised platform.held platform.requested; apps.one;
;            (count holds.all) (count apps.all) (count apps.waiting) (count platform.commits) (count history.all)
;   updates-hold: can.release
;   updates-app: app.attention (an update or a load error) app.broken app.same-version app.removed app.requested
;                app.held; can.hold can.apply

(Screen updates "Updates")

; ---------- checking for updates: the shared resource states (lib_screens.metta Resource), in this page's words
(Resource updates 1 ((waiting "Checking for updates") (unsupported "This hive does not report updates yet.") (unsupported-icon ban)
  (failed-title "Could not check for updates") (retry retry)))

; asking for an update: a note to whoever applies updates (admins whose hive takes requests)
(Part updates 9 buttons ((items ((button "Ask for an update…" ask-update ((icon replay)))))))
(When updates 9 (on updates.loaded))
(When updates 9 (on can.request))

; ---------- holds: what must not be interrupted
(Part updates 10 section ((tour update-holds) (title "Holds") (body "Nothing is held. Hold the platform or an app below when work must not be interrupted.")))
(When updates 10 (on updates.loaded))
(When updates 10 (none holds.all))
(Part updates 11 section ((tour update-holds) (title (bind holds.heading))))
(When updates 11 (on updates.loaded))
(When updates 11 (has holds.all))
(Part updates 12 buttons ((items ((button "Hold everything…" hold-all ((icon pause)))))))
(When updates 12 (on updates.loaded))
(When updates 12 (on can.hold))
(Part updates 13 stack ((source holds.all) (label "Holds")))
(When updates 13 (on updates.loaded))
(When updates 13 (has holds.all))

; ---------- the platform: the running build, what waits for a restart, and restarting
(Part updates 20 section ((title "Platform") (body (bind platform.running))))
(When updates 20 (on updates.loaded))
(Part updates 21 note ((text "Up to date.")))
(When updates 21 (on updates.loaded))
(When updates 21 (off platform.update))
(Part updates 22 note ((text (bind platform.waiting))))
(When updates 22 (on updates.loaded))
(When updates 22 (on platform.update))
(Part updates 23 code ((label "Changes waiting for a restart") (text (bind platform.commits))))
(When updates 23 (on updates.loaded))
(When updates 23 (on platform.update))
(When updates 23 (has platform.commits))
(Part updates 24 note ((text (bind platform.request))))
(When updates 24 (on updates.loaded))
(When updates 24 (on platform.update))
(When updates 24 (on platform.requested))
(Part updates 25 note ((text "This hive can't restart itself; restart it on its host.")))
(When updates 25 (on updates.loaded))
(When updates 25 (on platform.update))
(When updates 25 (off platform.supervised))
; restarting (only a hive that restarts itself, on a hive that can apply updates) and holding restarts, side by side
(Part updates 26 buttons ((items ((button "Restart to update" restart ((variant primary)))))))
(Row updates 26 platform-actions)
(When updates 26 (on updates.loaded))
(When updates 26 (on platform.update))
(When updates 26 (none-of ((off platform.supervised) (off can.apply) (on platform.held))))
(Part updates 27 buttons ((items ((button "Restart (on hold)" restart ())))))
(Row updates 27 platform-actions)
(When updates 27 (on updates.loaded))
(When updates 27 (on platform.update))
(When updates 27 (on platform.held))
(When updates 27 (none-of ((off platform.supervised) (off can.apply))))
(Part updates 28 buttons ((items ((button "Hold restarts…" hold-restarts ((icon pause)))))))
(Row updates 28 platform-actions)
(When updates 28 (on updates.loaded))
(When updates 28 (on can.hold))

; ---------- apps: which need attention, each with its own hold and reload
(Part updates 40 section ((title "Apps") (body (bind apps.attention))))
(When updates 40 (on updates.loaded))
(When updates 40 (has apps.waiting))
(Part updates 41 section ((title "Apps") (body "The one app is running what is on disk.")))
(When updates 41 (on updates.loaded))
(When updates 41 (none apps.waiting))
(When updates 41 (on apps.one))
(Part updates 42 section ((title "Apps") (body (bind apps.calm))))
(When updates 42 (on updates.loaded))
(When updates 42 (none apps.waiting))
(When updates 42 (off apps.one))
(Part updates 43 stack ((source apps.all) (frame inset) (label "Apps")))
(When updates 43 (on updates.loaded))
(When updates 43 (has apps.all))

; ---------- what was applied lately
(Part updates 50 section ((title "Recent")))
(When updates 50 (on updates.loaded))
(When updates 50 (has history.all))
(Part updates 51 list ((source history.all) (title title) (meta (problem overrode)) (label "Recent")))
(When updates 51 (on updates.loaded))
(When updates 51 (has history.all))

; placing, lifting and asking: dialogs with their own forms, drawn by the page (an island)
(Part updates 60 island ((name update-dialogs)))
(When updates 60 (on updates.loaded))
(Part updates 61 note ((text "A mind can apply updates only if an admin gives it the exact skill hive-update-apply; no default or wildcard rule grants it, and minds can never override a hold.")))
(When updates 61 (on updates.loaded))

(Screen updates-hold "A hold")
(Part updates-hold 10 line ((title (bind hold.stops)) (meta (bind hold.detail)) (badge "On hold") (tone warn)))
(Part updates-hold 20 buttons ((items ((button "Lift…" lift ())))))
(When updates-hold 20 (on can.release))

(Screen updates-app "An app")
(Part updates-app 10 line ((title (bind app.name)) (meta (bind app.version))))
(Part updates-app 20 notice ((tone bad) (text (bind app.problem))))
(When updates-app 20 (on app.broken))
(Part updates-app 21 note ((text "Same version number, changed code.")))
(When updates-app 21 (on app.same-version))
(Part updates-app 22 notice ((tone warn) (text "Its folder is gone; it keeps running until the next restart.")))
(When updates-app 22 (on app.removed))
(Part updates-app 23 note ((text (bind app.request))))
(When updates-app 23 (on app.requested))
; holding and reloading, side by side: reload only when the app needs it and this hive can apply updates
(Part updates-app 30 buttons ((items ((button "Hold…" hold-app ((aria "Hold reloads of {app.name}") (icon pause) (variant ghost)))))))
(Row updates-app 30 app-actions)
(When updates-app 30 (on can.hold))
(Part updates-app 31 buttons ((items ((button "Reload" reload ((variant primary)))))))
(Row updates-app 31 app-actions)
(When updates-app 31 (none-of ((off app.attention) (off can.apply) (on app.held))))
(Part updates-app 32 buttons ((items ((button "Reload (on hold)" reload ())))))
(Row updates-app 32 app-actions)
(When updates-app 32 (on app.held))
(When updates-app 32 (none-of ((off app.attention) (off can.apply))))
