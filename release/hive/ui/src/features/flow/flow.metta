; The Flow studio (the Flow page, and Create's Flow bench), declared as atoms (screens/lib_screens.metta composes it).
; The studio itself is an iframe the page loads and talks to by message, so it is an island; so is the adopted
; revisions list, which loads its own data and asks before taking an adoption back.
;
; Facts the page states each time: can.adopt, and the standard resource facts (screens/resourceFacts.ts) for the
; studio: unsupported without a live hive connection, loading while its files arrive, failed when they could not load.

(Screen flow "Flow")
; what is adopted, and taking an adoption back (a hive that lists flows and their revisions)
(Part flow 10 island ((name flow-adoptions)))
(When flow 10 (on can.adopt))
; loading, no live connection, or could not load (the shared fragment: orders 20, 21 and 23)
(Resource flow 20 ((part waiting notice ((tone info) (text "Loading Flow studio…")))
  (part unsupported paragraph ((text "Flow studio requires a live Hive connection. The local authoring preview remains available separately.")))
  (part failed notice ((tone bad) (text (bind resource.error))))))
; the studio, once its files are in
(Part flow 30 island ((name flow-studio) (fill yes)))
(When flow 30 (is resource ready))
