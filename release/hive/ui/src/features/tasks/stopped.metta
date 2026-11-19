; Purpose: compose a person's unacknowledged stopped tasks in Ask and a mind's chat.
(Screen stopped-tasks "Tasks that stopped")
(Part stopped-tasks 10 stack ((source stopped.rows)))
(When stopped-tasks 10 (has stopped))
(Part stopped-tasks 20 notice ((tone bad) (text (bind stopped.error))))
(When stopped-tasks 20 (on stopped.error))
(Part stopped-tasks 21 actions ((items ((action "Try again" retry)))))
(When stopped-tasks 21 (on stopped.error))

(Screen stopped-task "A task that stopped")
(Part stopped-task 10 line ((title (bind title)) (badge (bind state)) (tone warn)))
(Part stopped-task 20 notice ((tone warn) (text (bind reason))))
(Part stopped-task 30 actions ((items ((action "Got it" acknowledge busy)))))
