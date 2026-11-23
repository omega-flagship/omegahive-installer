;; Purpose: decide access to a managed Research task from host-owned goal facts.

;; The committed request child is the assignee during spawn, before the mirrors are filled.
(= (research-goal-access managed registered assigned consistent read $state) Allow)
(= (research-goal-access managed registered assigned consistent work active) Allow)
