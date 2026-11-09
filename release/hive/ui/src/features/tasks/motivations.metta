; The Motivations page (#/motivations) and one motivation (#/motivations/<id>), declared as atoms
; (screens/lib_screens.metta composes them). Motivations are why the work exists, held by a person, a swarm or a mind;
; Tasks are the work itself, filed under them. The page states the facts; MeTTa decides every part that shows.
;
; Facts the list states each time: the standard resource facts (screens/resourceFacts.ts: loading until the hive's
; motivations are read, unsupported on a hive without them, else ready); the flags create.may (this person may make
; one), making (the new-motivation form is open), evolve.shown (OmegaEvolve's objective is offered), counts.partial (a
; read stopped early, so counts are floors); the counts motivations.all, tasks.unsorted and one per group
; (group.mine, group.team, group.mind, group.people).
; Each card (motivation-card) states card.why and (count card.tasks), and counts.partial.
; The new-motivation form (motivation-new) states the value new.visibility (private, shared or public), the flags
; new.problem, new.rights, new.failed and people.reading, and (count people.all).
;
; One motivation states the resource facts (loading until it is read), motivation.found, motivation.gone (not there for
; this person), file.may (it may take tasks), filing (the file-tasks box is open), file.ok and file.failed (how the
; last filing went); its card (motivation-about) states editable, editing, words.changed, words.failed, m.why,
; (count m.tasks), counts.partial, the value m.visibility, sharing and controls.failed, and draws status.value,
; visibility.value and the words visibility.<choice> for its two choosers, held by controls.busy; the people box
; (motivation-sharing) states people.reading, (count people.all) and share.problem; the file-tasks box
; (motivation-file) states (count file.candidates) and file.has-subtasks.

; ================================================================ the list

(Screen motivations "Motivations")

; New motivation, for anyone who may make one, while the form is closed
(Part motivations 5 actions ((tone primary) (items ((action "New motivation" new-motivation - plus)))))
(When motivations 5 (on create.may))
(When motivations 5 (none-of ((is resource unsupported))))
(When motivations 5 (off making))

; what a motivation is, and the way to the work itself
(Part motivations 10 paragraph ((text "Motivations are why the work exists: aims held by a person, a swarm or a mind. Tasks are the work itself, filed under them; one task can serve several, and counts once.")))
(Part motivations 11 line ((title "Open Tasks →") (open tasks)))

; making one: its own small screen, framed as a card
(Part motivations 20 stack ((source create.form) (frame card) (label "New motivation")))
(When motivations 20 (on making))

; OmegaEvolve's objective, read-only, when the app offers one (drawn by its own module)
(Part motivations 25 island ((name evolve-objective)))
(When motivations 25 (on evolve.shown))

; loading, and a hive that keeps no motivations (the shared fragment, orders 30 and 31)
(Resource motivations 30 ((part waiting waiting ((label "Loading motivations")))
  (part unsupported empty ((icon target) (title "Not on this hive yet") (body "This hive does not keep motivations yet. Tasks work as before.")))))

; none yet
(Part motivations 40 empty ((icon target) (title "No motivations yet") (body "Name the first one: what is all this work for?")))
(When motivations 40 (is resource ready))
(When motivations 40 (none motivations.all))
(When motivations 40 (on create.may))
(Part motivations 41 empty ((icon target) (title "No motivations yet") (body "None you can see yet. People, swarm owners and minds name them.")))
(When motivations 41 (is resource ready))
(When motivations 41 (none motivations.all))
(When motivations 41 (off create.may))

; grouped by whose they are: each group a heading with its count, then its cards
(Part motivations 50 section ((title (words "Yours " (bind group.mine)))))
(When motivations 50 (is resource ready))
(When motivations 50 (has group.mine))
(Part motivations 51 stack ((source group.mine.cards) (columns auto) (frame card) (label "Yours")))
(When motivations 51 (is resource ready))
(When motivations 51 (has group.mine))
(Part motivations 52 section ((title (words "Swarms " (bind group.team)))))
(When motivations 52 (is resource ready))
(When motivations 52 (has group.team))
(Part motivations 53 stack ((source group.team.cards) (columns auto) (frame card) (label "Swarms")))
(When motivations 53 (is resource ready))
(When motivations 53 (has group.team))
(Part motivations 54 section ((title (words "Named by minds " (bind group.mind)))))
(When motivations 54 (is resource ready))
(When motivations 54 (has group.mind))
(Part motivations 55 stack ((source group.mind.cards) (columns auto) (frame card) (label "Named by minds")))
(When motivations 55 (is resource ready))
(When motivations 55 (has group.mind))
(Part motivations 56 section ((title (words "Shared with you " (bind group.people)))))
(When motivations 56 (is resource ready))
(When motivations 56 (has group.people))
(Part motivations 57 stack ((source group.people.cards) (columns auto) (frame card) (label "Shared with you")))
(When motivations 57 (is resource ready))
(When motivations 57 (has group.people))

; a read that stopped early
(Part motivations 60 notice ((tone info) (text "The hive did not finish listing everything, so these counts may be short. Tasks it did not reach are not counted as under no motivation.")))
(When motivations 60 (is resource ready))
(When motivations 60 (on counts.partial))

; the live tasks under no motivation this person can see, and the way to sort them
(Part motivations 70 line ((title (bind unsorted.text)) (open unsorted) (badge "Sort these →") (tone info)))
(When motivations 70 (is resource ready))
(When motivations 70 (has tasks.unsorted))
(Part motivations 71 line ((title (bind unsorted.text)) (open unsorted)))
(When motivations 71 (is resource ready))
(When motivations 71 (none tasks.unsorted))

; ---------------------------------------------------------------- one card in a group
(Screen motivation-card "A motivation")
(Part motivation-card 10 line ((title (bind card.title)) (open motivation) (badge (bind card.status)) (tone (bind card.tone)) (dim card.quiet)))
(Part motivation-card 20 paragraph ((text (bind card.why))))
(When motivation-card 20 (on card.why))
(Part motivation-card 30 progress ((source card.progress) (text (bind card.progress.text)) (partial counts.partial)))
(When motivation-card 30 (has card.tasks))
(Part motivation-card 31 note ((text "No tasks you can see under it yet")))
(When motivation-card 31 (none card.tasks))
(When motivation-card 31 (off counts.partial))
(Part motivation-card 32 note ((text (words "No tasks found under it yet; this " (bind partial.words)))))
(When motivation-card 32 (none card.tasks))
(When motivation-card 32 (on counts.partial))
(Part motivation-card 40 note ((text (bind card.meta))))

; ---------------------------------------------------------------- making one (a person their own; a swarm's owner or an admin a swarm's)
(Screen motivation-new "New motivation")
; what it is for, why, and whose: a form the page draws (a multi-line why, and choices only some people may take)
(Part motivation-new 10 island ((name create-words)))
(Part motivation-new 20 switcher ((label "Who can see it") (bind new.visibility)
  (options ((option private (bind vis.private)) (option shared (bind vis.shared)) (option public (bind vis.public))))))
; shared is a real choice: the people it is shared with
(Part motivation-new 21 fields ((items ((field checks "Shared with" new.people ((action pick-new-person)))))))
(When motivation-new 21 (is new.visibility shared))
(When motivation-new 21 (off people.reading))
(When motivation-new 21 (has people.all))
(Part motivation-new 22 note ((text "Reading people…")))
(When motivation-new 22 (is new.visibility shared))
(When motivation-new 22 (on people.reading))
(Part motivation-new 23 note ((text "No one else is on this hive yet. Invite people from People first.")))
(When motivation-new 23 (is new.visibility shared))
(When motivation-new 23 (off people.reading))
(When motivation-new 23 (none people.all))
(Part motivation-new 24 note ((text (bind new.problem))))
(When motivation-new 24 (is new.visibility shared))
(When motivation-new 24 (on new.problem))
; why this person cannot have their own
(Part motivation-new 25 note ((text (bind new.rights))))
(When motivation-new 25 (on new.rights))
(Part motivation-new 26 notice ((tone bad) (text (bind new.error))))
(When motivation-new 26 (on new.failed))
(Part motivation-new 30 actions ((tone primary) (items ((action (bind new.save) make-motivation new.held)))))
(Row motivation-new 30 make)
(Part motivation-new 31 actions ((items ((action "Not now" cancel-new)))))
(Row motivation-new 31 make)

; ================================================================ one motivation

(Screen motivation "A motivation")

; loading, and a hive that keeps no motivations (the shared fragment, orders 10 and 11)
(Resource motivation 10 ((part waiting waiting ((label "Loading the motivation")))
  (part unsupported empty ((icon target) (title "Not on this hive yet") (body "This hive does not keep motivations yet.")))))
(Part motivation 12 actions ((items ((action "All motivations" all-motivations)))))
(When motivation 12 (is resource unsupported))
; made private, or gone
(Part motivation 15 empty ((icon target) (title "Not there for you") (body "This motivation is not there for you: it may have been made private, or it no longer exists.")))
(When motivation 15 (on motivation.gone))
(Part motivation 16 actions ((items ((action "All motivations" all-motivations)))))
(When motivation 16 (on motivation.gone))

; the motivation itself: its own screen, framed as a card
(Part motivation 20 stack ((source about) (frame card)))
(When motivation 20 (on motivation.found))

; the tasks under it
(Part motivation 30 section ((title (words "Tasks under it " (bind tasks.count)))))
(When motivation 30 (on motivation.found))
(Part motivation 31 note ((text (words "(" (bind partial.words) ")"))))
(When motivation 31 (on motivation.found))
(When motivation 31 (on counts.partial))
(Part motivation 32 line ((title "Open in Tasks →") (open tasks)))
(When motivation 32 (on motivation.found))
; filing tasks under it, for whoever may edit it while it takes tasks
(Part motivation 40 buttons ((items ((button "File tasks under it" file-open ((icon plus)))))))
(When motivation 40 (on motivation.found))
(When motivation 40 (on file.may))
(When motivation 40 (off filing))
(Part motivation 41 notice ((tone info) (text (bind file.message))))
(When motivation 41 (on motivation.found))
(When motivation 41 (on file.may))
(When motivation 41 (on file.ok))
(Part motivation 42 notice ((tone bad) (text (bind file.message))))
(When motivation 42 (on motivation.found))
(When motivation 42 (on file.may))
(When motivation 42 (on file.failed))
(Part motivation 43 stack ((source file.form) (frame inset) (label "File tasks under this motivation")))
(When motivation 43 (on motivation.found))
(When motivation 43 (on file.may))
(When motivation 43 (on filing))
; the tasks themselves: the task board the Tasks page and the swarm page share
(Part motivation 50 island ((name motivation-tasks)))
(When motivation 50 (on motivation.found))
(Depth motivation 50 ground)

; ---------------------------------------------------------------- its card
(Screen motivation-about "About this motivation")
(Part motivation-about 10 tally ((items ((item (bind m.status) "" (bind m.tone))))))
(Row motivation-about 10 head)
(Part motivation-about 11 note ((text (bind m.meta))))
(Row motivation-about 11 head)
; its why, editable in place against the revision the person saw
(Part motivation-about 20 paragraph ((text (bind m.why))))
(When motivation-about 20 (on m.why))
(When motivation-about 20 (off editing))
(Part motivation-about 21 note ((text "No why written yet.")))
(When motivation-about 21 (off m.why))
(When motivation-about 21 (off editing))
(Part motivation-about 22 buttons ((items ((button "Edit the words" edit-words ((icon edit) (variant ghost)))))))
(When motivation-about 22 (on editable))
(When motivation-about 22 (off editing))
; the title and the multi-line why, drawn by the page
(Part motivation-about 23 island ((name edit-words)))
(When motivation-about 23 (on editing))
(Part motivation-about 24 notice ((tone info) (text "Someone changed this motivation since you began editing. Saving will not overwrite their change: the hive will refuse it, and you can look again first.")))
(When motivation-about 24 (on editing))
(When motivation-about 24 (on words.changed))
(When motivation-about 24 (off words.failed))
(Part motivation-about 25 notice ((tone bad) (text (bind words.error))))
(When motivation-about 25 (on editing))
(When motivation-about 25 (on words.failed))
(Part motivation-about 26 actions ((tone primary) (items ((action (bind words.save) save-words words.held)))))
(Row motivation-about 26 words)
(When motivation-about 26 (on editing))
(Part motivation-about 27 actions ((items ((action "Cancel" cancel-words)))))
(Row motivation-about 27 words)
(When motivation-about 27 (on editing))
; the tasks under it, each counted once
(Part motivation-about 30 progress ((source m.progress) (text (bind m.progress.text)) (partial counts.partial)))
(When motivation-about 30 (has m.tasks))
(Part motivation-about 31 note ((text "No tasks you can see under it yet")))
(When motivation-about 31 (none m.tasks))
(When motivation-about 31 (off counts.partial))
(Part motivation-about 32 note ((text (words "No tasks found under it yet; this " (bind partial.words)))))
(When motivation-about 32 (none m.tasks))
(When motivation-about 32 (on counts.partial))
(Part motivation-about 40 facts ((label "About it") (rows ((row "Who can see it" (bind m.visibility))
  (row "Budgets and spend" "The hive reports these per motivation in its next phase, budgets and spend kept apart. Nothing is estimated here.")))))
; status and who can see it, for whoever may edit it: each choice writes the motivation, so the arrow keys move without
; choosing (one tab stop; Space, Enter or a press chooses), and both wait while a change is being saved. Shared opens the
; people box rather than writing at once; its words follow whose it is (visibility.<choice>, stated by the page).
(Part motivation-about 50 chooser ((label "Status") (value status.value) (action set-status) (waits controls.busy)
  (options ((option active "Active") (option paused "Paused") (option achieved "Achieved") (option retired "Retired")))))
(Row motivation-about 50 controls)
(When motivation-about 50 (on editable))
(Part motivation-about 51 chooser ((label "Who can see it") (value visibility.value) (action set-visibility) (waits controls.busy)
  (options ((option private (bind visibility.private)) (option shared (bind visibility.shared)) (option public (bind visibility.public))))))
(Row motivation-about 51 controls)
(When motivation-about 51 (on editable))
(Part motivation-about 52 actions ((items ((action "Change who" edit-people controls.busy)))))
(Row motivation-about 52 controls)
(When motivation-about 52 (on editable))
(When motivation-about 52 (is m.visibility shared))
(When motivation-about 52 (off sharing))
(Part motivation-about 53 stack ((source sharing.form) (frame inset) (label "Who it is shared with")))
(When motivation-about 53 (on editable))
(When motivation-about 53 (on sharing))
(Part motivation-about 54 note ((text "Status is for people: it never pauses, cancels or reassigns a task. There is no delete; Retired is the end.")))
(When motivation-about 54 (on editable))
(Part motivation-about 55 notice ((tone bad) (text (bind controls.error))))
(When motivation-about 55 (on editable))
(When motivation-about 55 (on controls.failed))

; ---------------------------------------------------------------- the people it is shared with
(Screen motivation-sharing "Who it is shared with")
(Part motivation-sharing 10 fields ((items ((field checks "Shared with" share.people ((action pick-share-person)))))))
(When motivation-sharing 10 (off people.reading))
(When motivation-sharing 10 (has people.all))
(Part motivation-sharing 11 note ((text "Reading people…")))
(When motivation-sharing 11 (on people.reading))
(Part motivation-sharing 12 note ((text "No one else is on this hive yet. Invite people from People first.")))
(When motivation-sharing 12 (off people.reading))
(When motivation-sharing 12 (none people.all))
(Part motivation-sharing 13 note ((text (bind share.problem))))
(When motivation-sharing 13 (on share.problem))
(Part motivation-sharing 20 actions ((tone primary) (items ((action (bind share.save) save-sharing share.held)))))
(Row motivation-sharing 20 share)
(Part motivation-sharing 21 actions ((items ((action "Cancel" cancel-sharing)))))
(Row motivation-sharing 21 share)

; ---------------------------------------------------------------- filing tasks under it
(Screen motivation-file "File tasks under this motivation")
(Part motivation-file 10 search ((label "Find a task") (placeholder "Find a task…") (bind file.query)))
(Part motivation-file 20 fields ((items ((field checks "Tasks you can file" file.candidates ((action pick-task)))))))
(When motivation-file 20 (has file.candidates))
(Part motivation-file 21 note ((text (bind file.none))))
(When motivation-file 21 (none file.candidates))
; their subtasks come along when asked
(Part motivation-file 22 fields ((items ((field checks "Subtasks" file.subtasks ((action pick-subtasks)))))))
(When motivation-file 22 (on file.has-subtasks))
(Part motivation-file 30 note ((text (bind file.means))))
(Part motivation-file 40 actions ((tone primary) (items ((action (bind file.label) file-tasks file.held)))))
(Row motivation-file 40 file)
(Part motivation-file 41 actions ((items ((action "Done" file-close)))))
(Row motivation-file 41 file)

; ================================================================ OmegaEvolve's objective (#/motivations/omegaevolve)
(Screen evolve-objective "OmegaEvolve’s objective")
(Part evolve-objective 10 paragraph ((text "OmegaEvolve is not turned on in this hive, so its objective is not shown.")))
(When evolve-objective 10 (off evolve.on))
(Part evolve-objective 20 header ((title (bind evolve.title))))
(When evolve-objective 20 (on evolve.on))
(Part evolve-objective 21 paragraph ((text "Owned by the OmegaEvolve app. It is fixed: it cannot amend itself, and nobody edits it here.")))
(When evolve-objective 21 (on evolve.on))
(Part evolve-objective 22 paragraph ((text "Read from the app each time you open it, so it is never a copy that can drift.")))
(When evolve-objective 22 (on evolve.on))
(Part evolve-objective 23 paragraph ((text "Filing tasks under it arrives when the hive mirrors it as a motivation (its next phase). Until then, offer work towards it in the growth lab.")))
(When evolve-objective 23 (on evolve.on))
(Part evolve-objective 30 actions ((tone primary) (items ((action "Open the growth lab" open-lab - flask)))))
(When evolve-objective 30 (on evolve.on))
(When evolve-objective 30 (on evolve.home))
