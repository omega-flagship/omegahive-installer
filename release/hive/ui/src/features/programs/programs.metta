; The Apps page (every app this hive found) and one app's card on it, declared as atoms (screens/lib_screens.metta
; composes them). The page composes each app for its own facts, and the programs screen stacks them.
;
; Facts the page states each time:
;   programs: the resource facts (value resource, resource.stale; data resource.error); can.activity can.access;
;             (count programs.all)
;   programs-app: app.broken (it failed to load) app.enabled app.identity (a designed identity is worn) app.described;
;                 can.access; (count app.caps)

(Screen programs "Apps")
(Part programs 10 header ((title "Apps") (eyebrow "In this hive")
  (body "A program supplies the meaning of a piece of work as a graph of items, links and sources. The hive turns it into a space you can unfold, map, compare and inspect, with sources, uncertainty and your trail always in view.")))

; ---------- reading the apps: the shared resource states (lib_screens.metta Resource), in this page's words
(Resource programs 20 ((waiting "Loading apps")
  (part failed empty ((icon alert) (title "Apps are not available")
    (body (words (bind resource.error) ". This hive may be older than the programs API."))))
  (retry retry)))

; ---------- the apps, each its own small screen
(Part programs 30 empty ((icon apps) (title "No programs found")
  (body "Built-in programs live in hive/plugins/. Point HIVE_PLUGIN_DIRS at your own program directories, then Reload.")))
(When programs 30 (is resource ready))
(When programs 30 (none programs.all))
(Part programs 31 stack ((tour programs-list) (source programs.all) (frame card) (columns auto) (label "Apps")))
(When programs 31 (has programs.all))

; what apps did lately: a list that loads and refreshes itself under the heading the menu jumps to (an island)
(Part programs 40 island ((name app-activity)))
(When programs 40 (on can.activity))
; where one app runs: a dialog with its own tabs and decisions, opened from an app's card (an island)
(Part programs 50 island ((name app-access)))
(When programs 50 (on can.access))

(Screen programs-app "An app")
; its name, version and where it comes from, and how it stands
(Part programs-app 10 line ((tour (bind app.tour)) (icon app.icon) (lit app.lit) (title (bind app.name)) (meta (bind app.meta)) (badge "Failed to load") (tone bad)))
(When programs-app 10 (on app.broken))
(Part programs-app 11 line ((tour (bind app.tour)) (icon app.icon) (lit app.lit) (title (bind app.name)) (meta (bind app.meta)) (badge "Enabled") (tone good)))
(When programs-app 11 (off app.broken))
(When programs-app 11 (on app.enabled))
(Part programs-app 12 line ((tour (bind app.tour)) (icon app.icon) (lit app.lit) (title (bind app.name)) (meta (bind app.meta)) (badge "Disabled by an operator") (tone info)))
(When programs-app 12 (off app.broken))
(When programs-app 12 (off app.enabled))
; the identity the person chose to see apps in
(Part programs-app 20 note ((text (bind app.identity))))
(When programs-app 20 (on app.identity))
; what it does
(Part programs-app 30 paragraph ((text (bind app.about))))
(When programs-app 30 (on app.described))
(Part programs-app 31 note ((text "No description.")))
(When programs-app 31 (off app.described))
; why it failed to load
(Part programs-app 40 code ((label "Why it failed to load") (text (bind app.error))))
(When programs-app 40 (on app.broken))
; what it may do in the hive
(Part programs-app 50 chips ((label "What it may do") (source app.caps)))
(When programs-app 50 (has app.caps))
(Part programs-app 51 note ((text "No capabilities.")))
(When programs-app 51 (none app.caps))
; turning it on or off (not while it fails to load), where it runs, and opening it, side by side
(Part programs-app 60 toggles ((source app.switch) (label label) (checked on) (action switch) (aria "Disable {app.name}")))
(Row programs-app 60 app-controls)
(When programs-app 60 (off app.broken))
(When programs-app 60 (on app.enabled))
(Part programs-app 61 toggles ((source app.switch) (label label) (checked on) (action switch) (aria "Enable {app.name}")))
(Row programs-app 61 app-controls)
(When programs-app 61 (off app.broken))
(When programs-app 61 (off app.enabled))
(Part programs-app 62 buttons ((items ((button "Where it runs" access ((aria "Where {app.name} runs") (icon plug)))))))
(Row programs-app 62 app-controls)
(When programs-app 62 (on can.access))
(Part programs-app 63 buttons ((items ((button "Open" open ((aria "Open {app.name}") (icon unfold) (variant primary)))))))
(Row programs-app 63 app-controls)
(When programs-app 63 (on app.enabled))
