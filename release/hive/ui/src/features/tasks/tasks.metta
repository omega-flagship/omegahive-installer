; The Tasks page, declared as atoms (screens/lib_screens.metta composes it). Tasks are the work; Motivations are the why.
; Facts the page states each time: the counts (count swarms) (count tasks.shown) (count tasks.unsorted); the flags
; motivations.supported (this hive lists Motivations), counts.partial (a read stopped early, so counts by motivation are
; floors), motivation.chosen (filtered to one motivation you can read), motivation.why (it says why), motivation.missing
; (the motivation in the address is not there for you); and the values view (board or list) and filter.motivation
; (any, one or unsorted).
; The tasks themselves, their cards, decisions and quick add, are the task board the swarm page shares: an island, in
; columns or as one list, as the person chose.

(Screen tasks "Tasks")

; ---------- before any swarm exists
(Part tasks 5 empty ((icon columns) (title "No swarms yet") (body "Tasks belong to a swarm. Start one first.")))
(When tasks 5 (none swarms))

; ---------- which swarm: every swarm, or one
(Part tasks 10 tabs ((label "Swarm") (bind swarm) (source tasks.swarms)))
(When tasks 10 (has swarms))

; ---------- which motivation: any, one, or the Unsorted (quiet, never hidden)
(Part tasks 20 pills ((label "Filter by motivation") (icon target) (bind motivation) (source tasks.motivations)
  (more "Motivations") (more_action open-motivations)))
(When tasks 20 (has swarms))
(When tasks 20 (on motivations.supported))
(Part tasks 25 notice ((tone info) (text (bind counts.partial.text))))
(When tasks 25 (has swarms))
(When tasks 25 (on counts.partial))

; ---------- how to show them, whose, and which words
(Part tasks 30 switcher ((label "Show tasks as") (bind view) (options ((option board "Columns" columns) (option list "List" list)))))
(When tasks 30 (has swarms))
(Part tasks 31 menus ((menus ((menu "Mind" mind tasks.minds "Any mind")))))
(When tasks 31 (has swarms))
(Part tasks 32 search ((label "Find a task") (placeholder "Find a task…") (bind query)))
(When tasks 32 (has swarms))
(Part tasks 33 notice ((tone info) (text (bind tasks.total))))
(When tasks 33 (has swarms))

; ---------- about the motivation filter
(Part tasks 40 notice ((tone info) (text "That motivation is not there for you: it may have been made private, or it no longer exists.")))
(When tasks 40 (has swarms))
(When tasks 40 (on motivation.missing))
(Part tasks 41 note ((text "Open a task and choose “File under a motivation” to sort it. Nothing is filed for you.")))
(When tasks 41 (has swarms))
(When tasks 41 (is filter.motivation unsorted))
(When tasks 41 (has tasks.unsorted))
(Part tasks 42 note ((text (bind motivation.why))))
(When tasks 42 (has swarms))
(When tasks 42 (on motivation.chosen))
(When tasks 42 (on motivation.why))
(Part tasks 43 line ((title "About this motivation →") (open motivation)))
(When tasks 43 (has swarms))
(When tasks 43 (on motivation.chosen))

; ---------- the tasks: status columns, or one list
(Part tasks 70 island ((name task-columns)))
(When tasks 70 (has swarms))
(When tasks 70 (is view board))
(Part tasks 71 island ((name task-list)))
(When tasks 71 (has swarms))
(When tasks 71 (is view list))

; ---------- who might take a piece of work
(Part tasks 80 island ((name find-help)))
(When tasks 80 (has swarms))
(Depth tasks 80 ground)
