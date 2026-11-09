; The Artifacts and findings page, declared as atoms (screens/lib_screens.metta composes it).
; Facts the page states each time: the standard resource facts (screens/resourceFacts.ts: the value resource,
; resource.stale, resource.empty, the data resource.error), and the counts (count artifacts.all)
; (count artifacts.shown) (count artifacts.missing) (count artifacts.apps).
; There is no detail screen: each row opens the place the thing lives (Design, flows, a mind, an app).

(Screen artifacts "Artifacts and findings")

; ---------- where the list is: loading, not offered here, could not list, a failed refresh (the shared fragment,
; orders 4 to 11)
(Resource artifacts 4 ((waiting "Loading artifacts") (unsupported "This hive or the demo does not list artifacts yet.")
  (unsupported-icon ban) (failed "Could not list artifacts") (retry reload)))
(Part artifacts 12 empty ((icon layers) (title "Nothing produced yet")
  (body "Flows, revisions sent for review, exhibits minds show each other, and finished app actions appear here.")))
(When artifacts 12 (is resource ready))
(When artifacts 12 (on resource.empty))

; ---------- sources that could not be read this time: shown, never hidden
(Part artifacts 14 notice ((tone warn) (text (bind artifacts.missing.text))))
(When artifacts 14 (is resource ready))
(When artifacts 14 (off resource.empty))
(When artifacts 14 (has artifacts.missing))
(Part artifacts 15 actions ((items ((action "Retry" reload)))))
(When artifacts 15 (is resource ready))
(When artifacts 15 (off resource.empty))
(When artifacts 15 (has artifacts.missing))

; ---------- the filters: kind, words, swarm, mind, and app when any app produced something
(Part artifacts 20 segments ((label "Kind") (bind kind) (source artifacts.kinds)))
(When artifacts 20 (is resource ready))
(When artifacts 20 (off resource.empty))
(Part artifacts 30 search ((label "Search artifacts") (placeholder "Search titles") (bind query)))
(When artifacts 30 (is resource ready))
(When artifacts 30 (off resource.empty))
(Part artifacts 31 menus ((menus ((menu "Swarm" swarm artifacts.swarms "Every swarm")
  (menu "Mind" mind artifacts.minds "Every mind")))))
(When artifacts 31 (is resource ready))
(When artifacts 31 (off resource.empty))
(When artifacts 31 (none artifacts.apps))
(Part artifacts 32 menus ((menus ((menu "Swarm" swarm artifacts.swarms "Every swarm")
  (menu "Mind" mind artifacts.minds "Every mind") (menu "App" app artifacts.apps "Every app")))))
(When artifacts 32 (is resource ready))
(When artifacts 32 (off resource.empty))
(When artifacts 32 (has artifacts.apps))

; ---------- the list, newest first
(Part artifacts 40 entries ((source artifacts.shown) (label "Artifacts") (icon icon) (title title) (tag kind) (badge state)
  (meta byline) (detail detail) (code code) (action action) (open artifact)))
(When artifacts 40 (is resource ready))
(When artifacts 40 (off resource.empty))
(When artifacts 40 (has artifacts.shown))
(Part artifacts 41 empty ((icon filter) (title "Nothing matches") (body "Try another kind, swarm or mind.")))
(When artifacts 41 (is resource ready))
(When artifacts 41 (off resource.empty))
(When artifacts 41 (none artifacts.shown))
(Part artifacts 42 actions ((items ((action "Clear filters" clear-filters)))))
(When artifacts 42 (is resource ready))
(When artifacts 42 (off resource.empty))
(When artifacts 42 (none artifacts.shown))
(Part artifacts 90 note ((text "Composed from what you can already see: revisions sent for review, each swarm’s flows, exhibits minds showed each other, and app actions that finished.")))
(When artifacts 90 (is resource ready))
(When artifacts 90 (off resource.empty))
(Depth artifacts 90 ground)
