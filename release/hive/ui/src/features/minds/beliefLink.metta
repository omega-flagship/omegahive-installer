; Purpose: who sees a mind's own beliefs, as atoms lib_screens.metta composes: the setting its owner changes on the
; mind's Memory tab (features/minds/BeliefLinkSetting.tsx), which an admin may only narrow (Jon on #360, the hive's rule
; on #354). A mind's beliefs are seen through permissions, never passed around (Jon on #334), and a person's own mind, a
; researcher and a private or shared mind link nothing until their owner opts in (Jon on #354).
;
; Facts the page states each time (features/minds/beliefLink.ts):
;   the resource facts (value resource, resource.stale; data resource.error)
;   link.widen    this person may let its swarm see more: the mind's owner (the hive's rights.widen)
;   link.narrow   this person may only narrow it: an admin (rights.narrow without widen)
;   link.links    its swarm sees some of its beliefs now
;   link.busy     a change is being saved
;   link.failed   the last change was refused or failed; data link.error says why
;   the value link.choice   default, all, some or none: what the owner chose, or some while subjects are being picked
;   (count link.subjects)   the owner's subjects to tick: those its saved beliefs are about now, and any still chosen
;   (count link.linked)     an admin's subjects to untick: those linked now
; and draws link.value (the chooser's value), link.words.default and link.words.none (two choices' words, which follow
; the mind), link.now (what its swarm sees now, in words), link.why (why its default is what it is), and link.subjects
; and link.linked (id, label, on).

(Screen belief-link "Who sees its beliefs")

(Resource belief-link 1 ((waiting "Loading who sees its beliefs")
  (unsupported "This hive does not link a mind's beliefs to its swarm yet.")
  (failed "Could not load who sees its beliefs") (retry retry-link)))

; what applies now, for anyone who may see the mind
(Part belief-link 10 section ((title "Who sees its beliefs") (body (bind link.now))))
(When belief-link 10 (is resource ready))

; the owner's choice: each press is one write, but Some subjects writes nothing until one is ticked
(Part belief-link 20 chooser ((label "Who sees its beliefs") (value link.value) (action set-link) (waits link.busy)
  (options ((option default (bind link.words.default)) (option all "Every belief") (option some "Some subjects")
            (option none (bind link.words.none))))))
(When belief-link 20 (is resource ready))
(When belief-link 20 (on link.widen))

(Part belief-link 21 note ((text (bind link.why))))
(When belief-link 21 (is resource ready))
(When belief-link 21 (is link.choice default))

; an admin may narrow it but never let its swarm see more: link none, or untick a subject linked now
(Part belief-link 22 note ((text "Only its owner can let its swarm see more of its beliefs. You can narrow it.")))
(When belief-link 22 (is resource ready))
(When belief-link 22 (on link.narrow))

(Part belief-link 23 actions ((items ((action "Link none of its beliefs" link-none link.busy)))))
(When belief-link 23 (is resource ready))
(When belief-link 23 (on link.narrow))
(When belief-link 23 (on link.links))

(Part belief-link 30 fields ((items ((field checks "Subjects its swarm sees" link.subjects ((action pick-subject) (waits link.busy)))))))
(When belief-link 30 (is resource ready))
(When belief-link 30 (on link.widen))
(When belief-link 30 (is link.choice some))
(When belief-link 30 (has link.subjects))

(Part belief-link 31 note ((text "It holds no beliefs about a subject yet, so there is nothing to tick.")))
(When belief-link 31 (is resource ready))
(When belief-link 31 (on link.widen))
(When belief-link 31 (is link.choice some))
(When belief-link 31 (none link.subjects))

(Part belief-link 32 fields ((items ((field checks "Subjects its swarm sees" link.linked ((action pick-subject) (waits link.busy)))))))
(When belief-link 32 (is resource ready))
(When belief-link 32 (on link.narrow))
(When belief-link 32 (has link.linked))

(Part belief-link 40 notice ((tone bad) (text (words "Could not change who sees its beliefs: " (bind link.error)))))
(When belief-link 40 (is resource ready))
(When belief-link 40 (on link.failed))
