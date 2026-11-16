; The role library and one open role, declared as atoms (screens/lib_screens.metta composes them).
; Facts the library states each time: (count roles.all), roles.can-create, and the standard resource facts
; (screens/resourceFacts.ts: the value resource, resource.stale, the data resource.error). For the open role:
; (count role.minds) role.picked.

(Screen roles "Roles")
; New role, for a hive that can create roles (the press comes back as the intent create-role)
(Part roles 5 actions ((tone primary) (items ((action "New role" create-role - plus)))))
(When roles 5 (on roles.can-create))
(When roles 5 (none-of ((is resource forbidden) (is resource unsupported))))
; where the library is: loading, not offered here, admins only, could not load, a failed refresh (the shared fragment,
; orders 10 to 17)
(Resource roles 10 ((waiting "Loading roles") (unsupported "This hive or the demo does not have a role library.")
  (forbidden "Ask an admin of this hive to change roles.") (failed "Could not load roles") (retry retry)))
; the library sits in a narrow column, so it stays a list in every look
(Part roles 20 list ((source roles.all) (title title) (summary summary) (meta (kind minds)) (open role) (label "Roles")
  (hue hue) (current (bind roles.open))))
(When roles 20 (has roles.all))
(Part roles 21 empty ((title "No roles yet") (body "Create one with New role.")))
(When roles 21 (is resource ready))
(When roles 21 (none roles.all))
(When roles 21 (on roles.can-create))
(Part roles 22 empty ((title "No roles yet")))
(When roles 22 (is resource ready))
(When roles 22 (none roles.all))
(When roles 22 (off roles.can-create))

(Screen role "A role")
; the role's editor: a form with a live preview, a model picker and its own rules, drawn by the page (an island)
(Part role 10 island ((name role-form)))
(When role 10 (on role.picked))
(Part role 20 section ((title "Minds with this role")))
(When role 20 (on role.picked))
(RolePart role 21 collection ((source role.minds) (title name) (meta (spent)) (open mind) (label "Minds with this role")
  (orb hue) (status status)))
(When role 21 (on role.picked))
(When role 21 (has role.minds))
(Part role 22 notice ((tone info) (text "None yet. Pick it when you create a mind or start a swarm.")))
(When role 22 (on role.picked))
(When role 22 (none role.minds))
; save, duplicate and remove: they read the editor's unsaved changes, so the page draws them too
(Part role 30 island ((name role-commands)))
(When role 30 (on role.picked))
(Part role 40 empty ((title "Pick a role")
  (body "A role sets a mind's prompt, its default model and budget, and what it must ask before doing. Edit a role and every mind that has it follows.")))
(When role 40 (off role.picked))
