; The Artifacts and findings page, declared as atoms (screens/lib_screens.metta composes it).
; Facts the page states each time: the standard resource facts (screens/resourceFacts.ts: the value resource,
; resource.stale, resource.empty, the data resource.error), the counts (count artifacts.all)
; (count artifacts.shown) (count artifacts.missing) (count artifacts.apps), and the flag artifacts.link-missing (the
; page was opened at #/artifacts/<id> for an artifact this person can't open).
; Each row opens the place the thing lives (Design, flows, a mind, an app). Besides the list, a saved creation opens in
; place on the page (CreationReader): one a mind made as a view (kind view) as that interactive view, sandboxed
; (features/views), and any other as its text where Design can't open it, with View it beside the text of an HTML page.
; A creation with nothing saved in it says so and opens the chat of the mind that made it, as does a row whose place
; does not open for this person.

(Screen artifacts "Artifacts and findings")

; ---------- a link to one artifact that names one this person can't open: said above the list
(Part artifacts 2 notice ((tone info) (text "That artifact is no longer here, or not shown to you.")))
(When artifacts 2 (on artifacts.link-missing))

; ---------- where the list is: loading, not offered here, could not list, a failed refresh (the shared fragment,
; orders 4 to 11)
(Resource artifacts 4 ((waiting "Loading artifacts") (unsupported "This hive or the demo does not list artifacts yet.")
  (unsupported-icon ban) (failed "Could not list artifacts") (retry reload)))
(Part artifacts 12 empty ((icon layers) (title "Nothing produced yet")
  (body "What minds make in your swarms, flows, revisions sent for review, exhibits minds show each other, and finished app actions appear here.")))
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
(Part artifacts 90 note ((text "Composed from what you can already see: what your swarms keep, revisions sent for review, each swarm’s flows, exhibits minds showed each other, and app actions that finished.")))
(When artifacts 90 (is resource ready))
(When artifacts 90 (off resource.empty))
(Depth artifacts 90 ground)

; ---------- a saved creation opened in place (features/artifacts/CreationReader.tsx states these): Back to the list, a
; way between its view and its text, and a copy of the text; its title and which revision; then the view it was made to
; be, or its text exactly as saved, never rendered (the islands view and text the page offers)
;   the standard resource facts for its text (screens/resourceFacts.ts)
;   flags  reader.view      the view is shown, not the text (also data, for the buttons)
;   counts reader.saved     1 once the revision's text, and so when it was saved, is in hand
;   data   reader.viewable  it opens as a view: made as one, or its text is an HTML page
;          reader.copied    its text was just copied
;          reader.title, reader.title-id (the id the title carries, which names the reader), reader.revision, and
;          reader.saved (when it was saved, in words)
(Screen artifact-reader "A saved creation")
(Part artifact-reader 10 buttons ((items ((button "Back to artifacts" back ((variant ghost)))
  (button "View it" view ((icon apps) (variant ghost) (on reader.viewable) (off reader.view)))
  (button "Read the source" source ((icon doc) (variant ghost) (on reader.view)))))))
(Row artifact-reader 10 tools)
(Part artifact-reader 12 buttons ((items ((button "Copy the text" copy ((variant ghost) (off reader.copied)))
  (button "Copied" copy ((variant ghost) (on reader.copied)))))))
(When artifact-reader 12 (is resource ready))
(When artifact-reader 12 (off reader.view))
(Row artifact-reader 12 tools)
(Part artifact-reader 20 header ((title (bind reader.title)) (title_id (bind reader.title-id))))
(Part artifact-reader 21 note ((text (words "Revision " (bind reader.revision) ", saved " (bind reader.saved)))))
(When artifact-reader 21 (has reader.saved))
(Part artifact-reader 30 island ((name view)))
(When artifact-reader 30 (on reader.view))
(Part artifact-reader 40 waiting ((label "Reading it")))
(When artifact-reader 40 (is resource loading))
(When artifact-reader 40 (off reader.view))
(Part artifact-reader 41 empty ((icon doc) (title "This hive can't show it here") (body "Ask the mind that made it to send you the text.")))
(When artifact-reader 41 (is resource unsupported))
(When artifact-reader 41 (off reader.view))
(Part artifact-reader 42 notice ((tone bad) (text (words "Could not read it: " (bind resource.error)))))
(When artifact-reader 42 (any ((is resource failed) (is resource forbidden))))
(When artifact-reader 42 (off reader.view))
(Part artifact-reader 43 actions ((items ((action "Try again" retry)))))
(When artifact-reader 43 (any ((is resource failed) (is resource forbidden))))
(When artifact-reader 43 (off reader.view))
(Part artifact-reader 44 island ((name text)))
(When artifact-reader 44 (is resource ready))
(When artifact-reader 44 (off reader.view))
