;; Purpose: decide what the Research controller does next with a research task, from host-owned facts.
;;
;; (research-task-next task worker deadline tries), each fact one word the host supplies:
;;   task      open (its research is working), reopened (a person reopened it after it failed) or other
;;   worker    running, resting (paused or erring, it may come back), gone (spawned, then stopped or deleted)
;;             or none (not spawned yet)
;;   deadline  live or passed
;;   tries     left or spent (how many researchers its request has had, against the most it may)
;; It answers Reassign, Readmit or Fail; anything else leaves the task as it is.

;; The controller watches its tasks and assigns them: a task whose researcher is gone gets a fresh one.
(= (research-task-next open gone live left) Reassign)
;; Its last try spent, the task ends now instead of waiting for its deadline with nobody on it.
(= (research-task-next open gone live spent) Fail)
;; A person's reopen starts the research again, whatever its earlier tries.
(= (research-task-next reopened $worker $deadline $tries) Readmit)
