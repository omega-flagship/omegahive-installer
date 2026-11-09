; The Swarms page and one swarm on it, declared as atoms (screens/lib_screens.metta composes them). The page composes
; each swarm for its own facts, and the swarms screen stacks them as cards. One swarm's own page is SwarmView.tsx.
;
; Facts the page states each time:
;   swarms: (count swarms.live) (count wanderers) viewer.admin can.restore
;   swarms-swarm: swarm.described swarm.services_known (count swarm.services) sim

(Screen swarms "Swarms")
; the page's two ways in: bring an agent from outside, or start a swarm
(Part swarms 5 buttons ((items ((button "Add an outside agent" connect ((icon link)))
  (button "Start a swarm" launch ((icon sparkles) (variant primary)))))))

; every swarm that is not archived, oldest first, each its own composed card
(Part swarms 10 stack ((source swarms.rows) (frame card) (columns auto) (label "Swarms")))
(When swarms 10 (has swarms.live))
(Part swarms 11 empty ((icon swarms) (title "No swarms yet")
  (body "A swarm is a group of minds with a shared purpose and a commons of beliefs.")))
(When swarms 11 (none swarms.live))
(Part swarms 12 actions ((tone primary) (items ((action "Start a swarm" launch - sparkles)))))
(When swarms 12 (none swarms.live))

; archived swarms, so Restore stays reachable (admins, on a hive that can restore): the list loads its own data and
; asks before restoring, so the page draws it (an island)
(Part swarms 20 island ((name archived-swarms)))
(When swarms 20 (on viewer.admin))
(When swarms 20 (on can.restore))

; minds that belong to no swarm
(Part swarms 30 section ((title "Wanderers · no swarm")))
(When swarms 30 (has wanderers))
(RolePart swarms 31 collection ((source wanderers) (title name) (orb hue) (status status) (open mind)
  (label "Wanderers · no swarm")))
(When swarms 31 (has wanderers))

(Screen swarms-swarm "A swarm")
; its minds circling a glow in the swarm's hue; pressing it, or the name, opens the swarm
(Part swarms-swarm 10 orrery ((hue swarm.hue) (minds swarm.minds) (open swarm) (aria "Open {swarm.name}")))
(Part swarms-swarm 20 line ((title (bind swarm.name)) (open swarm)))
(Part swarms-swarm 21 note ((text (bind swarm.description))))
(When swarms-swarm 21 (on swarm.described))
(Part swarms-swarm 22 note ((text "No description.")))
(When swarms-swarm 22 (off swarm.described))

; how many minds, how many awake, its beliefs and what its minds have spent (marked when the costs are simulated)
(Part swarms-swarm 30 tally ((label (words "About " (bind swarm.name)))
  (items ((item (bind swarm.minds_n) (bind swarm.minds_word) info) (item (bind swarm.awake_n) "awake" info)
    (item (bind swarm.beliefs_n) (bind swarm.beliefs_word) info) (item (bind swarm.spend) "spent" info)))))
(When swarms-swarm 30 (off sim))
(Part swarms-swarm 31 tally ((label (words "About " (bind swarm.name)))
  (items ((item (bind swarm.minds_n) (bind swarm.minds_word) info) (item (bind swarm.awake_n) "awake" info)
    (item (bind swarm.beliefs_n) (bind swarm.beliefs_word) info) (item (bind swarm.spend) "spent (simulated)" warn)))))
(When swarms-swarm 31 (on sim))

; the services it offers other swarms
(Part swarms-swarm 40 facts ((label "Offered services") (rows ((row "Services for other swarms" (bind swarm.services_text))))))
(When swarms-swarm 40 (has swarm.services))
(Part swarms-swarm 41 facts ((label "Offered services") (rows ((row "Services for other swarms" "No public services offered.")))))
(When swarms-swarm 41 (on swarm.services_known))
(When swarms-swarm 41 (none swarm.services))
(Part swarms-swarm 42 facts ((label "Offered services") (rows ((row "Services for other swarms" "Service information unavailable.")))))
(When swarms-swarm 42 (off swarm.services_known))

; adding to it: a new mind, or an agent from outside
(Part swarms-swarm 50 buttons ((items ((button "New mind here" new-mind ((icon plus) (variant ghost)))
  (button "Add an outside agent" connect-here ((icon link) (variant ghost)))))))
