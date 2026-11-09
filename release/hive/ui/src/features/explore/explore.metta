; The Explore page (everything in the hive, filtered and grouped your way) and one of my groups on it, declared as
; atoms (screens/lib_screens.metta composes them). The page composes each of my groups for its own facts, and the
; explore screen stacks them.
;
; Facts the page states each time:
;   explore: the resource facts (value resource, resource.stale, resource.empty; data resource.error); the flags
;            view.saved (a saved view is chosen), can.groups (this hive keeps my groups), groups.open (My groups is
;            open, and its button says so), explore.grouped (the answer comes in groups), groupby.1 groupby.2 groupby.3 (a grouping in that
;            place), groupby.room (another grouping may be added); the counts (count explore.groups) (count
;            explore.filters) and one per filter facet: (count facet.group) (count facet.tag) … (count facet.spend)
;   explore-group: group.editing (being renamed), group.problem (the new name will not do); can.rename can.remove
;
; The things themselves, arranged by hand (dragged, moved up and down, pinned, nested as a holarchy, tagged and put in
; groups row by row), are drawn by the page as one of two islands: in groups, or as one list.

(Screen explore "Explore")

; ---------- the words, the layout, and the saved views, side by side
(Part explore 10 search ((label "Search") (placeholder "Search names, purposes, ids") (bind q)))
(Row explore 10 tools)
(Part explore 11 segmented ((label "Layout") (bind layout) (options ((option list "List") (option grid "Grid") (option tree "Holarchy")))))
(Row explore 11 tools)
(Part explore 12 menus ((menus ((menu "Saved views" view explore.views "Unsaved view")))))
(Row explore 12 tools)
(Part explore 13 buttons ((items ((button "Save view" save-view)))))
(Row explore 13 tools)
(When explore 13 (off view.saved))
(Part explore 14 buttons ((items ((button "Save" save-view) (button "Save as…" save-as)))))
(Row explore 14 tools)
(When explore 14 (on view.saved))
(Part explore 15 buttons ((tour my-groups) (items ((button "My groups" toggle-groups ((expanded groups.open)))))))
(Row explore 15 tools)
(When explore 15 (on can.groups))
(Part explore 16 buttons ((items ((button "Delete view" delete-view)))))
(Row explore 16 tools)
(When explore 16 (on view.saved))

; ---------- which kinds of thing, each with how many there are: chips that press on and off, several at once
(Part explore 20 pills ((label "Kinds") (bind explore.kinds.on) (multi yes) (action kind) (source explore.kinds)))

; ---------- how they are grouped: up to three facets, in order, and clearing the filters
(Part explore 30 note ((text "Group by")))
(Row explore 30 grouping)
(Part explore 31 buttons ((items ((button (words (bind groupby.1.label) " ×") ungroup-1 ((aria "Stop grouping by {groupby.1.label}")))))))
(Row explore 31 grouping)
(When explore 31 (on groupby.1))
(Part explore 32 buttons ((items ((button "←" earlier-2 ((aria "Group by {groupby.2.label} earlier") (variant ghost)))
  (button (words (bind groupby.2.label) " ×") ungroup-2 ((aria "Stop grouping by {groupby.2.label}")))))))
(Row explore 32 grouping)
(When explore 32 (on groupby.2))
(Part explore 33 buttons ((items ((button "←" earlier-3 ((aria "Group by {groupby.3.label} earlier") (variant ghost)))
  (button (words (bind groupby.3.label) " ×") ungroup-3 ((aria "Stop grouping by {groupby.3.label}")))))))
(Row explore 33 grouping)
(When explore 33 (on groupby.3))
(Part explore 34 menus ((menus ((menu "Add a grouping" add-grouping explore.unused "+ add")))))
(Row explore 34 grouping)
(When explore 34 (on groupby.room))
(Part explore 35 buttons ((items ((button "Clear filters" clear-filters ((variant ghost)))))))
(Row explore 35 grouping)
(When explore 35 (has explore.filters))

; ---------- my groups: private to the person who made them; renaming or deleting one never touches its members
(Part explore 40 section ((title "My groups") (body "Only you see these.")))
(When explore 40 (on can.groups))
(When explore 40 (on groups.open))
(Part explore 41 note ((text "No groups yet. Add one from any row’s “Groups and tags”.")))
(When explore 41 (on can.groups))
(When explore 41 (on groups.open))
(When explore 41 (none explore.groups))
(Part explore 42 stack ((source explore.groups) (label "My groups")))
(When explore 42 (on can.groups))
(When explore 42 (on groups.open))
(When explore 42 (has explore.groups))

; ---------- reading what is here: the shared resource states (lib_screens.metta Resource), orders 50 to 57
(Resource explore 50 ((waiting "Loading everything in this hive") (unsupported "This hive does not offer the explorer yet.")
  (unsupported-icon ban) (part failed empty ((icon alert) (title "Could not load") (body (bind resource.error)))) (retry retry)))

; ---------- what matches, arranged by hand: in groups, or one list
(Part explore 60 empty ((icon search) (title "Nothing matches") (body "Try fewer filters or another search.")))
(When explore 60 (is resource ready))
(When explore 60 (on resource.empty))
(Part explore 61 island ((name explore-groups)))
(When explore 61 (is resource ready))
(When explore 61 (off resource.empty))
(When explore 61 (on explore.grouped))
(Part explore 62 island ((name explore-items)))
(When explore 62 (is resource ready))
(When explore 62 (off resource.empty))
(When explore 62 (off explore.grouped))

(Part explore 70 note ((text "Drag (or use ↑ ↓) to arrange, ☆ to pin. Your arrangement is yours alone and never changes how the hive is organised.")))
(Depth explore 70 ground)

; ---------- the filters, in a side column: each facet the answer has more than one value for, with its counts
(Part explore 80 section ((title "Filters") (region_label "Filters")))
(Region explore 80 aside)
(When explore 80 (any ((has facet.group) (has facet.tag) (has facet.state) (has facet.where) (has facet.kind) (has facet.swarm)
  (has facet.purpose) (has facet.role) (has facet.health) (has facet.visibility) (has facet.owner) (has facet.active) (has facet.spend))))
(Part explore 81 fields ((items ((field checks "My groups" facet.group ((action filter)))))))
(Region explore 81 aside)
(When explore 81 (has facet.group))
(Part explore 82 fields ((items ((field checks "Tag" facet.tag ((action filter)))))))
(Region explore 82 aside)
(When explore 82 (has facet.tag))
(Part explore 83 fields ((items ((field checks "State" facet.state ((action filter)))))))
(Region explore 83 aside)
(When explore 83 (has facet.state))
(Part explore 84 fields ((items ((field checks "Where" facet.where ((action filter)))))))
(Region explore 84 aside)
(When explore 84 (has facet.where))
(Part explore 85 fields ((items ((field checks "Kind" facet.kind ((action filter)))))))
(Region explore 85 aside)
(When explore 85 (has facet.kind))
(Part explore 86 fields ((items ((field checks "Swarm" facet.swarm ((action filter)))))))
(Region explore 86 aside)
(When explore 86 (has facet.swarm))
(Part explore 87 fields ((items ((field checks "Purpose" facet.purpose ((action filter)))))))
(Region explore 87 aside)
(When explore 87 (has facet.purpose))
(Part explore 88 fields ((items ((field checks "Role" facet.role ((action filter)))))))
(Region explore 88 aside)
(When explore 88 (has facet.role))
(Part explore 89 fields ((items ((field checks "Health" facet.health ((action filter)))))))
(Region explore 89 aside)
(When explore 89 (has facet.health))
(Part explore 90 fields ((items ((field checks "Visibility" facet.visibility ((action filter)))))))
(Region explore 90 aside)
(When explore 90 (has facet.visibility))
(Part explore 91 fields ((items ((field checks "Owner" facet.owner ((action filter)))))))
(Region explore 91 aside)
(When explore 91 (has facet.owner))
(Part explore 92 fields ((items ((field checks "Last active" facet.active ((action filter)))))))
(Region explore 92 aside)
(When explore 92 (has facet.active))
(Part explore 93 fields ((items ((field checks "Spend" facet.spend ((action filter)))))))
(Region explore 93 aside)
(When explore 93 (has facet.spend))

(Screen explore-group "One of my groups")
; its name and size, with Rename and Delete beside it
(Part explore-group 10 line ((title (bind group.name)) (meta (bind group.size))))
(Row explore-group 10 group-row)
(When explore-group 10 (off group.editing))
(Part explore-group 11 buttons ((items ((button "Rename" rename ((aria "Rename {group.name}") (variant ghost)))))))
(Row explore-group 11 group-row)
(When explore-group 11 (off group.editing))
(When explore-group 11 (on can.rename))
(Part explore-group 12 buttons ((items ((button "Delete…" remove ((aria "Delete {group.name}") (variant ghost)))))))
(Row explore-group 12 group-row)
(When explore-group 12 (off group.editing))
(When explore-group 12 (on can.remove))
; renaming it: Enter keeps the new name, Escape or leaving the field keeps the old one
(Part explore-group 20 rename ((label (words "New name for " (bind group.name))) (value (bind group.name)) (action rename-save)
  (cancel_action rename-cancel) (maxlength 60)))
(When explore-group 20 (on group.editing))
(Part explore-group 21 notice ((tone bad) (text (bind group.problem))))
(When explore-group 21 (on group.editing))
(When explore-group 21 (on group.problem))
