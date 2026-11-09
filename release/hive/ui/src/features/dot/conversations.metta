; Recent conversations (#/conversations), declared as atoms (screens/lib_screens.metta composes them): the minds this
; person has chatted with lately, newest first, each opening straight into its Chat tab.
;
; Facts the page states each time: (count conversations).

(Screen conversations "Recent conversations")
; one row per mind: its orb, its name, its swarm, how it is and when this person last wrote, then "Open chat"
(RolePart conversations 10 collection ((source conversations.rows) (title name) (summary detail) (meta (go))
  (orb hue) (status status) (open chat) (label "Recent conversations")))
(When conversations 10 (has conversations))
(Part conversations 20 empty ((icon chat) (title "No conversations yet")
  (body "When you message a mind, it is listed here so you can go straight back to its chat.")))
(When conversations 20 (none conversations))
(Part conversations 21 buttons ((items ((button "Find a mind" find-mind)))))
(When conversations 21 (none conversations))
