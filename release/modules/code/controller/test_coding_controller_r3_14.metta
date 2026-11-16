!(import! &self coding_controller_r3_14)

(= (ctx) (Ctx g_1 e1 jon (coder) 3 delegated review-required))
(= (o $id $kind $f) (O $id $kind g_1 e1 $f))
(= (ph $log) (phase-of (replay (ctx) (start-state) $log)))
(= (st $log) (replay (ctx) (start-state) $log))
(= (rc $log) (receipts (ctx) (start-state) $log))
(= (final-of $xs) (if (== (cdr-atom $xs) ()) (car-atom $xs) (final-of (cdr-atom $xs))))

(= (to-ready) ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1))
               (o 5 tests-pass (c1 r1)) (o d6 dispatched (q6 review c1)) (o 6 review-pass (c1 reviewer q6))))
!(test (ph (to-ready)) ready)
; the full path: confirmation names op, candidate, person; apply matches it
!(test (ph (append (to-ready) ((o 7 approval-needed (op5)) (o 8 approved (op5 jon)) (o 9 applied (op5 c1 jon))))) delivered)

; OmegaCode's named cases
; wrong run on the same candidate (not journalled as dispatched)
!(test (final-of (rc ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 tests-pass (c1 r9)))))
       (rejected run-not-dispatched-for-this-candidate))
; applied with no confirmation
!(test (ph (append (to-ready) ((o 7 applied (op5 c1 jon))))) ready)
; applied with another pending / another confirmed operation
!(test (ph (append (to-ready) ((o 7 approval-needed (op5)) (o 8 applied (op999 c1 jon))))) ready)
!(test (ph (append (to-ready) ((o 7 approval-needed (op5)) (o 8 approved (op5 jon)) (o 9 applied (op999 c1 jon))))) ready)
; stale during unknown keeps the unresolved effect, and editing is refused until it is reconciled
!(test (next-action (st ((o 1 opened ()) (o 2 read ()) (o 3 unknown (op7)) (o 4 stale ()) (o 5 read ()))) g_1 t) (do (reconcile op7)))
!(test (final-of (rc ((o 1 opened ()) (o 2 read ()) (o 3 unknown (op7)) (o 4 stale ()) (o 5 read ()) (o 6 changed (c1 ())))))
       (rejected unresolved-effect-first))
!(test (ph ((o 1 opened ()) (o 2 read ()) (o 3 unknown (op7)) (o 4 reconciled (op7)))) needs-read)
; duplicate id with a conflicting body refuses; an identical one is a no-op
!(test (rc ((o 1 opened ()) (o 1 opened ()))) (accepted duplicate))
!(test (rc ((o 1 opened ()) (o 1 read ()))) (accepted (rejected conflicting-duplicate)))
; the none sentinel cannot be a candidate
!(test (final-of (rc ((o 1 opened ()) (o 2 read ()) (o 3 changed (none ()))))) (rejected candidate-is-not-a-reference))

; carried over from R2
!(test (ph (append (to-ready) ((o 7 changed (c2 ())) (o 8 approval-needed (op5)) (o 9 approved (op5 jon)) (o 10 applied (op5 c2 jon))))) edited)
!(test (ph ((o 1 opened ()) (o 2 cancelled ()) (o 3 stale ()) (o 4 read ()))) stopped)
!(test (next-action (st ((o 1 opened ()) (o 2 read ()) (o 3 approval-needed (op5)) (o 4 approved (op5 eve)))) g_1 t) (rest awaiting-approval))
!(test (ph ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1))
            (o 5 tests-fail (c1 r1)) (o 5 tests-fail (c1 r1)))) red)
!(test (ph (append (to-ready) ((o d7 dispatched (q7 review c1)) (o 7 review-pass (c1 coder q7))))) ready)
!(test (final-of (rc ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 tests-pass (c1 r1)) (o d6 dispatched (q6 review c1)) (o 6 review-pass (c1 coder q6)))))
       (rejected review-not-independent-or-not-this-candidate))

; checks: pass, fail, unavailable, unknown each have their own outcome
(= (checked) ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ((diag count.metta)))) (o 4 dispatched (r1 test c1))
              (o 5 tests-pass (c1 r1)) (o 6 dispatched (r2 (diag count.metta) c1))))
!(test (ph (checked)) edited)
!(test (ph (append (checked) ((o 7 check-pass (c1 (diag count.metta) r2))))) green)
!(test (ph (append (checked) ((o 7 check-fail (c1 (diag count.metta) r2))))) red)
!(test (ph (append (checked) ((o 7 check-unavailable (c1 (diag count.metta)))))) blocked)
!(test (next-action (st (append (checked) ((o 7 check-unknown (c1 (diag count.metta) r2))))) g_1 t) (do (reconcile r2)))

; a stop does not erase an unresolved effect: cleanup is still proposed
!(test (next-action (st ((o 1 opened ()) (o 2 read ()) (o 3 unknown (op7)) (o 4 cancelled ()))) g_1 t) (do (reconcile op7)))
!(test (ph ((o 1 opened ()) (o 2 read ()) (o 3 unknown (op7)) (o 4 cancelled ()) (o 5 reconciled (op7)))) stopped)

; ready proposes asking the person to confirm; after confirmation, applying that exact confirmation
!(test (next-action (st (to-ready)) g_1 t) (tell confirm-to-apply c1))
!(test (next-action (st (append (to-ready) ((o 7 approval-needed (op5)) (o 8 approved (op5 jon))))) g_1 t) (do (apply-confirmed (op5 c1 jon))))

; ---- R3.1: check failures share the repair cap (OmegaCode R3-P2-CHECK_REPAIR_BOUND) ----
; one candidate change + dispatched check + check-fail, repeated with fresh ids and candidates
(= (cf $n $c $r) ((o (+ 100 $n) read ()) (o (+ 200 $n) changed ($c ((diag x.metta)))) (o (+ 300 $n) dispatched ($r (diag x.metta) $c)) (o (+ 400 $n) check-fail ($c (diag x.metta) $r))))
(= (start-r) ((o 1 opened ()) (o 2 read ())))
; failure at exactly max (3) stays within policy (red); the next distinct failure blocks
!(test (ph (append (start-r) (append (cf 1 c1 r1) (append (cf 2 c2 r2) (cf 3 c3 r3))))) red)
!(test (ph (append (start-r) (append (cf 1 c1 r1) (append (cf 2 c2 r2) (append (cf 3 c3 r3) (cf 4 c4 r4)))))) blocked)
; mixed test and check failures share the counter
!(test (ph (append (start-r) (append (cf 1 c1 r1) (append (cf 2 c2 r2)
        ((o 500 read ()) (o 501 changed (c5 ())) (o 502 dispatched (r5 test c5)) (o 503 tests-fail (c5 r5))
         (o 504 read ()) (o 505 changed (c6 ())) (o 506 dispatched (r6 test c6)) (o 507 tests-fail (c6 r6))))))) blocked)
; an identical replayed check-fail does not increment
!(test (ph (append (start-r) (append (cf 1 c1 r1) (append (cf 2 c2 r2) (append (cf 3 c3 r3) ((o 403 check-fail (c3 (diag x.metta) r3)))))))) red)

; ---- R3.2: stand-in R3.1 counterexamples ----
; 1. approval sentinel: approved(none) with nothing pending cannot lead to delivery
!(test (ph (append (to-ready) ((o 7 approved (none jon)) (o 8 applied (none c1 jon))))) ready)
; 2. stale evidence: after stale→read→changed(c1) the old run r1 no longer counts; a fresh dispatch is required
!(test (ph (append (to-ready) ((o 7 stale ()) (o 8 read ()) (o 9 changed (c1 ())) (o 10 tests-pass (c1 r1)) (o d11 dispatched (q11 review c1)) (o 11 review-pass (c1 reviewer q11))))) edited)
!(test (ph (append (to-ready) ((o 7 stale ()) (o 8 read ()) (o 9 changed (c1 ())) (o 10 dispatched (r9 test c1)) (o 11 tests-pass (c1 r9)) (o d12 dispatched (q12 review c1)) (o 12 review-pass (c1 reviewer q12))))) ready)
; 3. a late check-fail does not release a blocked hold
!(test (ph (append (checked) ((o 7 check-unavailable (c1 (diag x.metta))) (o 8 check-fail (c1 (diag count.metta) r2))))) blocked)
; 4. at the cap: an unresolved effect still comes first, and cancel is terminal
!(test (next-action (st (append (start-r) (append (cf 1 c1 r1) (append (cf 2 c2 r2) (append (cf 3 c3 r3) ((o 600 unknown (op9)))))))) g_1 t) (do (reconcile op9)))
!(test (ph (append (start-r) (append (cf 1 c1 r1) (append (cf 2 c2 r2) (append (cf 3 c3 r3) (append (cf 4 c4 r4) ((o 601 cancelled ())))))))) stopped)

; ---- R3.3: stand-in R3.2 counterexamples ----
(= (exhausted) (append (start-r) (append (cf 1 c1 r1) (append (cf 2 c2 r2) (append (cf 3 c3 r3) (cf 4 c4 r4))))))
!(test (ph (exhausted)) blocked)
; 1. reconciliation does not release an exhausted repair hold
!(test (ph (append (exhausted) ((o 700 unknown (op8)) (o 701 reconciled (op8)) (o 702 read ()) (o 703 changed (c5 ())) (o 704 dispatched (r5 test c5)) (o 705 tests-pass (c5 r5)) (o d706 dispatched (q706 review c5)) (o 706 review-pass (c5 reviewer q706))))) blocked)
!(test (ph (append (checked) ((o 7 check-unavailable (c1 (diag x.metta))) (o 8 check-unknown (c1 (diag count.metta) r2)) (o 9 reconciled (r2))))) blocked)
; 2. a run id can be dispatched only once in the task's lifetime
!(test (ph (append (to-ready) ((o 7 stale ()) (o 8 read ()) (o 9 changed (c1 ())) (o 10 dispatched (r1 test c1)) (o 11 tests-pass (c1 r1)) (o d12 dispatched (q12 review c1)) (o 12 review-pass (c1 reviewer q12))))) edited)
!(test (final-of (rc (append (to-ready) ((o 7 stale ()) (o 8 read ()) (o 9 changed (c1 ())) (o 10 dispatched (r1 test c1)))))) (rejected run-id-reused))

; ---- R3.4: stand-in R3.3 counterexamples ----
; 1. an older confirmation cannot be used while a newer approval is pending
!(test (ph (append (to-ready) ((o 7 approval-needed (op5)) (o 8 approved (op5 jon)) (o 9 approval-needed (op6)) (o 10 applied (op5 c1 jon))))) ready)
; 2. after an edit, the old approval id and the old review can't be replayed (R3.11.3: the cleared confirmation is reconciled first)
!(test (ph (append (to-ready) ((o 7 approval-needed (op5)) (o 8 approved (op5 jon)) (o 9 stale ()) (o 91 reconciled (op5)) (o 10 read ()) (o 11 changed (c1 ()))
        (o 12 dispatched (r99 test c1)) (o 13 tests-pass (c1 r99)) (o 14 review-pass (c1 reviewer q6))
        (o 15 approval-needed (op5)) (o 16 approved (op5 jon)) (o 17 applied (op5 c1 jon))))) green)
; a fresh review request and a fresh approval do go through
!(test (ph (append (to-ready) ((o 9 stale ()) (o 10 read ()) (o 11 changed (c1 ()))
        (o 12 dispatched (r99 test c1)) (o 13 tests-pass (c1 r99)) (o 14 dispatched (q99 review c1)) (o 15 review-pass (c1 reviewer q99))
        (o 16 approval-needed (op7)) (o 17 approved (op7 jon)) (o 18 applied (op7 c1 jon))))) delivered)
; 3. a 'none' reviewer is refused
!(test (ph ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 tests-pass (c1 r1)) (o d6 dispatched (q6 review c1)) (o 6 review-pass (c1 none q6)))) green)

; ---- R3.5: stand-in R3.4 arrival-order counterexamples ----
; 1. a late test failure after green pulls it back to red; delivery impossible
!(test (ph ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 dispatched (r2 test c1))
            (o 6 tests-pass (c1 r1)) (o 7 tests-fail (c1 r2)) (o 8 dispatched (q1 review c1)) (o 9 review-pass (c1 reviewer q1))
            (o 10 approval-needed (op1)) (o 11 approved (op1 jon)) (o 12 applied (op1 c1 jon)))) red)
; 2. a late independent review failure after ready pulls it back; delivery impossible
!(test (ph ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 tests-pass (c1 r1))
            (o 6 dispatched (q1 review c1)) (o 7 dispatched (q2 review c1)) (o 8 review-pass (c1 reviewer1 q1)) (o 9 review-fail (c1 reviewer2 q2))
            (o 10 approval-needed (op1)) (o 11 approved (op1 jon)) (o 12 applied (op1 c1 jon)))) understood)
; a late failure after a confirmation also clears the confirmation; R3.11.4: the consented apply is exposed, so its readback comes first
(= (late-fail) ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 dispatched (r2 test c1))
            (o 6 tests-pass (c1 r1)) (o 7 dispatched (q1 review c1)) (o 8 review-pass (c1 reviewer q1))
            (o 9 approval-needed (op1)) (o 10 approved (op1 jon)) (o 11 tests-fail (c1 r2))))
!(test (next-action (st (late-fail)) g_1 t) (do (reconcile op1)))
!(test (next-action (st (append (late-fail) ((o 12 reconciled (op1))))) g_1 t) (think read-again-before-editing))
; blocked and terminal holds are preserved: a late failure on a blocked task stays blocked
!(test (ph (append (exhausted) ((o 800 tests-fail (c4 r4))))) blocked)

; ---- R3.6: Kimi + stand-in R3.5 counterexamples ----
; 1. an early review failure (arriving while edited) counts
!(test (ph ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 dispatched (q1 review c1)) (o 6 dispatched (q2 review c1))
            (o 7 review-fail (c1 reviewer1 q1)) (o 8 tests-pass (c1 r1)) (o 9 review-pass (c1 reviewer2 q2))
            (o 10 approval-needed (op1)) (o 11 approved (op1 jon)) (o 12 applied (op1 c1 jon)))) understood)
; 2. delivery cannot overtake an outstanding current-generation run
!(test (ph (append (to-ready) ((o 7 dispatched (r2 test c1)) (o 8 approval-needed (op1)) (o 9 approved (op1 jon)) (o 10 applied (op1 c1 jon))))) ready)
; once that run passes, the confirmed apply goes through
!(test (ph (append (to-ready) ((o 7 dispatched (r2 test c1)) (o 8 approval-needed (op1)) (o 9 approved (op1 jon)) (o 10 tests-pass (c1 r2)) (o 11 applied (op1 c1 jon))))) delivered)
; and if it fails, it pulls back to red
!(test (ph (append (to-ready) ((o 7 dispatched (r2 test c1)) (o 8 approval-needed (op1)) (o 9 approved (op1 jon)) (o 10 tests-fail (c1 r2)) (o 11 applied (op1 c1 jon))))) red)
; green waits for every dispatched test
!(test (ph ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 dispatched (r2 test c1)) (o 6 tests-pass (c1 r1)))) edited)
; a result counts once: a second identical-run result is rejected
!(test (final-of (rc (append (to-ready) ((o 7 tests-fail (c1 r1)))))) (rejected run-not-dispatched-for-this-candidate))
; 3. refused / unavailable clear the confirmation
; R3.11.3: the refusal cleared an armed confirmation, so the apply's readback is owed first, then the hold rests for the person
!(test (next-action (st (append (to-ready) ((o 7 approval-needed (op1)) (o 8 approved (op1 jon)) (o 9 refused ())))) g_1 t) (do (reconcile op1)))
!(test (next-action (st (append (to-ready) ((o 7 approval-needed (op1)) (o 8 approved (op1 jon)) (o 9 refused ()) (o 10 reconciled (op1))))) g_1 t) (rest needs-person))

; ---- R3.7: stand-in + Kimi R3.6 ----
; check results cannot retire test or review requests
!(test (ph (append (to-ready) ((o 7 dispatched (q70 review c1)) (o 8 check-pass (c1 review q70)) (o 9 approval-needed (op70)) (o 10 approved (op70 jon)) (o 11 applied (op70 c1 jon))))) ready)
!(test (final-of (rc (append (to-ready) ((o 7 dispatched (r70 test c1)) (o 8 check-pass (c1 test r70)))))) (rejected run-not-dispatched-for-this-candidate))
; an additional review pass in ready completes and lets the confirmed apply go through
!(test (ph (append (to-ready) ((o 7 dispatched (q70 review c1)) (o 8 review-pass (c1 reviewer2 q70)) (o 9 approval-needed (op70)) (o 10 approved (op70 jon)) (o 11 applied (op70 c1 jon))))) delivered)
; an early review pass (while edited) is kept, and green then goes straight to ready
!(test (ph ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 dispatched (q1 review c1)) (o 6 review-pass (c1 reviewer q1)) (o 7 tests-pass (c1 r1)))) ready)
; next-action waits for outstanding results instead of proposing apply or run-check none
!(test (next-action (st (append (to-ready) ((o 7 dispatched (r2 test c1)) (o 8 approval-needed (op1)) (o 9 approved (op1 jon))))) g_1 t) (rest awaiting-results))
!(test (next-action (st ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 dispatched (r2 test c1)) (o 6 tests-pass (c1 r1)))) g_1 t) (rest awaiting-results))
; entering blocked drains open runs into unresolved (they must be reconciled)
!(test (next-action (st (append (checked) ((o 7 refused ())))) g_1 t) (do (reconcile r2)))
; Kimi's phantom-green sequence stays edited (regression)
!(test (ph ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 tests-pass (c1 r9)) (o 6 check-pass (c1 (diag never.metta) r9)))) edited)

; ---- R3.8: proposals ----
(= (at-understood) ((o 1 opened ()) (o 2 read ())))
; a phase-admissible proposal is selected, then executed once, then consumed by the real result
!(test (next-action (st (append (at-understood) ((o 3 proposed (p1 edit d1))))) g_1 t) (do (select-proposal p1)))
!(test (next-action (st (append (at-understood) ((o 3 proposed (p1 edit d1)) (o 4 proposal-selected (p1 edit d1))))) g_1 t) (do (execute-proposal p1 edit d1)))
!(test (next-action (st (append (at-understood) ((o 3 proposed (p1 edit d1)) (o 4 proposal-selected (p1 edit d1)) (o 5 proposal-executing (p1 op1))))) g_1 t) (rest awaiting-results))
!(test (ph (append (at-understood) ((o 3 proposed (p1 edit d1)) (o 4 proposal-selected (p1 edit d1)) (o 5 proposal-executing (p1 op1)) (o 51 proposal-done (p1 op1)) (o 6 changed (c1 ()))))) edited)
; after the result, the next think phase starts fresh (no stale proposal)
!(test (next-action (st (append (at-understood) ((o 3 proposed (p1 edit d1)) (o 4 proposal-selected (p1 edit d1)) (o 5 proposal-executing (p1 op1)) (o 51 proposal-done (p1 op1)) (o 6 changed (c1 ()))))) g_1 t) (do (code-exec t)))
; an inadmissible action (read while understood) is refused, so think again
!(test (final-of (rc (append (at-understood) ((o 3 proposed (p1 read d1)))))) (rejected proposal-not-admissible))
; changed bytes at selection are refused
!(test (final-of (rc (append (at-understood) ((o 3 proposed (p1 edit d1)) (o 4 proposal-selected (p1 edit d2)))))) (rejected proposal-not-pending-or-changed))
; one proposal at a time; executing cannot repeat
!(test (final-of (rc (append (at-understood) ((o 3 proposed (p1 edit d1)) (o 4 proposed (p2 edit d2)))))) (rejected proposal-not-admissible))
!(test (final-of (rc (append (at-understood) ((o 3 proposed (p1 edit d1)) (o 4 proposal-selected (p1 edit d1)) (o 5 proposal-executing (p1 op1)) (o 6 proposal-executing (p1 op2)))))) (rejected proposal-not-selected-or-not-admissible-now))
; a proposal id is lifetime-unique
!(test (final-of (rc (append (at-understood) ((o 3 proposed (p1 edit d1)) (o 4 stale ()) (o 5 read ()) (o 6 proposed (p1 edit d1)))))) (rejected proposal-id-reused))
; stale invalidates an obsolete proposal
!(test (next-action (st (append (at-understood) ((o 3 proposed (p1 edit d1)) (o 4 stale ())))) g_1 t) (think read-again-before-editing))
; no proposal is admitted while an effect is unresolved
!(test (final-of (rc (append (at-understood) ((o 3 unknown (op9)) (o 4 proposed (p1 edit d1)))))) (rejected proposal-not-admissible))
; a proposal is never evidence: it can't make tests pass or deliver
!(test (ph (append (at-understood) ((o 3 proposed (p1 edit d1)) (o 4 proposal-selected (p1 edit d1)) (o 5 proposal-executing (p1 op1))))) understood)
!(test (final-of (rc (append (at-understood) ((o 3 proposal-executing (p1 op1)))))) (rejected proposal-not-selected-or-not-admissible-now))
!(test (final-of (rc (append (at-understood) ((o 3 proposal-selected (p1 edit d1)))))) (rejected proposal-not-pending-or-changed))

; ---- R3.8 also: stand-in R3.7 P2s ----
; cap-blocking drains the other open run into unresolved, so it must be reconciled
!(test (next-action (st (append (start-r) (append (cf 1 c1 r1) (append (cf 2 c2 r2) (append (cf 3 c3 r3)
        ((o 900 read ()) (o 901 changed (c4 ())) (o 902 dispatched (ra test c4)) (o 903 dispatched (rb test c4)) (o 904 tests-fail (c4 ra)))))))) g_1 t) (do (reconcile rb)))
; an in-flight test is not re-launched
!(test (next-action (st ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (ra test c1)))) g_1 t) (rest awaiting-results))
; an in-flight check is not re-launched
!(test (next-action (st (checked)) g_1 t) (rest awaiting-results))

; ---- R3.9: OmegaCode's R3.8 pre-admission cases ----
; green waits for an in-flight review instead of requesting another
!(test (next-action (st ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 tests-pass (c1 r1)) (o 6 dispatched (q1 review c1)))) g_1 t) (rest awaiting-results))
; stale keeps an open run's obligation: it must be reconciled
!(test (next-action (st ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 stale ()))) g_1 t) (do (reconcile r1)))
; cancel keeps the cleanup obligation, and the task stays stopped after reconciling
!(test (next-action (st ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 cancelled ()))) g_1 t) (do (reconcile r1)))
!(test (ph ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 cancelled ()) (o 6 reconciled (r1)))) stopped)

; ---- R3.10: Kimi + stand-in R3.8 ----
(= (exec1) (append (at-understood) ((o 3 proposed (p1 edit d1)) (o 4 proposal-selected (p1 edit d1)) (o 5 proposal-executing (p1 op1)))))
; an executing proposal's operation can't vanish: stale keeps it in the ledger (R3.11), so the controller waits for its result
!(test (next-action (st (append (exec1) ((o 6 stale ())))) g_1 t) (rest awaiting-results))
; an unrelated read does not release it, and changed is refused until the effect is reported
!(test (next-action (st (append (exec1) ((o 6 read ())))) g_1 t) (rest awaiting-results))
!(test (final-of (rc (append (exec1) ((o 6 changed (c1 ())))))) (rejected proposal-effect-unreported))
; execution re-checks holds: a pending approval blocks execution
!(test (final-of (rc (append (at-understood) ((o 3 proposed (p1 edit d1)) (o 4 proposal-selected (p1 edit d1)) (o 5 approval-needed (opA)) (o 6 proposal-executing (p1 op1)))))) (rejected proposal-not-selected-or-not-admissible-now))
; any other accepted observation clears an unexecuted selection
!(test (next-action (st (append (at-understood) ((o 3 proposed (p1 edit d1)) (o 4 proposal-selected (p1 edit d1)) (o 5 unknown (op9)) (o 6 reconciled (op9))))) g_1 t) (think read-again-before-editing))
; operation ids are lifetime-unique
!(test (final-of (rc (append (at-understood) ((o 3 proposed (p1 read d1)) (o 4 stale ()) (o 5 read ())
        (o 6 proposed (p2 edit d2)) (o 7 proposal-selected (p2 edit d2)) (o 8 proposal-executing (p2 op1)) (o 9 proposal-done (p2 op1))
        (o 10 changed (c1 ())) (o 11 dispatched (op1 test c1)))))) (rejected run-id-reused))
; cap-block with no other open run rests for the person (R3.11: comment corrected; the proposal case is below)
!(test (next-action (st (append (start-r) (append (cf 1 c1 r1) (append (cf 2 c2 r2) (append (cf 3 c3 r3)
        ((o 900 read ()) (o 901 changed (c4 ())) (o 902 dispatched (ra test c4)) (o 903 tests-fail (c4 ra)))))))) g_1 t) (rest needs-person))
; the full happy path with a proposal-driven edit still delivers
!(test (ph (append (exec1) ((o 6 proposal-done (p1 op1)) (o 7 changed (c1 ())) (o 8 dispatched (r1 test c1)) (o 9 tests-pass (c1 r1))
        (o 10 dispatched (q1 review c1)) (o 11 review-pass (c1 reviewer q1)) (o 12 approval-needed (opZ)) (o 13 approved (opZ jon)) (o 14 applied (opZ c1 jon))))) delivered)

; ---- R3.11: Kimi + stand-in R3.10 ----
; stand-in P1: reconciling an unrelated operation does not retire the executing proposal
!(test (next-action (st (append (exec1) ((o 6 unknown (opX)) (o 7 reconciled (opX))))) g_1 t) (rest awaiting-results))
!(test (final-of (rc (append (exec1) ((o 6 unknown (opX)) (o 7 reconciled (opX)) (o 8 read ()) (o 9 changed (c2 ())))))) (rejected proposal-effect-unreported))
; stand-in P1, parallel-check form: reconciling the check keeps the proposal open
(= (red-k1) ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ((diag count.metta)))) (o 4 dispatched (r1 test c1))
             (o 5 dispatched (k1 (diag count.metta) c1)) (o 6 tests-fail (c1 r1))))
!(test (ph (red-k1)) red)
!(test (final-of (rc (append (red-k1) ((o 7 proposed (p1 edit d1)) (o 8 proposal-selected (p1 edit d1)) (o 9 proposal-executing (p1 op1))
        (o 10 check-unknown (c1 (diag count.metta) k1)) (o 11 reconciled (k1)) (o 12 read ()) (o 13 changed (c2 ())))))) (rejected proposal-effect-unreported))
; reconciling one run drains, never drops, a second open run
!(test (next-action (st ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ((diag count.metta)))) (o 4 dispatched (r1 test c1))
        (o 5 dispatched (k1 (diag count.metta) c1)) (o 6 check-unknown (c1 (diag count.metta) k1)) (o 7 reconciled (k1)))) g_1 t) (do (reconcile r1)))
; stand-in P2: a dispatch clears an unexecuted selection
!(test (final-of (rc (append (at-understood) ((o 3 proposed (p1 edit d1)) (o 4 proposal-selected (p1 edit d1)) (o 5 dispatched (rX test c0)) (o 6 proposal-executing (p1 op1))))))
       (rejected proposal-not-selected-or-not-admissible-now))
; Kimi 1: after stale the executing operation is still outstanding: changed refused, and reconcile can't retire it
!(test (final-of (rc (append (exec1) ((o 6 stale ()) (o 7 read ()) (o 8 changed (c2 ())))))) (rejected proposal-effect-unreported))
!(test (final-of (rc (append (exec1) ((o 6 stale ()) (o 7 reconciled (op1)))))) (rejected not-an-unresolved-operation))
; an explicit loss of the executing operation is reconciled, then the controller must read again
!(test (next-action (st (append (exec1) ((o 6 unknown (op1))))) g_1 t) (do (reconcile op1)))
!(test (next-action (st (append (exec1) ((o 6 unknown (op1)) (o 7 reconciled (op1))))) g_1 t) (think read-again-before-editing))
; Kimi 4: a rejected execution drops the selection, so it is not re-armed after the hold clears
!(test (next-action (st (append (at-understood) ((o 3 proposed (p1 edit d1)) (o 4 proposal-selected (p1 edit d1)) (o 5 approval-needed (opA))
        (o 6 proposal-executing (p1 op1)) (o 7 approved (opA jon))))) g_1 t) (think make-the-smallest-change))
; Kimi 5 (no livelock, with a real proposal): blocking while a read proposal executes; its proposal-done still lands
(= (red-exec) (append (red-k1) ((o 7 proposed (p1 read d1)) (o 8 proposal-selected (p1 read d1)) (o 9 proposal-executing (p1 op1)))))
!(test (next-action (st (append (red-exec) ((o 10 check-unavailable (c1 (diag count.metta)))))) g_1 t) (do (reconcile k1)))
!(test (final-of (rc (append (red-exec) ((o 10 check-unavailable (c1 (diag count.metta))) (o 11 proposal-done (p1 op1)))))) accepted)
!(test (prop-of (st (append (red-exec) ((o 10 check-unavailable (c1 (diag count.metta))) (o 11 proposal-done (p1 op1)))))) none)
; after a stop, the executing operation may still report
!(test (final-of (rc (append (exec1) ((o 6 cancelled ()) (o 7 proposal-done (p1 op1)))))) accepted)
; a hold still drains open runs on stale, so their readback is owed
!(test (next-action (st ((o 1 opened ()) (o 2 read ()) (o 3 refused ()) (o 4 dispatched (rz test c0)) (o 5 stale ()))) g_1 t) (do (reconcile rz)))

; ---- R3.11: root suggest-only profile and candidate-retained (F4 addendum 4) ----
(= (rctx) (Ctx g_1 e1 jon (coder) 3 root-suggest review-required))
(= (rph $log) (phase-of (replay (rctx) (start-state) $log)))
(= (rrc $log) (receipts (rctx) (start-state) $log))
!(test (final-of (rrc ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ()))))) (rejected origin-edit-not-in-profile))
!(test (rph ((o 1 opened ()) (o 2 read ()) (o 3 candidate-retained (c1 () f1)))) edited)
!(test (final-of (rrc ((o 1 opened ()) (o 2 read ()) (o 3 candidate-retained (c1 () none))))) (rejected candidate-needs-its-fork))
!(test (final-of (rc ((o 1 opened ()) (o 2 read ()) (o 3 candidate-retained (c1 () f1))))) (rejected candidate-retained-not-in-profile))
; the root path validates the retained candidate and delivers only through the person's confirmed apply
!(test (rph ((o 1 opened ()) (o 2 read ()) (o 3 candidate-retained (c1 () f1)) (o 4 dispatched (r1 test c1)) (o 5 tests-pass (c1 r1))
        (o 6 dispatched (q1 review c1)) (o 7 review-pass (c1 reviewer q1)) (o 8 approval-needed (opP)) (o 9 approved (opP jon)) (o 10 applied (opP c1 jon)))) delivered)

; ---- R3.11.1: Kimi R3.11 ----
; P1 claims, refuted by execution and kept as regressions: losing the executing op with another run open drains that run;
; the edit is refused until both are reconciled and a fresh read happens
(= (lost) (append (red-k1) ((o 7 proposed (p1 read d1)) (o 8 proposal-selected (p1 read d1)) (o 9 proposal-executing (p1 op1)) (o 10 unknown (op1)) (o 11 reconciled (op1)))))
!(test (ph (lost)) reconcile)
!(test (final-of (rc (append (lost) ((o 12 read ()) (o 13 changed (c2 ())))))) (rejected unresolved-effect-first))
!(test (final-of (rc (append (lost) ((o 12 reconciled (k1)) (o 13 changed (c3 ())))))) (rejected edit-without-fresh-read))
; no deadlock in blocked: an executing op can be reported lost, and after a stop its proposal-done clears the proposal
(= (blk) (append (red-k1) ((o 7 proposed (p1 edit d1)) (o 8 proposal-selected (p1 edit d1)) (o 9 proposal-executing (p1 op1)) (o 10 check-unavailable (c1 (diag count.metta))))))
!(test (next-action (st (append (blk) ((o 11 unknown (op1))))) g_1 t) (do (reconcile op1)))
!(test (prop-of (st (append (blk) ((o 11 cancelled ()) (o 12 proposal-done (p1 op1)))))) none)
; P2: under root-suggest, runs are proposal tests on the retained candidate and apply is the person's
(= (rst $log) (replay (rctx) (start-state) $log))
(= (r-ret) ((o 1 opened ()) (o 2 read ()) (o 3 candidate-retained (c1 ((diag count.metta)) f1))))
!(test (next-action-for root-suggest (rst (r-ret)) g_1 t) (do (proposal-test c1 t)))
!(test (next-action-for root-suggest (rst (append (r-ret) ((o 4 dispatched (r1 test c1)) (o 5 tests-pass (c1 r1))))) g_1 t) (do (proposal-check c1 (diag count.metta))))
(= (r-ready) ((o 1 opened ()) (o 2 read ()) (o 3 candidate-retained (c1 () f1)) (o 4 dispatched (r1 test c1)) (o 5 tests-pass (c1 r1))
              (o 6 dispatched (q1 review c1)) (o 7 review-pass (c1 reviewer q1)) (o 8 approval-needed (opP)) (o 9 approved (opP jon))))
!(test (next-action-for root-suggest (rst (r-ready)) g_1 t) (rest awaiting-person-apply))
!(test (next-action-for delegated (st (append (to-ready) ((o 7 approval-needed (op5)) (o 8 approved (op5 jon))))) g_1 t) (do (apply-confirmed (op5 c1 jon))))

; ---- R3.11.2: stand-in + Kimi R3.11.1 (their executed traces) ----
; stand-in P1: no delivery while an older candidate's run is unresolved (both profiles)
(= (debt) (append (at-understood) ((o z changed (c1 ())) (o a dispatched (old test c1)) (o b changed (c2 ())) (o c dispatched (new test c2))
          (o d tests-pass (c2 new)) (o e dispatched (q2 review c2)) (o f review-pass (c2 reviewer q2)) (o g approval-needed (a2)) (o h approved (a2 jon)) (o i applied (a2 c2 jon)))))
!(test (final-of (rc (debt))) (rejected apply-not-confirmed-for-this-candidate))
!(test (next-action (st (debt)) g_1 t) (do (reconcile old)))
(= (root-debt) ((o 1 opened ()) (o 2 read ()) (o 3 candidate-retained (c1 () f1)) (o 4 dispatched (old test c1)) (o 5 candidate-retained (c2 () f2))
               (o 6 dispatched (new test c2)) (o 7 tests-pass (c2 new)) (o 8 dispatched (q2 review c2)) (o 9 review-pass (c2 reviewer q2))
               (o 10 approval-needed (a2)) (o 11 approved (a2 jon)) (o 12 applied (a2 c2 jon))))
!(test (final-of (rrc (root-debt))) (rejected apply-not-confirmed-for-this-candidate))
; after reconciling the debt the candidate must be re-read and re-validated
!(test (rph (append (root-debt) ((o 13 reconciled (old))))) reconcile)   ; R3.11.4: the consented apply a2 is drained into debt too
!(test (rph (append (root-debt) ((o 13 reconciled (old)) (o 14 reconciled (a2))))) needs-read)
; stand-in P2: a loss after stopping is reportable, stays stopped, and is reconciled
(= (stopped-loss) (append (exec1) ((o x cancelled ()) (o y unknown (op1)))))
!(test (final-of (rc (stopped-loss))) accepted)
!(test (ph (stopped-loss)) stopped)
!(test (next-action (st (stopped-loss)) g_1 t) (do (reconcile op1)))
!(test (ph (append (stopped-loss) ((o w reconciled (op1))))) stopped)
!(test (disp-of (st (append (stopped-loss) ((o w reconciled (op1)))))) ())
; R3.11.5: a stopped task admits any loss report (host effects outside the ledger, e.g. an open) and stays stopped
!(test (final-of (rc (append (exec1) ((o x cancelled ()) (o y unknown (op9)))))) accepted)
!(test (ph (append (exec1) ((o x cancelled ()) (o y unknown (op9))))) stopped)
; Kimi 1: under root-suggest an edit proposal is never admissible; suggest is
!(test (final-of (rrc ((o 1 opened ()) (o 2 read ()) (o 3 proposed (p1 edit d1))))) (rejected proposal-not-admissible))
!(test (final-of (rrc ((o 1 opened ()) (o 2 read ()) (o 3 proposed (p1 suggest d1)) (o 4 proposal-selected (p1 suggest d1)) (o 5 proposal-executing (p1 op1))
        (o 6 proposal-done (p1 op1)) (o 7 candidate-retained (c1 () f1))))) accepted)
!(test (final-of (rc ((o 1 opened ()) (o 2 read ()) (o 3 proposed (p1 suggest d1))))) (rejected proposal-not-admissible))
; Kimi 2: nothing new is dispatched after delivery or stop
!(test (final-of (rc (append (to-ready) ((o 7 approval-needed (op5)) (o 8 approved (op5 jon)) (o 9 applied (op5 c1 jon)) (o 10 dispatched (rz test c1)))))) (rejected terminal))
!(test (final-of (rc ((o 1 opened ()) (o 2 read ()) (o 3 cancelled ()) (o 4 dispatched (rz test c0))))) (rejected terminal))
; Kimi 3: root opens read-only and reviews the retained candidate
!(test (next-action-for root-suggest (start-state) g_1 t) (do (code-open-readonly g_1)))
!(test (next-action-for root-suggest (rst ((o 1 opened ()) (o 2 read ()) (o 3 candidate-retained (c1 () f1)) (o 4 dispatched (r1 test c1)) (o 5 tests-pass (c1 r1)))) g_1 t) (do (proposal-review c1)))
; Kimi 4: dispatch can't forge the internal proposal kind
!(test (final-of (rc (append (to-ready) ((o 7 dispatched (opZ proposal pZ)))))) (rejected run-kind-not-dispatchable))
; Kimi 5: a duplicate loss report is refused
!(test (final-of (rc ((o 1 opened ()) (o 2 read ()) (o 3 unknown (op7)) (o 4 unknown (op7))))) (rejected already-unresolved))

; ---- R3.11.3: stand-in + Kimi R3.11.2 ----
; stand-in P1: cancelling with a confirmed apply in flight keeps the apply as debt (both profiles)
(= (apply-inflight) (append (to-ready) ((o a approval-needed (apply1)) (o b approved (apply1 jon)))))
(= (apply-loss) (append (apply-inflight) ((o c cancelled ()) (o d unknown (apply1)))))
!(test (next-action (st (append (apply-inflight) ((o c cancelled ())))) g_1 t) (do (reconcile apply1)))
!(test (final-of (rc (apply-loss))) (rejected already-unresolved))
!(test (ph (append (apply-loss) ((o e reconciled (apply1))))) stopped)
!(test (next-action-for root-suggest (rst (append (r-ready) ((o c cancelled ())))) g_1 t) (do (reconcile opP)))
; a stale origin after confirmation also owes the apply's readback
!(test (next-action (st (append (apply-inflight) ((o c stale ())))) g_1 t) (do (reconcile apply1)))
; the apply's own result clears the confirmation without debt
!(test (next-action (st (append (apply-inflight) ((o c applied (apply1 c1 jon))))) g_1 t) (rest done))
; Kimi P2: a stopped task answers a repeated loss report for a drained run as already-unresolved, not terminal
!(test (final-of (rc ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 cancelled ()) (o 6 unknown (r1))))) (rejected already-unresolved))
; stand-in P2: required checks can't name the reserved kinds
!(test (final-of (rrc ((o 1 opened ()) (o 2 read ()) (o 3 candidate-retained (c1 (review) f1))))) (rejected reserved-check-kind))
!(test (final-of (rc ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ((diag x.metta) test)))))) (rejected reserved-check-kind))   ; `(test)` alone would evaluate as the harness test call

; ---- R3.11.4: stand-in + Kimi R3.11.3 (their executed traces): the consented apply is a ledger entry ----
; stand-in P1 / Kimi P1: an intervening dispatch, or an unrelated loss, no longer masks the apply (both profiles)
(= (lost-apply $base) (append $base ((o x1 dispatched (late test c1)) (o x2 cancelled ()) (o x3 reconciled (late)))))
!(test (next-action (st (lost-apply (apply-inflight))) g_1 t) (do (reconcile apply1)))
!(test (ph (append (lost-apply (apply-inflight)) ((o x4 reconciled (apply1))))) stopped)
!(test (next-action-for root-suggest (rst (lost-apply (r-ready))) g_1 t) (do (reconcile opP)))
(= (ghost) (append (apply-inflight) ((o x1 unknown (other)) (o x2 reconciled (other)))))
!(test (next-action (st (ghost)) g_1 t) (do (reconcile apply1)))
; a late failure behind an open run also keeps the consented apply as debt
!(test (next-action (st (append (apply-inflight) ((o x1 dispatched (r9 test c1)) (o x2 tests-fail (c1 r9))))) g_1 t) (do (reconcile apply1)))
; the loss of the apply itself after a stop is accepted and reconciled
!(test (final-of (rc (append (apply-inflight) ((o x1 dispatched (r9 test c1)) (o x2 cancelled ()) (o x3 reconciled (r9)) (o x4 unknown (apply1)))))) (rejected already-unresolved))
; an apply waits for any run dispatched after consent, then goes through
!(test (next-action (st (append (apply-inflight) ((o x1 dispatched (r9 test c1))))) g_1 t) (rest awaiting-results))
!(test (ph (append (apply-inflight) ((o x1 dispatched (r9 test c1)) (o x2 tests-pass (c1 r9)) (o x3 applied (apply1 c1 jon))))) delivered)
; the apply's ledger entry can't be forged or required
!(test (final-of (rc (append (to-ready) ((o 7 dispatched (opX apply c1)))))) (rejected run-kind-not-dispatchable))
(= (stuck-d $k) ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ($k)))))
!(test (final-of (rc (stuck-d proposal))) (rejected reserved-check-kind))
!(test (final-of (rc (stuck-d none))) (rejected reserved-check-kind))
!(test (final-of (rc (stuck-d apply))) (rejected reserved-check-kind))
!(test (final-of (rrc ((o 1 opened ()) (o 2 read ()) (o 3 candidate-retained (c1 (proposal) f1))))) (rejected reserved-check-kind))

; ---- R3.11.5: stand-in R3.11.4 (executed traces) + Kimi's requested regression ----
; P1: an apply id can't be reused as a run id, nor a run id as an apply id
!(test (final-of (rc (append (apply-inflight) ((o x1 dispatched (apply1 test c1)))))) (rejected run-id-reused))
!(test (final-of (rc (append (to-ready) ((o x1 dispatched (same test c1)) (o x2 approval-needed (same)))))) (rejected approval-id-reused))
!(test (final-of (rrc (append (r-ready) ((o x1 dispatched (opP test c1)))))) (rejected run-id-reused))
; P2: an open lost after a stop is reportable and reconciled, and the task stays stopped (both profiles)
!(test (next-action (st ((o x1 cancelled ()) (o x2 unknown (open1)))) g_1 t) (do (reconcile open1)))
!(test (ph ((o x1 cancelled ()) (o x2 unknown (open1)) (o x3 reconciled (open1)))) stopped)
!(test (next-action-for root-suggest (rst ((o x1 cancelled ()) (o x2 unknown (open1)))) g_1 t) (do (reconcile open1)))
; Kimi: reconciling the lost apply in ready with a run still open drains that run; it becomes the debt head
(= (apply-run-loss) (append (apply-inflight) ((o x1 dispatched (r9 test c1)) (o x2 unknown (apply1)))))
!(test (next-action (st (apply-run-loss)) g_1 t) (do (reconcile apply1)))
!(test (ph (append (apply-run-loss) ((o x3 reconciled (apply1))))) reconcile)
!(test (next-action (st (append (apply-run-loss) ((o x3 reconciled (apply1))))) g_1 t) (do (reconcile r9)))
!(test (ph (append (apply-run-loss) ((o x3 reconciled (apply1)) (o x4 reconciled (r9))))) needs-read)

; ---- R3.11.5 doc (Kimi): after delivery, a loss report is admitted, stays delivered and owes a readback ----
(= (delivered-loss) (append (apply-inflight) ((o x1 applied (apply1 c1 jon)) (o x2 unknown (op9)))))
!(test (ph (delivered-loss)) delivered)
!(test (next-action (st (delivered-loss)) g_1 t) (do (reconcile op9)))
!(test (next-action (st (append (delivered-loss) ((o x3 reconciled (op9))))) g_1 t) (rest done))

; =====================================================================================================================
; ---- R3.12: every host event has its own kind (Dot, peer of OmegaCode) ----
; Carried above: all 183 R3.11.5 tests, unchanged except the Ctx shape (authors is now a set, `(coder)`, and the
; person's review policy is a 7th field, `review-required`, which keeps R3.11.5 behaviour).
(= (rep-of (S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp $prop $seen)) $rep)
(= (tested-of (S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp $prop $seen)) $tested)
(= (wctx) (Ctx g_1 e1 jon (coder) 3 delegated review-waivable))
(= (wrctx) (Ctx g_1 e1 jon (coder) 3 root-suggest review-waivable))
(= (wst $log) (replay (wctx) (start-state) $log))
(= (wrc $log) (receipts (wctx) (start-state) $log))
(= (wrst $log) (replay (wrctx) (start-state) $log))

; ---- (1) host read under root-suggest: no think, no model, for reading ----
!(test (next-action-for root-suggest (rst ((o 1 opened ()))) g_1 t) (do (host-read find-the-relevant-code)))
!(test (needs-model (next-action-for root-suggest (rst ((o 1 opened ()))) g_1 t)) False)
!(test (next-action-for root-suggest (rst ((o 1 opened ()) (o 2 read ()) (o 3 candidate-retained (c1 () f1)) (o 4 stale ()))) g_1 t)
       (do (host-read read-again-before-editing)))
; the delegated profile is unchanged
!(test (next-action-for delegated (st ((o 1 opened ()))) g_1 t) (think find-the-relevant-code))
; a model read/search proposal is never admissible under root-suggest (reading is the host's); suggest still is
!(test (final-of (rrc ((o 1 opened ()) (o 2 proposed (p1 read d1))))) (rejected proposal-not-admissible))
!(test (final-of (rrc ((o 1 opened ()) (o 2 proposed (p1 search d1))))) (rejected proposal-not-admissible))
!(test (final-of (rrc ((o 1 opened ()) (o 2 read ()) (o 3 proposed (p1 suggest d1))))) accepted)
!(test (final-of (rc ((o 1 opened ()) (o 2 proposed (p1 read d1))))) accepted)
; an executing suggest still holds the read back until its own result (R3.11 invariant kept)
!(test (next-action-for root-suggest (rst ((o 1 opened ()) (o 2 read ()) (o 3 proposed (p1 suggest d1)) (o 4 proposal-selected (p1 suggest d1))
        (o 5 proposal-executing (p1 op1)) (o 6 stale ()))) g_1 t) (rest awaiting-results))

; ---- (2) think-started / think-failed ----
(= (thk) (append (at-understood) ((o t1 think-started (a1 h1)))))
!(test (final-of (rc (thk))) accepted)
!(test (next-action (st (thk)) g_1 t) (rest awaiting-helper))
!(test (next-action-for root-suggest (rst (thk)) g_1 t) (rest awaiting-helper))
!(test (needs-model (next-action (st (thk)) g_1 t)) False)
; a failed helper costs one repair and changes nothing else: the controller thinks again
!(test (rep-of (st (append (thk) ((o t2 think-failed (a1)))))) 1)
!(test (ph (append (thk) ((o t2 think-failed (a1))))) understood)
!(test (next-action (st (append (thk) ((o t2 think-failed (a1))))) g_1 t) (think make-the-smallest-change))
; the cap: three failures stay within policy, a fourth blocks
(= (tf $n) ((o (+ 10 $n) think-started ((+ 100 $n) h1)) (o (+ 20 $n) think-failed ((+ 100 $n)))))
!(test (ph (append (at-understood) (append (tf 1) (append (tf 2) (tf 3))))) understood)
!(test (ph (append (at-understood) (append (tf 1) (append (tf 2) (append (tf 3) (tf 4)))))) blocked)
!(test (next-action (st (append (at-understood) (append (tf 1) (append (tf 2) (append (tf 3) (tf 4)))))) g_1 t) (rest needs-person))
; think failures share the counter with test/check failures
!(test (ph (append (start-r) (append (cf 1 c1 r1) (append (cf 2 c2 r2) (append (cf 3 c3 r3) ((o 900 think-started (a9 h1)) (o 901 think-failed (a9)))))))) blocked)
; blocking on the cap drains an open run, so its readback is owed
!(test (next-action (st (append (red-k1) ((o 7 think-started (a1 h1)) (o 8 think-failed (a1)) (o 9 think-started (a2 h1)) (o 10 think-failed (a2))
        (o 11 think-started (a3 h1)) (o 12 think-failed (a3))))) g_1 t) (do (reconcile k1)))
; adversarial: a failure with no open attempt, for another attempt, or twice for the same attempt
!(test (final-of (rc (append (at-understood) ((o t2 think-failed (a1)))))) (rejected not-the-open-think))
!(test (final-of (rc (append (thk) ((o t2 think-failed (a2)))))) (rejected not-the-open-think))
!(test (final-of (rc (append (thk) ((o t2 think-failed (a1)) (o t3 think-failed (a1)))))) (rejected not-the-open-think))
!(test (rep-of (st (append (thk) ((o t2 think-failed (a1)) (o t3 think-failed (a1)))))) 1)
; attempt ids are lifetime-unique operation ids, in both orders
!(test (final-of (rc (append (thk) ((o t2 think-failed (a1)) (o t3 think-started (a1 h1)))))) (rejected operation-id-reused))
!(test (final-of (rc (append (at-understood) ((o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 tests-fail (c1 r1)) (o 6 think-started (r1 h1)))))) (rejected operation-id-reused))
!(test (final-of (rc (append (thk) ((o t2 think-failed (a1)) (o 3 changed (c1 ())) (o 4 dispatched (a1 test c1)))))) (rejected run-id-reused))
; a start is refused outside the candidate-producing phases, under debt, twice, or beside a proposal
!(test (final-of (rc ((o 1 opened ()) (o 2 think-started (a1 h1))))) (rejected think-not-due))
!(test (final-of (rc (append (at-understood) ((o 3 unknown (op9)) (o 4 think-started (a1 h1)))))) (rejected think-not-due))
!(test (final-of (rc (append (thk) ((o t2 think-started (a2 h2)))))) (rejected think-not-due))
!(test (final-of (rc (append (at-understood) ((o 3 proposed (p1 edit d1)) (o 4 think-started (a1 h1)))))) (rejected think-not-due))
!(test (final-of (rc (append (at-understood) ((o 3 think-started (a1 none)))))) (rejected think-not-due))
!(test (final-of (rc (append (thk) ((o 3 proposed (p1 edit d1)))))) (rejected proposal-not-admissible))
; the candidate ends the attempt; a late failure for it is refused and costs nothing
!(test (prop-of (rst (append (thk) ((o 3 candidate-retained (c1 () f1)))))) none)
!(test (final-of (rrc (append (thk) ((o 3 candidate-retained (c1 () f1)) (o 4 think-failed (a1)))))) (rejected not-the-open-think))
!(test (rep-of (replay (rctx) (start-state) (append (thk) ((o 3 candidate-retained (c1 () f1)) (o 4 think-failed (a1)))))) 0)
; an unrelated accepted observation, or a refused execution, does not forget the running helper
!(test (prop-of (st (append (thk) ((o 3 read ()))))) (thinking a1 h1))
!(test (prop-of (st (append (thk) ((o 3 proposal-executing (p1 op1)))))) (thinking a1 h1))
; stale while a helper runs: the read is not delayed, the helper is still awaited after it
!(test (next-action (st (append (thk) ((o 3 stale ())))) g_1 t) (think read-again-before-editing))
!(test (next-action-for root-suggest (rst (append (thk) ((o 3 stale ())))) g_1 t) (do (host-read read-again-before-editing)))
!(test (next-action (st (append (thk) ((o 3 stale ()) (o 4 read ())))) g_1 t) (rest awaiting-helper))
; a failure reported in needs-read never skips the read
!(test (ph (append (thk) ((o 3 stale ()) (o 4 think-failed (a1))))) needs-read)
!(test (final-of (rc (append (thk) ((o 3 stale ()) (o 4 think-failed (a1)) (o 5 changed (c1 ())))))) (rejected edit-without-fresh-read))
; after a stop the failure is refused as terminal
!(test (final-of (rc (append (thk) ((o 3 cancelled ()) (o 4 think-failed (a1)))))) (rejected terminal))

; ---- (3) review-unavailable, by the person's review policy ----
(= (greenc) ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 tests-pass (c1 r1))))
!(test (ph (greenc)) green)
; review-required: exactly like check-unavailable (never a pass): blocked, rests for the person
!(test (final-of (rc (append (greenc) ((o 6 review-unavailable (c1)))))) (accepted (review-unavailable blocked)))
!(test (ph (append (greenc) ((o 6 review-unavailable (c1))))) blocked)
!(test (next-action (st (append (greenc) ((o 6 review-unavailable (c1))))) g_1 t) (rest needs-person))
!(test (ph (append (greenc) ((o 6 review-unavailable (c1)) (o 7 approval-needed (op1)) (o 8 approved (op1 jon)) (o 9 applied (op1 c1 jon))))) blocked)
; ...and a consent given before it becomes debt, as with check-unavailable
!(test (next-action (st (append (greenc) ((o 6 approval-needed (op1)) (o 7 approved (op1 jon)) (o 8 review-unavailable (c1))))) g_1 t) (do (reconcile op1)))
; review-waivable: the tested candidate reaches ready, unreviewed, and the person is told so
!(test (final-of (wrc (append (greenc) ((o 6 review-unavailable (c1)))))) (accepted (review-unavailable waived)))
!(test (next-action (wst (append (greenc) ((o 6 review-unavailable (c1))))) g_1 t) (tell confirm-unreviewed-to-apply c1))
!(test (phase-of (wst (append (greenc) ((o 6 review-unavailable (c1)) (o 7 approval-needed (op1)) (o 8 approved (op1 jon)) (o 9 applied (op1 c1 jon)))))) delivered)
; early (while edited): kept, and green goes straight to ready
!(test (phase-of (wst ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 review-unavailable (c1))))) edited)
!(test (phase-of (wst ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 review-unavailable (c1)) (o 6 tests-pass (c1 r1))))) ready)
; never while a review is in flight, never for another candidate, never outside the open phases, never once reviewed
!(test (final-of (wrc (append (greenc) ((o 6 dispatched (q1 review c1)) (o 7 review-unavailable (c1)))))) (rejected review-in-flight))
!(test (final-of (wrc (append (greenc) ((o 6 review-unavailable (c2)))))) (rejected review-not-due))
!(test (final-of (wrc (append (at-understood) ((o 3 review-unavailable (c1)))))) (rejected review-not-due))
!(test (final-of (wrc (append (to-ready) ((o 7 review-unavailable (c1)))))) (rejected review-not-due))
!(test (final-of (rc (append (to-ready) ((o 7 review-unavailable (c1)))))) (rejected review-not-due))
; an unreviewed candidate is still pulled back by a late failure, and a real review upgrades it
!(test (phase-of (wst (append (greenc) ((o 6 dispatched (r2 test c1)) (o 7 review-unavailable (c1)) (o 8 tests-fail (c1 r2)) (o 9 approval-needed (op1)) (o 10 approved (op1 jon)) (o 11 applied (op1 c1 jon)))))) red)
!(test (next-action (wst (append (greenc) ((o 6 review-unavailable (c1)) (o 7 dispatched (q1 review c1)) (o 8 review-pass (c1 reviewer q1))))) g_1 t) (tell confirm-to-apply c1))
!(test (phase-of (wst (append (greenc) ((o 6 review-unavailable (c1)) (o 7 dispatched (q1 review c1)) (o 8 review-fail (c1 reviewer q1)))))) understood)
; adversarial: an unreviewed state replayed into an apply under review-required is refused (the apply re-checks policy)
!(test (let ($s2 $v) (apply-obs (ctx) (wst (append (greenc) ((o 6 review-unavailable (c1)) (o 7 approval-needed (op1)) (o 8 approved (op1 jon))))) (o 9 applied (op1 c1 jon))) $v)
       (rejected apply-not-confirmed-for-this-candidate))
; root-suggest with a waivable policy: told unreviewed, then waits for the person's own apply
!(test (next-action-for root-suggest (wrst ((o 1 opened ()) (o 2 read ()) (o 3 candidate-retained (c1 () f1)) (o 4 dispatched (r1 test c1)) (o 5 tests-pass (c1 r1)) (o 6 review-unavailable (c1)))) g_1 t)
       (tell confirm-unreviewed-to-apply c1))
!(test (next-action-for root-suggest (wrst ((o 1 opened ()) (o 2 read ()) (o 3 candidate-retained (c1 () f1)) (o 4 dispatched (r1 test c1)) (o 5 tests-pass (c1 r1)) (o 6 review-unavailable (c1))
        (o 7 approval-needed (opP)) (o 8 approved (opP jon)))) g_1 t) (rest awaiting-person-apply))

; ---- (4) reconciled-current: a readback proving the candidate current re-retains it, no model call ----
(= (unk-run) ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 unknown (r1))))
!(test (ph (append (unk-run) ((o 6 reconciled-current (r1 c1))))) edited)
!(test (next-action (st (append (unk-run) ((o 6 reconciled-current (r1 c1))))) g_1 t) (do (code-exec t)))
!(test (next-action-for root-suggest (rst ((o 1 opened ()) (o 2 read ()) (o 3 candidate-retained (c1 () f1)) (o 4 dispatched (r1 test c1)) (o 5 unknown (r1)) (o 6 reconciled-current (r1 c1)))) g_1 t)
       (do (proposal-test c1 t)))
; a fresh generation: the old run id stays spent, a new run validates it
!(test (final-of (rc (append (unk-run) ((o 6 reconciled-current (r1 c1)) (o 7 dispatched (r1 test c1)))))) (rejected run-id-reused))
!(test (ph (append (unk-run) ((o 6 reconciled-current (r1 c1)) (o 7 dispatched (r2 test c1)) (o 8 tests-pass (c1 r2))))) green)
; the plain reconcile still forces a fresh read (R3.11.5 path kept)
!(test (next-action (st (append (unk-run) ((o 6 reconciled (r1))))) g_1 t) (think read-again-before-editing))
; a lost apply proven not applied: the candidate is re-validated before any new apply, the old approval id stays spent
(= (lost-ap) (append (apply-inflight) ((o x1 unknown (apply1)) (o x2 reconciled-current (apply1 c1)))))
!(test (ph (lost-ap)) edited)
!(test (final-of (rc (append (lost-ap) ((o x3 approval-needed (apply1)))))) (rejected approval-id-reused))
!(test (ph (append (lost-ap) ((o x3 approval-needed (apply2)) (o x4 approved (apply2 jon)) (o x5 applied (apply2 c1 jon))))) edited)
; never for a refuted candidate: a failure, kept across stale and across a plain reconcile
!(test (final-of (rc (append (red-k1) ((o 7 check-unknown (c1 (diag count.metta) k1)) (o 8 reconciled-current (k1 c1)))))) (rejected not-the-current-candidate))
!(test (final-of (rc ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 tests-fail (c1 r1)) (o 6 stale ())
        (o 7 unknown (x)) (o 8 reconciled-current (x c1))))) (rejected not-the-current-candidate))
!(test (final-of (rc ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 tests-fail (c1 r1)) (o 6 unknown (x)) (o 7 reconciled (x))
        (o 8 unknown (y)) (o 9 reconciled-current (y c1))))) (rejected not-the-current-candidate))
!(test (tested-of (st ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 tests-fail (c1 r1)) (o 6 stale ())))) (failed c1))
; never for another candidate, a non-unresolved op, on an unclean reconcile, under a hold, or with a proposal effect open
!(test (final-of (rc (append (unk-run) ((o 6 reconciled-current (r1 c2)))))) (rejected not-the-current-candidate))
!(test (final-of (rc (append (unk-run) ((o 6 reconciled-current (r9 c1)))))) (rejected not-an-unresolved-operation))
!(test (final-of (rc ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ((diag count.metta)))) (o 4 dispatched (r1 test c1)) (o 5 dispatched (k1 (diag count.metta) c1))
        (o 6 unknown (r1)) (o 7 reconciled-current (r1 c1))))) (rejected reconcile-not-clean))
!(test (final-of (rc (append (unk-run) ((o 6 unknown (op8)) (o 7 reconciled-current (r1 c1)))))) (rejected reconcile-not-clean))
!(test (final-of (rc (append (unk-run) ((o 6 check-unavailable (c1 (diag x.metta))) (o 7 reconciled-current (r1 c1)))))) (rejected hold-kept))
!(test (final-of (rc (append (unk-run) ((o 6 cancelled ()) (o 7 reconciled-current (r1 c1)))))) (rejected terminal))
!(test (final-of (rc ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 stale ()) (o 5 proposed (p1 read d1)) (o 6 proposal-selected (p1 read d1))
        (o 7 proposal-executing (p1 op1)) (o 8 unknown (x)) (o 9 reconciled-current (x c1))))) (rejected proposal-effect-unreported))
; it retires the op once; a running helper's attempt ends with the re-retained candidate
!(test (final-of (rc (append (unk-run) ((o 6 reconciled-current (r1 c1)) (o 7 reconciled (r1)))))) (rejected not-an-unresolved-operation))
; R3.13 adapted: x had no creation after the stale (an out-of-ledger op counts any stale), so a run dispatched after the read stands in
!(test (prop-of (st ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 stale ()) (o 5 read ()) (o 6 think-started (a1 h1)) (o 65 dispatched (rk test c1)) (o 7 unknown (rk)) (o 8 reconciled-current (rk c1))))) none)

; ---- (5) the author set: controller, every helper, never the person ----
(= (actx) (Ctx g_1 e1 jon (coder h1 h2) 3 delegated review-required))
(= (arc $log) (receipts (actx) (start-state) $log))
(= (aph $log) (phase-of (replay (actx) (start-state) $log)))
(= (rev-by $v) ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 tests-pass (c1 r1)) (o 6 dispatched (q1 review c1)) (o 7 review-pass (c1 $v q1))))
!(test (final-of (arc (rev-by h2))) (rejected review-not-independent-or-not-this-candidate))
!(test (final-of (arc (rev-by coder))) (rejected review-not-independent-or-not-this-candidate))
!(test (final-of (arc (rev-by jon))) (rejected review-not-independent-or-not-this-candidate))
!(test (aph (rev-by reviewer)) ready)
; a helper named by a think-started is excluded though the Ctx does not list it, even if that start was refused
!(test (final-of (rc ((o 1 opened ()) (o 2 read ()) (o t1 think-started (a1 h9)) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 tests-pass (c1 r1))
        (o 6 dispatched (q1 review c1)) (o 7 review-pass (c1 h9 q1))))) (rejected review-not-independent-or-not-this-candidate))
!(test (final-of (rc ((o 1 opened ()) (o t0 think-started (a0 h7)) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 tests-pass (c1 r1))
        (o 6 dispatched (q1 review c1)) (o 7 review-pass (c1 h7 q1))))) (rejected review-not-independent-or-not-this-candidate))
; a helper can't refute either
!(test (final-of (arc ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 tests-pass (c1 r1)) (o 6 dispatched (q1 review c1)) (o 7 review-fail (c1 h1 q1)))))
       (rejected review-not-independent-or-not-this-candidate))

; ---- (6) changes-requested: the person's own words ----
!(test (ph (append (to-ready) ((o 7 changes-requested (c1 jon))))) understood)
!(test (next-action (st (append (to-ready) ((o 7 changes-requested (c1 jon))))) g_1 t) (think make-the-smallest-change))
!(test (ph (append (greenc) ((o 6 changes-requested (c1 jon))))) understood)
!(test (rep-of (st (append (to-ready) ((o 7 changes-requested (c1 jon)))))) 0)
!(test (disp-of (st (append (to-ready) ((o 7 changes-requested (c1 jon)))))) ())
; only the person, only for the waiting candidate, only once it is tested and waiting
!(test (final-of (rc (append (to-ready) ((o 7 changes-requested (c1 eve)))))) (rejected not-the-persons-waiting-candidate))
!(test (final-of (rc (append (to-ready) ((o 7 changes-requested (c2 jon)))))) (rejected not-the-persons-waiting-candidate))
!(test (final-of (rc ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 changes-requested (c1 jon))))) (rejected not-the-persons-waiting-candidate))
!(test (final-of (rc (append (greenc) ((o 6 review-unavailable (c1)) (o 7 changes-requested (c1 jon)))))) (rejected not-the-persons-waiting-candidate))
!(test (final-of (rc (append (to-ready) ((o 7 approval-needed (op5)) (o 8 approved (op5 jon)) (o 9 applied (op5 c1 jon)) (o 10 changes-requested (c1 jon)))))) (rejected terminal))
; it refutes the candidate (no re-retain by readback) and a consent given before it becomes debt
!(test (tested-of (st (append (to-ready) ((o 7 changes-requested (c1 jon)))))) (failed c1))
!(test (next-action (st (append (to-ready) ((o 7 approval-needed (op5)) (o 8 approved (op5 jon)) (o 9 changes-requested (c1 jon))))) g_1 t) (do (reconcile op5)))
; the old host mapping (a forged review by the person) is now refused
!(test (final-of (rc (append (to-ready) ((o 7 dispatched (pr1 review c1)) (o 8 review-fail (c1 jon pr1)))))) (rejected review-not-independent-or-not-this-candidate))

; ---- (7) apply-refused: a definite no returns to ready ----
!(test (ph (append (apply-inflight) ((o c apply-refused (apply1))))) ready)
!(test (next-action (st (append (apply-inflight) ((o c apply-refused (apply1))))) g_1 t) (tell confirm-to-apply c1))
!(test (disp-of (st (append (apply-inflight) ((o c apply-refused (apply1)))))) ())
!(test (ph (append (apply-inflight) ((o c apply-refused (apply1)) (o d approval-needed (apply2)) (o e approved (apply2 jon)) (o f applied (apply2 c1 jon))))) delivered)
!(test (next-action-for root-suggest (rst (append (r-ready) ((o c apply-refused (opP))))) g_1 t) (tell confirm-to-apply c1))
; adversarial: the old id stays spent and can't then be applied; another op, no confirmation, twice, after a supersede, after delivery
!(test (final-of (rc (append (apply-inflight) ((o c apply-refused (apply1)) (o d approval-needed (apply1)))))) (rejected approval-id-reused))
!(test (final-of (rc (append (apply-inflight) ((o c apply-refused (apply1)) (o d applied (apply1 c1 jon)))))) (rejected apply-not-confirmed-for-this-candidate))
!(test (final-of (rc (append (apply-inflight) ((o c apply-refused (apply9)))))) (rejected not-the-confirmed-apply))
!(test (final-of (rc (append (to-ready) ((o c apply-refused (apply1)))))) (rejected not-the-confirmed-apply))
!(test (final-of (rc (append (apply-inflight) ((o c apply-refused (apply1)) (o d apply-refused (apply1)))))) (rejected not-the-confirmed-apply))
!(test (final-of (rc (append (apply-inflight) ((o c approval-needed (apply2)) (o d apply-refused (apply1)))))) (rejected not-the-confirmed-apply))
!(test (next-action (st (append (apply-inflight) ((o c approval-needed (apply2)) (o d apply-refused (apply1))))) g_1 t) (do (reconcile apply1)))
!(test (final-of (rc (append (apply-inflight) ((o c applied (apply1 c1 jon)) (o d apply-refused (apply1)))))) (rejected terminal))
; a generic refusal still blocks (R3.11.5 kept): only a refusal naming the confirmed apply returns to ready
!(test (ph (append (apply-inflight) ((o c refused ()) (o d reconciled (apply1))))) blocked)

; =====================================================================================================================
; ---- R3.13: the readback of an unknown confirmed apply (all R3.12 tests above carried unchanged) ----
(= (ap-unk) (append (apply-inflight) ((o u1 unknown (apply1)))))
!(test (ph (ap-unk)) reconcile)
!(test (next-action (st (ap-unk)) g_1 t) (do (reconcile apply1)))
; landed: the same consented apply delivers, no re-think, no new apply
!(test (final-of (rc (append (ap-unk) ((o u2 applied-confirmed (apply1 c1 rcpt1)))))) accepted)
!(test (ph (append (ap-unk) ((o u2 applied-confirmed (apply1 c1 rcpt1))))) delivered)
!(test (next-action (st (append (ap-unk) ((o u2 applied-confirmed (apply1 c1 rcpt1))))) g_1 t) (rest done))
!(test (disp-of (st (append (ap-unk) ((o u2 applied-confirmed (apply1 c1 rcpt1)))))) ())
!(test (next-action-for root-suggest (rst (append (r-ready) ((o u1 unknown (opP)) (o u2 applied-confirmed (opP c1 rcpt1))))) g_1 t) (rest done))
; not landed, candidate current: back to ready, consent cleared, no debt, no re-think; a new apply needs a new id
!(test (ph (append (ap-unk) ((o u2 reconciled-not-applied (apply1 c1))))) ready)
!(test (next-action (st (append (ap-unk) ((o u2 reconciled-not-applied (apply1 c1))))) g_1 t) (tell confirm-to-apply c1))
!(test (final-of (rc (append (ap-unk) ((o u2 reconciled-not-applied (apply1 c1)) (o u3 approval-needed (apply1)))))) (rejected approval-id-reused))
!(test (ph (append (ap-unk) ((o u2 reconciled-not-applied (apply1 c1)) (o u3 approval-needed (apply2)) (o u4 approved (apply2 jon)) (o u5 applied (apply2 c1 jon))))) delivered)
!(test (final-of (rc (append (ap-unk) ((o u2 reconciled-not-applied (apply1 c1)) (o u3 applied (apply1 c1 jon)))))) (rejected apply-not-confirmed-for-this-candidate))
; the R3.12 paths still work: plain reconciled re-reads, reconciled-current re-validates
!(test (ph (append (ap-unk) ((o u2 reconciled (apply1))))) needs-read)
!(test (ph (append (ap-unk) ((o u2 reconciled-current (apply1 c1))))) edited)
; negative: wrong op, wrong candidate, no receipt
!(test (final-of (rc (append (ap-unk) ((o u2 applied-confirmed (apply9 c1 rcpt1)))))) (rejected not-the-unknown-confirmed-apply))
!(test (final-of (rc (append (ap-unk) ((o u2 applied-confirmed (apply1 c2 rcpt1)))))) (rejected not-the-unknown-confirmed-apply))
!(test (final-of (rc (append (ap-unk) ((o u2 applied-confirmed (apply1 c1 none)))))) (rejected not-the-unknown-confirmed-apply))
!(test (final-of (rc (append (ap-unk) ((o u2 reconciled-not-applied (apply9 c1)))))) (rejected not-the-unknown-confirmed-apply))
!(test (final-of (rc (append (ap-unk) ((o u2 reconciled-not-applied (apply1 c2)))))) (rejected not-the-unknown-confirmed-apply))
; no prior unknown: in flight (still in the ledger), or drained to debt without an unknown on it
!(test (final-of (rc (append (apply-inflight) ((o u2 applied-confirmed (apply1 c1 rcpt1)))))) (rejected not-the-unknown-confirmed-apply))
!(test (final-of (rc (append (apply-inflight) ((o x1 dispatched (r9 test c1)) (o x2 unknown (r9)) (o x3 reconciled (r9)) (o u2 applied-confirmed (apply1 c1 rcpt1))))))
       (rejected not-the-unknown-confirmed-apply))
!(test (final-of (rc (append (apply-inflight) ((o x1 dispatched (r9 test c1)) (o x2 unknown (r9)) (o x3 reconciled (r9)) (o u2 reconciled-not-applied (apply1 c1))))))
       (rejected not-the-unknown-confirmed-apply))
; a repeat: same id is a no-op duplicate; another id after delivery or after not-landed is refused
!(test (final-of (rc (append (ap-unk) ((o u2 applied-confirmed (apply1 c1 rcpt1)) (o u2 applied-confirmed (apply1 c1 rcpt1)))))) duplicate)
!(test (ph (append (ap-unk) ((o u2 applied-confirmed (apply1 c1 rcpt1)) (o u2 applied-confirmed (apply1 c1 rcpt1))))) delivered)
!(test (final-of (rc (append (ap-unk) ((o u2 applied-confirmed (apply1 c1 rcpt1)) (o u2 applied-confirmed (apply1 c1 rcpt2)))))) (rejected conflicting-duplicate))
!(test (final-of (rc (append (ap-unk) ((o u2 applied-confirmed (apply1 c1 rcpt1)) (o u3 applied-confirmed (apply1 c1 rcpt2)))))) (rejected terminal))
!(test (final-of (rc (append (ap-unk) ((o u2 reconciled-not-applied (apply1 c1)) (o u3 applied-confirmed (apply1 c1 rcpt1)))))) (rejected not-the-unknown-confirmed-apply))
!(test (final-of (rc (append (ap-unk) ((o u2 applied-confirmed (apply1 c1 rcpt1)) (o u3 reconciled-not-applied (apply1 c1)))))) (rejected terminal))
; after a stop: refused as terminal; the stop already cleared the confirmation, so the plain readback settles it
!(test (final-of (rc (append (ap-unk) ((o u2 cancelled ()) (o u3 applied-confirmed (apply1 c1 rcpt1)))))) (rejected terminal))
!(test (ph (append (ap-unk) ((o u2 cancelled ()) (o u3 reconciled (apply1))))) stopped)
; adversarial: other debt, a run dispatched after the unknown, a cleared or superseded confirmation, a forged unknown before ready
!(test (final-of (rc (append (ap-unk) ((o u2 unknown (opX)) (o u3 applied-confirmed (apply1 c1 rcpt1)))))) (rejected not-the-unknown-confirmed-apply))
!(test (final-of (rc (append (ap-unk) ((o u2 dispatched (r9 test c1)) (o u3 applied-confirmed (apply1 c1 rcpt1)))))) (rejected not-the-unknown-confirmed-apply))
!(test (final-of (rc (append (ap-unk) ((o u2 dispatched (r9 test c1)) (o u3 reconciled-not-applied (apply1 c1)))))) (rejected not-the-unknown-confirmed-apply))
!(test (final-of (rc (append (ap-unk) ((o u2 approval-needed (apply2)) (o u3 applied-confirmed (apply1 c1 rcpt1)))))) (rejected not-the-unknown-confirmed-apply))
; a stale after the unknown (the apply itself is a likely cause) does not stop a proven landing, but does stop not-landed
!(test (ph (append (ap-unk) ((o u2 stale ()) (o u3 applied-confirmed (apply1 c1 rcpt1))))) delivered)
!(test (final-of (rc (append (ap-unk) ((o u2 stale ()) (o u3 reconciled-not-applied (apply1 c1)))))) (rejected not-the-unknown-confirmed-apply))
!(test (final-of (rc (append (ap-unk) ((o u2 stale ()) (o u3 reconciled-current (apply1 c1)))))) (rejected origin-stale-since))
; R3.12 gap closed: a run drained by stale (needs-read) can't be re-retained by readback, skipping the read
!(test (final-of (rc ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 stale ()) (o 6 reconciled-current (r1 c1))))) (rejected origin-stale-since))
!(test (ph ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (r1 test c1)) (o 5 stale ()) (o 6 reconciled (r1)))) needs-read)
; a stale before the op's creation does not count
!(test (ph ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 stale ()) (o 5 read ()) (o 6 changed (c2 ())) (o 7 dispatched (r2 test c2)) (o 8 unknown (r2)) (o 9 reconciled-current (r2 c2)))) edited)
!(test (final-of (rc (append (greenc) ((o g1 approval-needed (opG)) (o g2 approved (opG jon)) (o g3 unknown (opG)) (o g4 applied-confirmed (opG c1 rcpt1))))))
       (rejected not-the-unknown-confirmed-apply))
!(test (final-of (rc (append (greenc) ((o g1 approval-needed (opG)) (o g2 approved (opG jon)) (o g3 unknown (opG)) (o g4 reconciled-not-applied (opG c1))))))
       (rejected not-the-unknown-confirmed-apply))
; policy: an unreviewed apply confirmed under review-waivable delivers; the same journal under review-required is refused
(= (w-unk) (append (greenc) ((o 6 review-unavailable (c1)) (o 7 approval-needed (op1)) (o 8 approved (op1 jon)) (o 9 unknown (op1)))))
!(test (phase-of (wst (append (w-unk) ((o 10 applied-confirmed (op1 c1 rcpt1)))))) delivered)
!(test (let ($s2 $v) (apply-obs (ctx) (wst (w-unk)) (o 10 applied-confirmed (op1 c1 rcpt1))) $v) (rejected not-the-unknown-confirmed-apply))
; the old producer is unchanged: `applied` in the reconcile phase is still refused
!(test (final-of (rc (append (ap-unk) ((o u2 applied (apply1 c1 jon)))))) (rejected apply-not-confirmed-for-this-candidate))
; adversarial: reviewed but never tested (an early review in edited), consent and a forged unknown: neither readback delivers or readies
(= (untested-unk) ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ())) (o 4 dispatched (q1 review c1)) (o 5 review-pass (c1 reviewer q1))
                   (o 6 approval-needed (opU)) (o 7 approved (opU jon)) (o 8 unknown (opU))))
!(test (final-of (rc (append (untested-unk) ((o 9 applied-confirmed (opU c1 rcpt1)))))) (rejected not-the-unknown-confirmed-apply))
!(test (final-of (rc (append (untested-unk) ((o 9 reconciled-not-applied (opU c1)))))) (rejected not-the-unknown-confirmed-apply))

; =====================================================================================================================
; ---- R3.14: the plan-member profile (all 353 R3.13 tests above carried unchanged) ----
(= (pctx) (Ctx g_1 b1 jon (coder) 3 plan-member plan-reviewed))     ; epoch = the member's plan budget, not a lease
(= (qctx) (Ctx g_1 b1 jon (coder) 3 plan-member review-required))   ; the plan's ReviewFor asks for a per-piece review
(= (ob $id $kind $f) (O $id $kind g_1 b1 $f))
(= (pst $log) (replay (pctx) (start-state) $log))
(= (prc $log) (receipts (pctx) (start-state) $log))
(= (pph $log) (phase-of (pst $log)))
(= (qst $log) (replay (qctx) (start-state) $log))
(= (qrc $log) (receipts (qctx) (start-state) $log))
(= (pna $log) (next-action-for plan-member (pst $log) g_1 t))
(= (p-ready) ((ob 1 opened ()) (ob 2 read ()) (ob 3 changed (c1 ())) (ob 4 dispatched (r1 test c1)) (ob 5 tests-pass (c1 r1))))
(= (q-ready) (append (p-ready) ((ob 6 dispatched (q1 review c1)) (ob 7 review-pass (c1 reviewer q1)))))

; the path: open the piece fork, read by host, edit, test, declare ready to the plan, integrated delivers
!(test (next-action-for plan-member (start-state) g_1 t) (do (piece-open g_1)))
!(test (pna ((ob 1 opened ()))) (do (host-read find-the-relevant-code)))
!(test (needs-model (pna ((ob 1 opened ())))) False)
!(test (pna ((ob 1 opened ()) (ob 2 read ()))) (think make-the-smallest-change))
!(test (pna ((ob 1 opened ()) (ob 2 read ()) (ob 3 changed (c1 ())))) (do (code-exec t)))
!(test (pph (p-ready)) ready)
!(test (pna (p-ready)) (tell member-ready c1))
!(test (pph (append (p-ready) ((ob 8 integrated (i1 c1 k1))))) delivered)
!(test (pna (append (p-ready) ((ob 8 integrated (i1 c1 k1))))) (rest done))
; review-required (per-piece ReviewFor): green asks for the review; member-ready only after it
!(test (phase-of (qst (p-ready))) green)
!(test (next-action-for plan-member (qst (p-ready)) g_1 t) (do (review-request c1)))
!(test (next-action-for plan-member (qst (q-ready)) g_1 t) (tell member-ready c1))
!(test (phase-of (qst (append (q-ready) ((ob 8 integrated (i1 c1 k1)))))) delivered)
!(test (final-of (qrc (append (p-ready) ((ob 8 integrated (i1 c1 k1)))))) (rejected not-the-member-ready-candidate))
!(test (final-of (qrc (append (p-ready) ((ob 6 review-unavailable (c1)))))) (accepted (review-unavailable blocked)))
!(test (final-of (prc (append (p-ready) ((ob 6 review-unavailable (c1)))))) (rejected review-not-due))
; the budget is the authority token: an observation carrying the lease epoch instead is refused
!(test (final-of (prc ((ob 1 opened ()) (o 2 read ())))) (rejected wrong-task))

; integrated without member-ready, or for anything but the ready candidate with nothing outstanding
!(test (final-of (prc ((ob 1 opened ()) (ob 2 read ()) (ob 3 changed (c1 ())) (ob 4 integrated (i1 c1 k1))))) (rejected not-the-member-ready-candidate))
!(test (final-of (prc ((ob 1 opened ()) (ob 2 read ()) (ob 3 changed (c1 ())) (ob 4 dispatched (r1 test c1)) (ob 5 integrated (i1 c1 k1))))) (rejected not-the-member-ready-candidate))
!(test (final-of (prc (append (p-ready) ((ob 8 integrated (i1 c2 k1)))))) (rejected not-the-member-ready-candidate))
!(test (final-of (prc (append (p-ready) ((ob 8 integrated (i1 c1 none)))))) (rejected not-the-member-ready-candidate))
!(test (final-of (prc (append (p-ready) ((ob 7 dispatched (r2 test c1)) (ob 8 integrated (i1 c1 k1)))))) (rejected not-the-member-ready-candidate))
!(test (final-of (prc (append (p-ready) ((ob 7 unknown (x9)) (ob 8 integrated (i1 c1 k1)))))) (rejected not-the-member-ready-candidate))
!(test (final-of (prc (append (p-ready) ((ob 8 integrated (r1 c1 k1)))))) (rejected operation-id-reused))
; a late integrated: after a refix, after a stop, a second one, or for the candidate a refix superseded
(= (refixed) (append (p-ready) ((ob 8 member-refix (m1 c1 fail1)))))
!(test (final-of (prc (append (refixed) ((ob 9 integrated (i1 c1 k1)))))) (rejected not-the-member-ready-candidate))
!(test (final-of (prc (append (p-ready) ((ob 8 cancelled ()) (ob 9 integrated (i1 c1 k1)))))) (rejected terminal))
!(test (final-of (prc (append (p-ready) ((ob 8 integrated (i1 c1 k1)) (ob 9 integrated (i2 c1 k2)))))) (rejected terminal))
!(test (final-of (prc (append (p-ready) ((ob 8 integrated (i1 c1 k1)) (ob 8 integrated (i1 c1 k1)))))) duplicate)
(= (re-ready) (append (refixed) ((ob 10 changed (c2 ())) (ob 11 dispatched (r2 test c2)) (ob 12 tests-pass (c2 r2)))))
!(test (pna (re-ready)) (tell member-ready c2))
!(test (final-of (prc (append (re-ready) ((ob 13 integrated (i1 c1 k1)))))) (rejected not-the-member-ready-candidate))
!(test (pph (append (re-ready) ((ob 13 integrated (i2 c2 k2))))) delivered)
!(test (final-of (prc (append (re-ready) ((ob 13 integrated (m1 c2 k2)))))) (rejected operation-id-reused))

; member-refix: one repair, red, the candidate refuted, the failing output drives the repair
!(test (pph (refixed)) red)
!(test (rep-of (pst (refixed))) 1)
!(test (tested-of (pst (refixed))) (failed c1))
!(test (pna (refixed)) (think repair-from-the-failing-output))
(= (mr $n $c) ((ob (+ 100 $n) changed ($c ())) (ob (+ 200 $n) dispatched ((+ 300 $n) test $c)) (ob (+ 400 $n) tests-pass ($c (+ 300 $n))) (ob (+ 500 $n) member-refix ((+ 600 $n) $c f))))
!(test (pph (append (refixed) (append (mr 2 c2) (mr 3 c3)))) red)
!(test (pph (append (refixed) (append (mr 2 c2) (append (mr 3 c3) (mr 4 c4))))) blocked)
; member-refix with a stale candidate, outside ready, without a failing reference, reused, after delivery
!(test (final-of (prc (append (re-ready) ((ob 13 member-refix (m2 c1 fail2)))))) (rejected not-the-member-ready-candidate))
!(test (final-of (prc ((ob 1 opened ()) (ob 2 read ()) (ob 3 changed (c1 ())) (ob 4 member-refix (m1 c1 fail1))))) (rejected not-the-member-ready-candidate))
!(test (final-of (prc (append (p-ready) ((ob 8 member-refix (m1 c1 none)))))) (rejected not-the-member-ready-candidate))
!(test (final-of (prc (append (re-ready) ((ob 13 member-refix (m1 c2 fail2)))))) (rejected operation-id-reused))
!(test (final-of (prc (append (p-ready) ((ob 8 integrated (i1 c1 k1)) (ob 9 member-refix (m1 c1 fail1)))))) (rejected terminal))
; a refuted candidate can't be re-retained by readback
!(test (final-of (prc (append (refixed) ((ob 9 unknown (x1)) (ob 10 reconciled-current (x1 c1)))))) (rejected not-the-current-candidate))

; the host contract: edits stay in the piece. Reading is the host's; an out-of-piece proposal is refused before it runs
!(test (final-of (prc ((ob 1 opened ()) (ob 2 proposed (p1 read d1))))) (rejected proposal-not-admissible))
!(test (final-of (prc ((ob 1 opened ()) (ob 2 read ()) (ob 3 proposed (p1 suggest d1))))) (rejected proposal-not-admissible))
!(test (final-of (prc ((ob 1 opened ()) (ob 2 read ()) (ob 3 proposed (p1 edit d1))))) accepted)
(= (p-prop) ((ob 1 opened ()) (ob 2 read ()) (ob 3 proposed (p1 edit d1))))
!(test (prop-of (pst (append (p-prop) ((ob 4 scope-refused (p1)))))) none)
!(test (rep-of (pst (append (p-prop) ((ob 4 scope-refused (p1)))))) 1)
!(test (pna (append (p-prop) ((ob 4 scope-refused (p1))))) (think make-the-smallest-change))
!(test (rep-of (pst (append (p-prop) ((ob 4 proposal-selected (p1 edit d1)) (ob 5 scope-refused (p1)))))) 1)
(= (sr $n) ((ob (+ 10 $n) proposed ((+ 20 $n) edit d)) (ob (+ 30 $n) scope-refused ((+ 20 $n)))))
!(test (pph (append ((ob 1 opened ()) (ob 2 read ())) (append (sr 1) (append (sr 2) (append (sr 3) (sr 4)))))) blocked)
; too late once executing (the effect may have happened), and never for another proposal or twice
!(test (final-of (prc (append (p-prop) ((ob 4 proposal-selected (p1 edit d1)) (ob 5 proposal-executing (p1 op1)) (ob 6 scope-refused (p1)))))) (rejected not-an-unexecuted-proposal))
!(test (final-of (prc (append (p-prop) ((ob 4 scope-refused (p2)))))) (rejected not-an-unexecuted-proposal))
!(test (final-of (prc (append (p-prop) ((ob 4 scope-refused (p1)) (ob 5 scope-refused (p1)))))) (rejected not-an-unexecuted-proposal))
; root-suggest has no edit at all; the origin edit stays refused there
!(test (final-of (rrc ((o 1 opened ()) (o 2 read ()) (o 3 changed (c1 ()))))) (rejected origin-edit-not-in-profile))

; the profile gate: person-facing kinds are not a member's; plan kinds exist only for members
!(test (final-of (prc (append (p-ready) ((ob 8 approval-needed (a1)))))) (rejected not-in-plan-member-profile))
!(test (final-of (prc (append (p-ready) ((ob 8 approved (a1 jon)))))) (rejected not-in-plan-member-profile))
!(test (final-of (prc (append (p-ready) ((ob 8 applied (a1 c1 jon)))))) (rejected not-in-plan-member-profile))
!(test (final-of (prc (append (p-ready) ((ob 8 changes-requested (c1 jon)))))) (rejected not-in-plan-member-profile))
!(test (final-of (prc (append (p-ready) ((ob 8 apply-refused (a1)))))) (rejected not-in-plan-member-profile))
!(test (final-of (prc (append (p-ready) ((ob 8 applied-confirmed (a1 c1 k1)))))) (rejected not-in-plan-member-profile))
!(test (final-of (prc ((ob 1 opened ()) (ob 2 read ()) (ob 3 candidate-retained (c1 () f1))))) (rejected candidate-retained-not-in-profile))
!(test (pph (append (p-ready) ((ob 8 approval-needed (a1)) (ob 9 approved (a1 jon)) (ob 10 applied (a1 c1 jon))))) ready)
!(test (final-of (rc (append (to-ready) ((o 7 integrated (i1 c1 k1)))))) (rejected plan-member-only))
!(test (final-of (rrc (append (r-ready) ((o x7 integrated (i1 c1 k1)))))) (rejected plan-member-only))
!(test (final-of (rrc (append (r-ready) ((o x7 member-refix (m1 c1 f1)))))) (rejected plan-member-only))
!(test (final-of (rc (append (at-understood) ((o 3 proposed (p1 edit d1)) (o 4 scope-refused (p1)))))) (rejected plan-member-only))
!(test (ph (append (to-ready) ((o 7 integrated (i1 c1 k1)) (o 8 approval-needed (op5)) (o 9 approved (op5 jon)) (o 10 applied (op5 c1 jon))))) delivered)
; policy pairing: plan-reviewed only for members, members only plan-reviewed or review-required
!(test (final-of (receipts (Ctx g_1 b1 jon (coder) 3 plan-member review-waivable) (start-state) ((ob 1 opened ())))) (rejected profile-policy-mismatch))
!(test (final-of (receipts (Ctx g_1 e1 jon (coder) 3 root-suggest plan-reviewed) (start-state) ((o 1 opened ())))) (rejected profile-policy-mismatch))
!(test (final-of (receipts (Ctx g_1 e1 jon (coder) 3 delegated plan-reviewed) (start-state) ((o 1 opened ())))) (rejected profile-policy-mismatch))
; the helper path works for members too, and the author set still excludes helpers from per-piece review
!(test (pna ((ob 1 opened ()) (ob 2 read ()) (ob t1 think-started (a1 h1)))) (rest awaiting-helper))
!(test (rep-of (pst ((ob 1 opened ()) (ob 2 read ()) (ob t1 think-started (a1 h1)) (ob t2 think-failed (a1))))) 1)
!(test (final-of (qrc ((ob 1 opened ()) (ob 2 read ()) (ob t1 think-started (a1 h1)) (ob 3 changed (c1 ())) (ob 4 dispatched (r1 test c1)) (ob 5 tests-pass (c1 r1))
        (ob 6 dispatched (q1 review c1)) (ob 7 review-pass (c1 h1 q1))))) (rejected review-not-independent-or-not-this-candidate))
; adversarial: a hold is never released by integration (a blocked candidate still tested), and a ready state reached under
; plan-reviewed is not integrated if the review policy is then read as review-required (the integration re-checks review)
!(test (final-of (prc (append (p-ready) ((ob 8 check-unavailable (c1 (diag x.metta))) (ob 9 integrated (i1 c1 k1)))))) (rejected not-the-member-ready-candidate))
!(test (let ($s2 $v) (apply-obs (qctx) (pst (p-ready)) (ob 8 integrated (i1 c1 k1))) $v) (rejected not-the-member-ready-candidate))
