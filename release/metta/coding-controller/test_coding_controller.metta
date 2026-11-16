; Synthetic transition tests for the coding task controller.
; Person identifiers are invented. The suite covers approval matching,
; independent review, current-generation evidence, replay/idempotency,
; repair limits, outstanding effects, reconciliation and both profiles.

!(import! &self coding_controller)

(= (ctx) (Ctx g_1 e1 person-a coder 3 delegated))
(= (o $id $kind $f) (O $id $kind g_1 e1 $f))
(= (ph $log) (phase-of (replay (ctx) (start-state) $log)))
(= (st $log) (replay (ctx) (start-state) $log))
(= (rc $log) (receipts (ctx) (start-state) $log))
(= (final-of $xs) (if (== (cdr-atom $xs) ()) (car-atom $xs) (final-of (cdr-atom $xs))))

(= (to-ready) ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1))
               (o 5 tests-pass (c1 r1)) (o d6 dispatched (q6 review c1)) (o 6 review-pass (c1 reviewer q6))))
!(test (ph (to-ready)) ready)

!(test (ph (append (to-ready) ((o 7 approval-needed (op5)) (o 8 approved (op5 person-a)) (o 9 applied (op5 c1 person-a))))) delivered)

!(test (final-of (rc ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 tests-pass (c1 r9)))))
       (rejected run-not-dispatched-for-this-candidate))

!(test (ph (append (to-ready) ((o 7 applied (op5 c1 person-a))))) ready)

!(test (ph (append (to-ready) ((o 7 approval-needed (op5)) (o 8 applied (op999 c1 person-a))))) ready)
!(test (ph (append (to-ready) ((o 7 approval-needed (op5)) (o 8 approved (op5 person-a)) (o 9 applied (op999 c1 person-a))))) ready)

!(test (next-action (st ((o 1 opened ()) (o 2 read ()) (o 3 unknown (op7)) (o 4 stale ()) (o 5 read ()))) g_1 t) (do (reconcile op7)))
!(test (final-of (rc ((o 1 opened ()) (o 2 read ()) (o 3 unknown (op7)) (o 4 stale ()) (o 5 read ()) (o 6 changed (c1 ())))))
       (rejected unresolved-effect-first))
!(test (ph ((o 1 opened ()) (o 2 read ()) (o 3 unknown (op7)) (o 4 reconciled (op7)))) needs-read)

!(test (rc ((o 1 opened ()) (o 1 opened ()))) (accepted duplicate))
!(test (rc ((o 1 opened ()) (o 1 read ()))) (accepted (rejected conflicting-duplicate)))

!(test (final-of (rc ((o 1 opened ()) (o 2 read ()) (o 3 changed (none ()))))) (rejected candidate-is-not-a-reference))

!(test (ph (append (to-ready) ((o 7 changed (c2 ())) (o 8 approval-needed (op5)) (o 9 approved (op5 person-a)) (o 10 applied (op5 c2 person-a))))) edited)
!(test (ph ((o 1 opened ()) (o 2 cancelled ()) (o 3 stale ()) (o 4 read ()))) stopped)
; Peter on #43: approval is accepted only once the candidate is ready (tested and independently reviewed)
!(test (next-action (st ((o 1 opened ()) (o 2 read ()) (o 3 approval-needed (op5)) (o 4 approved (op5 person-b)))) g_1 t) (think make-the-smallest-change))
!(test (ph (append (to-ready) ((o 7 changed (c2 ())) (o 8 approval-needed (op5)) (o 9 approved (op5 person-a)) (o 10 applied (op5 c2 person-a))))) edited)
!(test (next-action (st ((o 1 opened ()) (o 2 read ()) (o 3 approval-needed (op5)) (o 4 approved (op5 person-a)) (o 5 applied (op5 c1 person-a)))) g_1 t) (think make-the-smallest-change))
!(test (ph ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1))
            (o 5 tests-fail (c1 r1)) (o 5 tests-fail (c1 r1)))) red)
!(test (ph (append (to-ready) ((o d7 dispatched (q7 review c1)) (o 7 review-pass (c1 coder q7))))) ready)
!(test (final-of (rc ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 tests-pass (c1 r1)) (o d6 dispatched (q6 review c1)) (o 6 review-pass (c1 coder q6)))))
       (rejected review-not-independent-or-not-this-candidate))

(= (checked) ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ((diag count.metta)))) (o 4 dispatched (r1 test c1))
              (o 5 tests-pass (c1 r1)) (o 6 dispatched (r2 (diag count.metta) c1))))
!(test (ph (checked)) edited)
!(test (ph (append (checked) ((o 7 check-pass (c1 (diag count.metta) r2))))) green)
!(test (ph (append (checked) ((o 7 check-fail (c1 (diag count.metta) r2))))) red)
!(test (ph (append (checked) ((o 7 check-unavailable (c1 (diag count.metta)))))) blocked)
!(test (next-action (st (append (checked) ((o 7 check-unknown (c1 (diag count.metta) r2))))) g_1 t) (do (reconcile r2)))

!(test (next-action (st ((o 1 opened ()) (o 2 read ()) (o 3 unknown (op7)) (o 4 cancelled ()))) g_1 t) (do (reconcile op7)))
!(test (ph ((o 1 opened ()) (o 2 read ()) (o 3 unknown (op7)) (o 4 cancelled ()) (o 5 reconciled (op7)))) stopped)

!(test (next-action (st (to-ready)) g_1 t) (tell confirm-to-apply c1))
!(test (next-action (st (append (to-ready) ((o 7 approval-needed (op5)) (o 8 approved (op5 person-a))))) g_1 t) (do (apply-confirmed (op5 c1 person-a))))

(= (cf $n $c $r) ((o (+ 100 $n) read ()) (o (+ 200 $n) changed ($c ((diag x.metta)))) (o (+ 300 $n) dispatched ($r (diag x.metta) $c)) (o (+ 400 $n) check-fail ($c (diag x.metta) $r))))
(= (start-r) ((o 1 opened ()) (o 2 read ())))

!(test (ph (append (start-r) (append (cf 1 c1 r1) (append (cf 2 c2 r2) (cf 3 c3 r3))))) red)
!(test (ph (append (start-r) (append (cf 1 c1 r1) (append (cf 2 c2 r2) (append (cf 3 c3 r3) (cf 4 c4 r4)))))) blocked)

!(test (ph (append (start-r) (append (cf 1 c1 r1) (append (cf 2 c2 r2)
        ((o 500 read ()) (o 501 changed (c5 ())) (o 502 dispatched (r5 test c5)) (o 503 tests-fail (c5 r5))
         (o 504 read ()) (o 505 changed (c6 ())) (o 506 dispatched (r6 test c6)) (o 507 tests-fail (c6 r6))))))) blocked)

!(test (ph (append (start-r) (append (cf 1 c1 r1) (append (cf 2 c2 r2) (append (cf 3 c3 r3) ((o 403 check-fail (c3 (diag x.metta) r3)))))))) red)

!(test (ph (append (to-ready) ((o 7 approved (none person-a)) (o 8 applied (none c1 person-a))))) ready)

!(test (ph (append (to-ready) ((o 7 stale ()) (o 8 read ()) (o 9 changed (c1 ())) (o 10 tests-pass (c1 r1)) (o d11 dispatched (q11 review c1)) (o 11 review-pass (c1 reviewer q11))))) edited)
!(test (ph (append (to-ready) ((o 7 stale ()) (o 8 read ()) (o 9 changed (c1 ())) (o 10 dispatched (r9 test c1)) (o 11 tests-pass (c1 r9)) (o d12 dispatched (q12 review c1)) (o 12 review-pass (c1 reviewer q12))))) ready)

!(test (ph (append (checked) ((o 7 check-unavailable (c1 (diag x.metta))) (o 8 check-fail (c1 (diag count.metta) r2))))) blocked)

!(test (next-action (st (append (start-r) (append (cf 1 c1 r1) (append (cf 2 c2 r2) (append (cf 3 c3 r3) ((o 600 unknown (op9)))))))) g_1 t) (do (reconcile op9)))
!(test (ph (append (start-r) (append (cf 1 c1 r1) (append (cf 2 c2 r2) (append (cf 3 c3 r3) (append (cf 4 c4 r4) ((o 601 cancelled ())))))))) stopped)

(= (exhausted) (append (start-r) (append (cf 1 c1 r1) (append (cf 2 c2 r2) (append (cf 3 c3 r3) (cf 4 c4 r4))))))
!(test (ph (exhausted)) blocked)

!(test (ph (append (exhausted) ((o 700 unknown (op8)) (o 701 reconciled (op8)) (o 702 read ()) (o 703 changed (c5 ())) (o 704 dispatched (r5 test c5)) (o 705 tests-pass (c5 r5)) (o d706 dispatched (q706 review c5)) (o 706 review-pass (c5 reviewer q706))))) blocked)
!(test (ph (append (checked) ((o 7 check-unavailable (c1 (diag x.metta))) (o 8 check-unknown (c1 (diag count.metta) r2)) (o 9 reconciled (r2))))) blocked)

!(test (ph (append (to-ready) ((o 7 stale ()) (o 8 read ()) (o 9 changed (c1 ())) (o 10 dispatched (r1 test c1)) (o 11 tests-pass (c1 r1)) (o d12 dispatched (q12 review c1)) (o 12 review-pass (c1 reviewer q12))))) edited)
!(test (final-of (rc (append (to-ready) ((o 7 stale ()) (o 8 read ()) (o 9 changed (c1 ())) (o 10 dispatched (r1 test c1)))))) (rejected run-id-reused))

!(test (ph (append (to-ready) ((o 7 approval-needed (op5)) (o 8 approved (op5 person-a)) (o 9 approval-needed (op6)) (o 10 applied (op5 c1 person-a))))) ready)

!(test (ph (append (to-ready) ((o 7 approval-needed (op5)) (o 8 approved (op5 person-a)) (o 9 stale ()) (o 91 reconciled (op5)) (o 10 read ()) (o 11 changed (c1 ()))
        (o 12 dispatched (r99 test c1)) (o 13 tests-pass (c1 r99)) (o 14 review-pass (c1 reviewer q6))
        (o 15 approval-needed (op5)) (o 16 approved (op5 person-a)) (o 17 applied (op5 c1 person-a))))) green)

!(test (ph (append (to-ready) ((o 9 stale ()) (o 10 read ()) (o 11 changed (c1 ()))
        (o 12 dispatched (r99 test c1)) (o 13 tests-pass (c1 r99)) (o 14 dispatched (q99 review c1)) (o 15 review-pass (c1 reviewer q99))
        (o 16 approval-needed (op7)) (o 17 approved (op7 person-a)) (o 18 applied (op7 c1 person-a))))) delivered)

!(test (ph ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 tests-pass (c1 r1)) (o d6 dispatched (q6 review c1)) (o 6 review-pass (c1 none q6)))) green)

!(test (ph ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 dispatched (r2 test c1))
            (o 6 tests-pass (c1 r1)) (o 7 tests-fail (c1 r2)) (o 8 dispatched (q1 review c1)) (o 9 review-pass (c1 reviewer q1))
            (o 10 approval-needed (op1)) (o 11 approved (op1 person-a)) (o 12 applied (op1 c1 person-a)))) red)

!(test (ph ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 tests-pass (c1 r1))
            (o 6 dispatched (q1 review c1)) (o 7 dispatched (q2 review c1)) (o 8 review-pass (c1 reviewer1 q1)) (o 9 review-fail (c1 reviewer2 q2))
            (o 10 approval-needed (op1)) (o 11 approved (op1 person-a)) (o 12 applied (op1 c1 person-a)))) understood)

(= (late-fail) ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 dispatched (r2 test c1))
            (o 6 tests-pass (c1 r1)) (o 7 dispatched (q1 review c1)) (o 8 review-pass (c1 reviewer q1))
            (o 9 approval-needed (op1)) (o 10 approved (op1 person-a)) (o 11 tests-fail (c1 r2))))
; late-fail: approval arrives while test r2 is still out (phase edited), so it is refused (Peter on #43) and the late failure repairs
!(test (next-action (st (late-fail)) g_1 t) (think repair-from-the-failing-output))
!(test (rc ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 dispatched (r2 test c1)) (o 6 tests-pass (c1 r1)) (o 7 dispatched (q1 review c1)) (o 8 review-pass (c1 reviewer q1)) (o 9 approval-needed (op1))))
       (accepted accepted accepted accepted accepted accepted accepted accepted (rejected approval-before-ready)))

!(test (ph (append (exhausted) ((o 800 tests-fail (c4 r4))))) blocked)

!(test (ph ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 dispatched (q1 review c1)) (o 6 dispatched (q2 review c1))
            (o 7 review-fail (c1 reviewer1 q1)) (o 8 tests-pass (c1 r1)) (o 9 review-pass (c1 reviewer2 q2))
            (o 10 approval-needed (op1)) (o 11 approved (op1 person-a)) (o 12 applied (op1 c1 person-a)))) understood)

!(test (ph (append (to-ready) ((o 7 dispatched (r2 test c1)) (o 8 approval-needed (op1)) (o 9 approved (op1 person-a)) (o 10 applied (op1 c1 person-a))))) ready)

!(test (ph (append (to-ready) ((o 7 dispatched (r2 test c1)) (o 8 approval-needed (op1)) (o 9 approved (op1 person-a)) (o 10 tests-pass (c1 r2)) (o 11 applied (op1 c1 person-a))))) delivered)

!(test (ph (append (to-ready) ((o 7 dispatched (r2 test c1)) (o 8 approval-needed (op1)) (o 9 approved (op1 person-a)) (o 10 tests-fail (c1 r2)) (o 11 applied (op1 c1 person-a))))) red)

!(test (ph ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 dispatched (r2 test c1)) (o 6 tests-pass (c1 r1)))) edited)

!(test (final-of (rc (append (to-ready) ((o 7 tests-fail (c1 r1)))))) (rejected run-not-dispatched-for-this-candidate))

!(test (next-action (st (append (to-ready) ((o 7 approval-needed (op1)) (o 8 approved (op1 person-a)) (o 9 refused ())))) g_1 t) (do (reconcile op1)))
!(test (next-action (st (append (to-ready) ((o 7 approval-needed (op1)) (o 8 approved (op1 person-a)) (o 9 refused ()) (o 10 reconciled (op1))))) g_1 t) (rest needs-person))

!(test (ph (append (to-ready) ((o 7 dispatched (q70 review c1)) (o 8 check-pass (c1 review q70)) (o 9 approval-needed (op70)) (o 10 approved (op70 person-a)) (o 11 applied (op70 c1 person-a))))) ready)
!(test (final-of (rc (append (to-ready) ((o 7 dispatched (r70 test c1)) (o 8 check-pass (c1 test r70)))))) (rejected run-not-dispatched-for-this-candidate))

!(test (ph (append (to-ready) ((o 7 dispatched (q70 review c1)) (o 8 review-pass (c1 reviewer2 q70)) (o 9 approval-needed (op70)) (o 10 approved (op70 person-a)) (o 11 applied (op70 c1 person-a))))) delivered)

!(test (ph ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 dispatched (q1 review c1)) (o 6 review-pass (c1 reviewer q1)) (o 7 tests-pass (c1 r1)))) ready)

!(test (next-action (st (append (to-ready) ((o 7 dispatched (r2 test c1)) (o 8 approval-needed (op1)) (o 9 approved (op1 person-a))))) g_1 t) (rest awaiting-results))
!(test (next-action (st ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 dispatched (r2 test c1)) (o 6 tests-pass (c1 r1)))) g_1 t) (rest awaiting-results))

!(test (next-action (st (append (checked) ((o 7 refused ())))) g_1 t) (do (reconcile r2)))

!(test (ph ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 tests-pass (c1 r9)) (o 6 check-pass (c1 (diag never.metta) r9)))) edited)

(= (at-understood) ((o 1 opened ()) (o 2 read ())))

!(test (next-action (st (append (at-understood) ((o 3 proposed (p1 edit d1))))) g_1 t) (do (select-proposal p1)))
!(test (next-action (st (append (at-understood) ((o 3 proposed (p1 edit d1)) (o 4 proposal-selected (p1 edit d1))))) g_1 t) (do (execute-proposal p1 edit d1)))
!(test (next-action (st (append (at-understood) ((o 3 proposed (p1 edit d1)) (o 4 proposal-selected (p1 edit d1)) (o 5 proposal-executing (p1 op1))))) g_1 t) (rest awaiting-results))
!(test (ph (append (at-understood) ((o 3 proposed (p1 edit d1)) (o 4 proposal-selected (p1 edit d1)) (o 5 proposal-executing (p1 op1)) (o 51 proposal-done (p1 op1)) (o 6 changed (c1 ()))))) edited)

!(test (next-action (st (append (at-understood) ((o 3 proposed (p1 edit d1)) (o 4 proposal-selected (p1 edit d1)) (o 5 proposal-executing (p1 op1)) (o 51 proposal-done (p1 op1)) (o 6 changed (c1 ()))))) g_1 t) (do (code-exec t)))

!(test (final-of (rc (append (at-understood) ((o 3 proposed (p1 read d1)))))) (rejected proposal-not-admissible))

!(test (final-of (rc (append (at-understood) ((o 3 proposed (p1 edit d1)) (o 4 proposal-selected (p1 edit d2)))))) (rejected proposal-not-pending-or-changed))

!(test (final-of (rc (append (at-understood) ((o 3 proposed (p1 edit d1)) (o 4 proposed (p2 edit d2)))))) (rejected proposal-not-admissible))
!(test (final-of (rc (append (at-understood) ((o 3 proposed (p1 edit d1)) (o 4 proposal-selected (p1 edit d1)) (o 5 proposal-executing (p1 op1)) (o 6 proposal-executing (p1 op2)))))) (rejected proposal-not-selected-or-not-admissible-now))

!(test (final-of (rc (append (at-understood) ((o 3 proposed (p1 edit d1)) (o 4 stale ()) (o 5 read ()) (o 6 proposed (p1 edit d1)))))) (rejected proposal-id-reused))

!(test (next-action (st (append (at-understood) ((o 3 proposed (p1 edit d1)) (o 4 stale ())))) g_1 t) (think read-again-before-editing))

!(test (final-of (rc (append (at-understood) ((o 3 unknown (op9)) (o 4 proposed (p1 edit d1)))))) (rejected proposal-not-admissible))

!(test (ph (append (at-understood) ((o 3 proposed (p1 edit d1)) (o 4 proposal-selected (p1 edit d1)) (o 5 proposal-executing (p1 op1))))) understood)
!(test (final-of (rc (append (at-understood) ((o 3 proposal-executing (p1 op1)))))) (rejected proposal-not-selected-or-not-admissible-now))
!(test (final-of (rc (append (at-understood) ((o 3 proposal-selected (p1 edit d1)))))) (rejected proposal-not-pending-or-changed))

!(test (next-action (st (append (start-r) (append (cf 1 c1 r1) (append (cf 2 c2 r2) (append (cf 3 c3 r3)
        ((o 900 read ()) (o 901 changed (c4 ())) (o 902 dispatched (ra test c4)) (o 903 dispatched (rb test c4)) (o 904 tests-fail (c4 ra)))))))) g_1 t) (do (reconcile rb)))

!(test (next-action (st ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (ra test c1)))) g_1 t) (rest awaiting-results))

!(test (next-action (st (checked)) g_1 t) (rest awaiting-results))

!(test (next-action (st ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 tests-pass (c1 r1)) (o 6 dispatched (q1 review c1)))) g_1 t) (rest awaiting-results))

!(test (next-action (st ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 stale ()))) g_1 t) (do (reconcile r1)))

!(test (next-action (st ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 cancelled ()))) g_1 t) (do (reconcile r1)))
!(test (ph ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 cancelled ()) (o 6 reconciled (r1)))) stopped)

(= (exec1) (append (at-understood) ((o 3 proposed (p1 edit d1)) (o 4 proposal-selected (p1 edit d1)) (o 5 proposal-executing (p1 op1)))))

!(test (next-action (st (append (exec1) ((o 6 stale ())))) g_1 t) (rest awaiting-results))

!(test (next-action (st (append (exec1) ((o 6 read ())))) g_1 t) (rest awaiting-results))
!(test (final-of (rc (append (exec1) ((o 6 changed (c1 ())))))) (rejected proposal-effect-unreported))

!(test (final-of (rc (append (at-understood) ((o 3 proposed (p1 edit d1)) (o 4 proposal-selected (p1 edit d1)) (o 5 approval-needed (opA)))))) (rejected approval-before-ready))

!(test (next-action (st (append (at-understood) ((o 3 proposed (p1 edit d1)) (o 4 proposal-selected (p1 edit d1)) (o 5 unknown (op9)) (o 6 reconciled (op9))))) g_1 t) (think read-again-before-editing))

!(test (final-of (rc (append (at-understood) ((o 3 proposed (p1 read d1)) (o 4 stale ()) (o 5 read ())
        (o 6 proposed (p2 edit d2)) (o 7 proposal-selected (p2 edit d2)) (o 8 proposal-executing (p2 op1)) (o 9 proposal-done (p2 op1))
        (o 10 changed (c1 ())) (o 11 dispatched (op1 test c1)))))) (rejected run-id-reused))

!(test (next-action (st (append (start-r) (append (cf 1 c1 r1) (append (cf 2 c2 r2) (append (cf 3 c3 r3)
        ((o 900 read ()) (o 901 changed (c4 ())) (o 902 dispatched (ra test c4)) (o 903 tests-fail (c4 ra)))))))) g_1 t) (rest needs-person))

!(test (ph (append (exec1) ((o 6 proposal-done (p1 op1)) (o 7 changed (c1 ())) (o 8 dispatched (r1 test c1)) (o 9 tests-pass (c1 r1))
        (o 10 dispatched (q1 review c1)) (o 11 review-pass (c1 reviewer q1)) (o 12 approval-needed (opZ)) (o 13 approved (opZ person-a)) (o 14 applied (opZ c1 person-a))))) delivered)

!(test (next-action (st (append (exec1) ((o 6 unknown (opX)) (o 7 reconciled (opX))))) g_1 t) (rest awaiting-results))
!(test (final-of (rc (append (exec1) ((o 6 unknown (opX)) (o 7 reconciled (opX)) (o 8 read ()) (o 9 changed (c2 ())))))) (rejected proposal-effect-unreported))

(= (red-k1) ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ((diag count.metta)))) (o 4 dispatched (r1 test c1))
             (o 5 dispatched (k1 (diag count.metta) c1)) (o 6 tests-fail (c1 r1))))
!(test (ph (red-k1)) red)
!(test (final-of (rc (append (red-k1) ((o 7 proposed (p1 edit d1)) (o 8 proposal-selected (p1 edit d1)) (o 9 proposal-executing (p1 op1))
        (o 10 check-unknown (c1 (diag count.metta) k1)) (o 11 reconciled (k1)) (o 12 read ()) (o 13 changed (c2 ())))))) (rejected proposal-effect-unreported))

!(test (next-action (st ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ((diag count.metta)))) (o 4 dispatched (r1 test c1))
        (o 5 dispatched (k1 (diag count.metta) c1)) (o 6 check-unknown (c1 (diag count.metta) k1)) (o 7 reconciled (k1)))) g_1 t) (do (reconcile r1)))

!(test (final-of (rc (append (at-understood) ((o 3 proposed (p1 edit d1)) (o 4 proposal-selected (p1 edit d1)) (o 5 dispatched (rX test c0)) (o 6 proposal-executing (p1 op1))))))
       (rejected proposal-not-selected-or-not-admissible-now))

!(test (final-of (rc (append (exec1) ((o 6 stale ()) (o 7 read ()) (o 8 changed (c2 ())))))) (rejected proposal-effect-unreported))
!(test (final-of (rc (append (exec1) ((o 6 stale ()) (o 7 reconciled (op1)))))) (rejected not-an-unresolved-operation))

!(test (next-action (st (append (exec1) ((o 6 unknown (op1))))) g_1 t) (do (reconcile op1)))
!(test (next-action (st (append (exec1) ((o 6 unknown (op1)) (o 7 reconciled (op1))))) g_1 t) (think read-again-before-editing))

!(test (next-action (st (append (at-understood) ((o 3 proposed (p1 edit d1)) (o 4 proposal-selected (p1 edit d1)) (o 5 approval-needed (opA))
        (o 6 proposal-executing (p1 op1)) (o 7 approved (opA person-a))))) g_1 t) (rest awaiting-results))   ; early approval refused, so the proposal runs

(= (red-exec) (append (red-k1) ((o 7 proposed (p1 read d1)) (o 8 proposal-selected (p1 read d1)) (o 9 proposal-executing (p1 op1)))))
!(test (next-action (st (append (red-exec) ((o 10 check-unavailable (c1 (diag count.metta)))))) g_1 t) (do (reconcile k1)))
!(test (final-of (rc (append (red-exec) ((o 10 check-unavailable (c1 (diag count.metta))) (o 11 proposal-done (p1 op1)))))) accepted)
!(test (prop-of (st (append (red-exec) ((o 10 check-unavailable (c1 (diag count.metta))) (o 11 proposal-done (p1 op1)))))) none)

!(test (final-of (rc (append (exec1) ((o 6 cancelled ()) (o 7 proposal-done (p1 op1)))))) accepted)

!(test (next-action (st ((o 1 opened ()) (o 2 read ()) (o 3 refused ()) (o 4 dispatched (rz test c0)) (o 5 stale ()))) g_1 t) (do (reconcile rz)))

(= (rctx) (Ctx g_1 e1 person-a coder 3 root-suggest))
(= (rph $log) (phase-of (replay (rctx) (start-state) $log)))
(= (rrc $log) (receipts (rctx) (start-state) $log))
!(test (final-of (rrc ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ()))))) (rejected origin-edit-not-in-profile))
!(test (rph ((o 1 opened ()) (o 2 read ()) (o 3 candidate-retained (c1 () f1)))) edited)
!(test (final-of (rrc ((o 1 opened ()) (o 2 read ()) (o 3 candidate-retained (c1 () none))))) (rejected candidate-needs-its-fork))
!(test (final-of (rc ((o 1 opened ()) (o 2 read ()) (o 3 candidate-retained (c1 () f1))))) (rejected candidate-retained-not-in-profile))

!(test (rph ((o 1 opened ()) (o 2 read ()) (o 3 candidate-retained (c1 () f1)) (o 4 dispatched (r1 test c1)) (o 5 tests-pass (c1 r1))
        (o 6 dispatched (q1 review c1)) (o 7 review-pass (c1 reviewer q1)) (o 8 approval-needed (opP)) (o 9 approved (opP person-a)) (o 10 applied (opP c1 person-a)))) delivered)

(= (lost) (append (red-k1) ((o 7 proposed (p1 read d1)) (o 8 proposal-selected (p1 read d1)) (o 9 proposal-executing (p1 op1)) (o 10 unknown (op1)) (o 11 reconciled (op1)))))
!(test (ph (lost)) reconcile)
!(test (final-of (rc (append (lost) ((o 12 read ()) (o 13 changed (c2 ())))))) (rejected unresolved-effect-first))
!(test (final-of (rc (append (lost) ((o 12 reconciled (k1)) (o 13 changed (c3 ())))))) (rejected edit-without-fresh-read))

(= (blk) (append (red-k1) ((o 7 proposed (p1 edit d1)) (o 8 proposal-selected (p1 edit d1)) (o 9 proposal-executing (p1 op1)) (o 10 check-unavailable (c1 (diag count.metta))))))
!(test (next-action (st (append (blk) ((o 11 unknown (op1))))) g_1 t) (do (reconcile op1)))
!(test (prop-of (st (append (blk) ((o 11 cancelled ()) (o 12 proposal-done (p1 op1)))))) none)

(= (rst $log) (replay (rctx) (start-state) $log))
(= (r-ret) ((o 1 opened ()) (o 2 read ()) (o 3 candidate-retained (c1 ((diag count.metta)) f1))))
!(test (next-action-for root-suggest (rst (r-ret)) g_1 t) (do (proposal-test c1 t)))
!(test (next-action-for root-suggest (rst (append (r-ret) ((o 4 dispatched (r1 test c1)) (o 5 tests-pass (c1 r1))))) g_1 t) (do (proposal-check c1 (diag count.metta))))
(= (r-ready) ((o 1 opened ()) (o 2 read ()) (o 3 candidate-retained (c1 () f1)) (o 4 dispatched (r1 test c1)) (o 5 tests-pass (c1 r1))
              (o 6 dispatched (q1 review c1)) (o 7 review-pass (c1 reviewer q1)) (o 8 approval-needed (opP)) (o 9 approved (opP person-a))))
!(test (next-action-for root-suggest (rst (r-ready)) g_1 t) (rest awaiting-person-apply))
!(test (next-action-for delegated (st (append (to-ready) ((o 7 approval-needed (op5)) (o 8 approved (op5 person-a))))) g_1 t) (do (apply-confirmed (op5 c1 person-a))))

(= (debt) (append (at-understood) ((o z changed (c1 ())) (o a dispatched (old test c1)) (o b changed (c2 ())) (o c dispatched (new test c2))
          (o d tests-pass (c2 new)) (o e dispatched (q2 review c2)) (o f review-pass (c2 reviewer q2)) (o g approval-needed (a2)) (o h approved (a2 person-a)) (o i applied (a2 c2 person-a)))))
!(test (final-of (rc (debt))) (rejected apply-not-confirmed-for-this-candidate))
!(test (next-action (st (debt)) g_1 t) (do (reconcile old)))
(= (root-debt) ((o 1 opened ()) (o 2 read ()) (o 3 candidate-retained (c1 () f1)) (o 4 dispatched (old test c1)) (o 5 candidate-retained (c2 () f2))
               (o 6 dispatched (new test c2)) (o 7 tests-pass (c2 new)) (o 8 dispatched (q2 review c2)) (o 9 review-pass (c2 reviewer q2))
               (o 10 approval-needed (a2)) (o 11 approved (a2 person-a)) (o 12 applied (a2 c2 person-a))))
!(test (final-of (rrc (root-debt))) (rejected apply-not-confirmed-for-this-candidate))

!(test (rph (append (root-debt) ((o 13 reconciled (old))))) reconcile)
!(test (rph (append (root-debt) ((o 13 reconciled (old)) (o 14 reconciled (a2))))) needs-read)

(= (stopped-loss) (append (exec1) ((o x cancelled ()) (o y unknown (op1)))))
!(test (final-of (rc (stopped-loss))) accepted)
!(test (ph (stopped-loss)) stopped)
!(test (next-action (st (stopped-loss)) g_1 t) (do (reconcile op1)))
!(test (ph (append (stopped-loss) ((o w reconciled (op1))))) stopped)
!(test (disp-of (st (append (stopped-loss) ((o w reconciled (op1)))))) ())

!(test (final-of (rc (append (exec1) ((o x cancelled ()) (o y unknown (op9)))))) accepted)
!(test (ph (append (exec1) ((o x cancelled ()) (o y unknown (op9))))) stopped)

!(test (final-of (rrc ((o 1 opened ()) (o 2 read ()) (o 3 proposed (p1 edit d1))))) (rejected proposal-not-admissible))
!(test (final-of (rrc ((o 1 opened ()) (o 2 read ()) (o 3 proposed (p1 suggest d1)) (o 4 proposal-selected (p1 suggest d1)) (o 5 proposal-executing (p1 op1))
        (o 6 proposal-done (p1 op1)) (o 7 candidate-retained (c1 () f1))))) accepted)
!(test (final-of (rc ((o 1 opened ()) (o 2 read ()) (o 3 proposed (p1 suggest d1))))) (rejected proposal-not-admissible))

!(test (final-of (rc (append (to-ready) ((o 7 approval-needed (op5)) (o 8 approved (op5 person-a)) (o 9 applied (op5 c1 person-a)) (o 10 dispatched (rz test c1)))))) (rejected terminal))
!(test (final-of (rc ((o 1 opened ()) (o 2 read ()) (o 3 cancelled ()) (o 4 dispatched (rz test c0))))) (rejected terminal))

!(test (next-action-for root-suggest (start-state) g_1 t) (do (code-open-readonly g_1)))
!(test (next-action-for root-suggest (rst ((o 1 opened ()) (o 2 read ()) (o 3 candidate-retained (c1 () f1)) (o 4 dispatched (r1 test c1)) (o 5 tests-pass (c1 r1)))) g_1 t) (do (proposal-review c1)))

!(test (final-of (rc (append (to-ready) ((o 7 dispatched (opZ proposal pZ)))))) (rejected run-kind-not-dispatchable))

!(test (final-of (rc ((o 1 opened ()) (o 2 read ()) (o 3 unknown (op7)) (o 4 unknown (op7))))) (rejected already-unresolved))

(= (apply-inflight) (append (to-ready) ((o a approval-needed (apply1)) (o b approved (apply1 person-a)))))
(= (apply-loss) (append (apply-inflight) ((o c cancelled ()) (o d unknown (apply1)))))
!(test (next-action (st (append (apply-inflight) ((o c cancelled ())))) g_1 t) (do (reconcile apply1)))
!(test (final-of (rc (apply-loss))) (rejected already-unresolved))
!(test (ph (append (apply-loss) ((o e reconciled (apply1))))) stopped)
!(test (next-action-for root-suggest (rst (append (r-ready) ((o c cancelled ())))) g_1 t) (do (reconcile opP)))

!(test (next-action (st (append (apply-inflight) ((o c stale ())))) g_1 t) (do (reconcile apply1)))

!(test (next-action (st (append (apply-inflight) ((o c applied (apply1 c1 person-a))))) g_1 t) (rest done))

!(test (final-of (rc ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 cancelled ()) (o 6 unknown (r1))))) (rejected already-unresolved))

!(test (final-of (rrc ((o 1 opened ()) (o 2 read ()) (o 3 candidate-retained (c1 (review) f1))))) (rejected reserved-check-kind))
!(test (final-of (rc ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ((diag x.metta) test)))))) (rejected reserved-check-kind))

(= (lost-apply $base) (append $base ((o x1 dispatched (late test c1)) (o x2 cancelled ()) (o x3 reconciled (late)))))
!(test (next-action (st (lost-apply (apply-inflight))) g_1 t) (do (reconcile apply1)))
!(test (ph (append (lost-apply (apply-inflight)) ((o x4 reconciled (apply1))))) stopped)
!(test (next-action-for root-suggest (rst (lost-apply (r-ready))) g_1 t) (do (reconcile opP)))
(= (ghost) (append (apply-inflight) ((o x1 unknown (other)) (o x2 reconciled (other)))))
!(test (next-action (st (ghost)) g_1 t) (do (reconcile apply1)))

!(test (next-action (st (append (apply-inflight) ((o x1 dispatched (r9 test c1)) (o x2 tests-fail (c1 r9))))) g_1 t) (do (reconcile apply1)))

!(test (final-of (rc (append (apply-inflight) ((o x1 dispatched (r9 test c1)) (o x2 cancelled ()) (o x3 reconciled (r9)) (o x4 unknown (apply1)))))) (rejected already-unresolved))

!(test (next-action (st (append (apply-inflight) ((o x1 dispatched (r9 test c1))))) g_1 t) (rest awaiting-results))
!(test (ph (append (apply-inflight) ((o x1 dispatched (r9 test c1)) (o x2 tests-pass (c1 r9)) (o x3 applied (apply1 c1 person-a))))) delivered)

!(test (final-of (rc (append (to-ready) ((o 7 dispatched (opX apply c1)))))) (rejected run-kind-not-dispatchable))
(= (stuck-d $k) ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ($k)))))
!(test (final-of (rc (stuck-d proposal))) (rejected reserved-check-kind))
!(test (final-of (rc (stuck-d none))) (rejected reserved-check-kind))
!(test (final-of (rc (stuck-d apply))) (rejected reserved-check-kind))
!(test (final-of (rrc ((o 1 opened ()) (o 2 read ()) (o 3 candidate-retained (c1 (proposal) f1))))) (rejected reserved-check-kind))

!(test (final-of (rc (append (apply-inflight) ((o x1 dispatched (apply1 test c1)))))) (rejected run-id-reused))
!(test (final-of (rc (append (to-ready) ((o x1 dispatched (same test c1)) (o x2 approval-needed (same)))))) (rejected approval-id-reused))
!(test (final-of (rrc (append (r-ready) ((o x1 dispatched (opP test c1)))))) (rejected run-id-reused))

!(test (next-action (st ((o x1 cancelled ()) (o x2 unknown (open1)))) g_1 t) (do (reconcile open1)))
!(test (ph ((o x1 cancelled ()) (o x2 unknown (open1)) (o x3 reconciled (open1)))) stopped)
!(test (next-action-for root-suggest (rst ((o x1 cancelled ()) (o x2 unknown (open1)))) g_1 t) (do (reconcile open1)))

(= (apply-run-loss) (append (apply-inflight) ((o x1 dispatched (r9 test c1)) (o x2 unknown (apply1)))))
!(test (next-action (st (apply-run-loss)) g_1 t) (do (reconcile apply1)))
!(test (ph (append (apply-run-loss) ((o x3 reconciled (apply1))))) reconcile)
!(test (next-action (st (append (apply-run-loss) ((o x3 reconciled (apply1))))) g_1 t) (do (reconcile r9)))
!(test (ph (append (apply-run-loss) ((o x3 reconciled (apply1)) (o x4 reconciled (r9))))) needs-read)

(= (delivered-loss) (append (apply-inflight) ((o x1 applied (apply1 c1 person-a)) (o x2 unknown (op9)))))
!(test (ph (delivered-loss)) delivered)
!(test (next-action (st (delivered-loss)) g_1 t) (do (reconcile op9)))
!(test (next-action (st (append (delivered-loss) ((o x3 reconciled (op9))))) g_1 t) (rest done))
