; The Health page, one mind's card on it, and one issue in that card, declared as atoms (screens/lib_screens.metta
; composes them). The page composes each mind and each issue for its own facts, and the health screen stacks them.
;
; Facts the page states each time:
;   health: the standard resource facts (screens/resourceFacts.ts: the value resource, resource.stale, the data
;           resource.error); (count minds.all) (count minds.troubled); the value show (problems or all)
;   health-mind: (count mind.issues); the value mind.health (high, medium, low, ok or other)
;   health-issue: issue.recent issue.waiting issue.open

(Screen health "Health")
; parts the page still draws itself (islands): who answers health alerts, idle minds, sleep and spend
(Part health 10 island ((name health-mind)))
(Part health 20 island ((name idle-minds)))
(Part health 30 island ((name sleep-and-spend)))

; the health checks across minds, as they load: the shared fragment, orders 40 to 47
(Resource health 40 ((part waiting notice ((tone info) (text "Checking every mind…")))
  (unsupported "This hive or the demo does not report mind health yet.") (failed-title "Could not check health")
  (retry reload)))

; the totals, the filter between problems and all minds, and checking again
(Part health 50 tally ((label "Minds by health") (items ((item (bind totals.high) "needs attention" bad)
  (item (bind totals.medium) "errors" warn) (item (bind totals.low) "minor" low) (item (bind totals.ok) "healthy" good)))))
(When health 50 (is resource ready))
(Part health 51 segmented ((label "Which minds to show") (bind show)
  (options ((option problems "Problems") (option all "All minds")))))
(When health 51 (is resource ready))
(Part health 52 actions ((items ((action "Check again" reload checks.refreshing)))))
(When health 52 (is resource ready))

; the minds: those with problems, or all of them
(Part health 60 stack ((source minds.troubled) (frame card) (label "Minds with problems")))
(When health 60 (is show problems))
(When health 60 (has minds.troubled))
(Part health 61 stack ((source minds.all) (frame card) (label "All minds")))
(When health 61 (is show all))
(When health 61 (has minds.all))
(Part health 62 empty ((title "Nothing is failing") (body "Every mind's recent commands came back fine.")))
(When health 62 (is resource ready))
(When health 62 (is show problems))
(When health 62 (none minds.troubled))
(Part health 63 empty ((title "Nothing is failing") (body "Every mind's recent commands came back fine.")))
(When health 63 (is resource ready))
(When health 63 (is show all))
(When health 63 (none minds.all))

(Screen health-mind "A mind's health")
(Part health-mind 10 line ((title (bind mind.name)) (meta (bind mind.status)) (open mind) (badge "Needs attention") (tone bad)))
(When health-mind 10 (is mind.health high))
(Part health-mind 11 line ((title (bind mind.name)) (meta (bind mind.status)) (open mind) (badge "Errors") (tone warn)))
(When health-mind 11 (is mind.health medium))
(Part health-mind 12 line ((title (bind mind.name)) (meta (bind mind.status)) (open mind) (badge "Minor") (tone low)))
(When health-mind 12 (is mind.health low))
(Part health-mind 13 line ((title (bind mind.name)) (meta (bind mind.status)) (open mind) (badge "Healthy") (tone good)))
(When health-mind 13 (is mind.health ok))
(Part health-mind 14 line ((title (bind mind.name)) (meta (bind mind.status)) (open mind)))
(When health-mind 14 (is mind.health other))
(Part health-mind 20 stack ((source mind.issues) (frame inset) (label "Problems")))
(When health-mind 20 (has mind.issues))

(Screen health-issue "A problem")
(Part health-issue 10 disclosure ((badge (bind issue.kind)) (tone (bind issue.tone)) (title (bind issue.meaning))
  (meta (bind issue.meta)) (expanded issue.open) (action toggle-issue)))
(When health-issue 10 (on issue.recent))
(Part health-issue 11 disclosure ((badge (bind issue.kind)) (tone (bind issue.tone)) (title (bind issue.meaning))
  (meta (bind issue.meta)) (note "earlier, not counted") (quiet yes) (expanded issue.open) (action toggle-issue)))
(When health-issue 11 (off issue.recent))
(Part health-issue 20 facts ((label "What to do") (rows ((row "What to do" (bind issue.hint))))))
(When health-issue 20 (on issue.open))
(Part health-issue 21 code ((label "What it ran and what came back") (text (bind issue.example))))
(When health-issue 21 (on issue.open))
(Part health-issue 30 actions ((items ((action "Open approvals" open-approvals)))))
(When health-issue 30 (on issue.open))
(When health-issue 30 (on issue.waiting))
(Part health-issue 31 actions ((items ((action "Open the mind's trace" open-trace)))))
(When health-issue 31 (on issue.open))
(When health-issue 31 (off issue.waiting))
