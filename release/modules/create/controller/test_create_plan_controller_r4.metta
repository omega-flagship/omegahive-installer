!(import! &self create_plan_controller_r4)

; Ctx: plan pl1, epoch e1, person jon, authors (dot planner), caps (2 repairs per piece, 2 fix rounds), lease 2
(= (ctx) (Ctx pl1 e1 jon (dot planner) (Caps 2 2) 2 review-required))
(= (o $id $kind $f) (O $id $kind pl1 e1 $f))
(= (st $log) (replay (ctx) (start-state) $log))
(= (ph $log) (phase-of (st $log)))
(= (rc $log) (receipts (ctx) (start-state) $log))
(= (na $log) (next-action (ctx) (st $log)))
(= (final-of $xs) (if (== (cdr-atom $xs) ()) (car-atom $xs) (final-of (cdr-atom $xs))))
(= (last-rc $log) (final-of (rc $log)))
(= (pstat $p $log) (status-of $p (st $log)))
; other contexts
(= (ctx-w) (Ctx pl1 e1 jon (dot planner) (Caps 2 2) 2 review-waivable))
(= (ctx-l1) (Ctx pl1 e1 jon (dot planner) (Caps 2 2) 1 review-required))
(= (ctx-c1) (Ctx pl1 e1 jon (dot planner) (Caps 1 1) 2 review-required))

; Slice-1 demo: "make me a small web page that shows X". Studio: index.html, style.css. Code: app.js (its wiring waits
; on Studio's layout because the plan says so). The acceptance test is authored before any piece starts.
(= (web) ((Piece page studio () (index.html)) (Piece style studio () (style.css)) (Piece app code (page) (app.js))))
(= (plan1) (Plan ref1 1 sha256:a1 none))
(= (planned-log $unk) ((o 1 plan-started (op1)) (o 2 planned (op1 (plan1) (web) $unk (no-design author)))))
(= (tests-log) ((o 3 dispatched (op2 author-tests ref1)) (o 4 tests-authored (op2 suite1))))
(= (red-log) ((o 5 dispatched (r0 run-checks base)) (o 6 check-fail (r0 base (app.test.js)))))
(= (to-red) (append (planned-log ()) (append (tests-log) (red-log))))
(= (studio-log) ((o 7 piece-started (page t1 studio-a)) (o 8 piece-started (style t2 studio-b))
                 (o 9 piece-ready (page c1)) (o 10 piece-ready (style c2))
                 (o 11 dispatched (v1 design-review (page c1))) (o 12 design-review-pass (page c1 rev1 shot1))
                 (o 13 dispatched (v2 design-review (style c2))) (o 14 design-review-pass (style c2 rev1 shot2))
                 (o 15 dispatched (i1 integrate (page c1))) (o 16 integrated (i1 page c1 k1))
                 (o 17 dispatched (i2 integrate (style c2))) (o 18 integrated (i2 style c2 k2))))
(= (code-log) ((o 19 piece-started (app t3 coder-a)) (o 20 piece-ready (app c3))
               (o 21 dispatched (v3 review (app c3))) (o 22 review-pass (app c3 rev1))
               (o 23 dispatched (i3 integrate (app c3))) (o 24 integrated (i3 app c3 k3))))
(= (to-checking) (append (to-red) (append (studio-log) (code-log))))
(= (to-ready) (append (to-checking) ((o 25 dispatched (r1 run-checks k3)) (o 26 check-pass (r1 k3))
                                     (o 27 dispatched (p1 preview k3)) (o 28 preview-deployed (p1 k3 url1)))))
(= (to-deployed) (append (to-ready) ((o 29 deploy-approved (d1 jon)) (o 30 deployed (d1)))))

; ==== the happy path, step by step ====
!(test (next-action (ctx) (start-state)) (think make-the-plan))
!(test (na ((o 1 plan-started (op1)))) (rest awaiting-planner))
!(test (ph (planned-log ())) planned)
!(test (na (planned-log ())) (think author-acceptance-tests))
!(test (ph (append (planned-log ()) (tests-log))) testing-authored)
!(test (na (append (planned-log ()) (tests-log))) (do (run-checks base)))
!(test (ph (to-red)) building)
!(test (na (to-red)) (do (start-piece page)))
!(test (na (append (to-red) ((o 7 piece-started (page t1 studio-a))))) (do (start-piece style)))
!(test (na (append (to-red) ((o 7 piece-started (page t1 studio-a)) (o 8 piece-started (style t2 studio-b))))) (rest awaiting-pieces))
!(test (na (append (to-red) ((o 7 piece-started (page t1 studio-a)) (o 8 piece-started (style t2 studio-b)) (o 9 piece-ready (page c1)))))
       (do (request-design-review page c1)))
!(test (na (append (to-red) (append (studio-log) ((o 19 piece-started (app t3 coder-a)) (o 20 piece-ready (app c3)))))) (do (request-review app c3)))
!(test (ph (append (to-red) (append (studio-log) ((o 19 piece-started (app t3 coder-a)) (o 20 piece-ready (app c3))
          (o 21 dispatched (v3 review (app c3))) (o 22 review-pass (app c3 rev1)))))) integrating)
!(test (ph (to-checking)) checking)
!(test (na (to-checking)) (do (run-checks k3)))
!(test (na (append (to-checking) ((o 25 dispatched (r1 run-checks k3)) (o 26 check-pass (r1 k3))))) (do (preview-deploy k3)))
!(test (ph (to-ready)) ready-to-deploy)
!(test (na (to-ready)) (tell confirm-deploy pl1))
!(test (na (append (to-ready) ((o 29 deploy-approved (d1 jon))))) (do (deploy d1)))
!(test (ph (to-deployed)) deployed)
!(test (na (to-deployed)) (rest done))
!(test (needs-model (na (planned-log ()))) True)
!(test (needs-model (na (to-red))) False)

; ==== the plan graph: OmegaPlanner's validation, in MeTTa ====
(= (plan-with $g) ((o 1 plan-started (op1)) (o 2 planned (op1 (plan1) $g () (no-design author)))))
!(test (last-rc (plan-with ((Piece a code (b) (a.js)) (Piece b code (a) (b.js))))) (rejected dependency_cycle))
!(test (last-rc (plan-with ((Piece a code (zz) (a.js))))) (rejected unknown_dependency))
!(test (last-rc (plan-with ((Piece a code () (a.js)) (Piece a studio () (b.css))))) (rejected duplicate_step))
!(test (last-rc (plan-with ((Piece a code () (a.js)) (Piece b studio () (a.js))))) (rejected file_owned_twice))
!(test (last-rc (plan-with ((Piece a marketing () (a.js))))) (rejected invalid_step))
!(test (last-rc (plan-with ())) (rejected step_count_limit))
!(test (last-rc ((o 1 plan-started (op1)) (o 2 planned (op1 (Plan ref1 2 sha256:a1 sha256:z) (web) () (no-design author))))) (rejected stale_revision))
; a rejected plan leaves the planner's op open; plan-failed retires it and returns to claimed
!(test (ph (append (plan-with ()) ((o 3 plan-failed (op1))))) claimed)
!(test (na (append (plan-with ()) ((o 3 plan-failed (op1))))) (think make-the-plan))

; ==== design: optional for a code-only plan; studio pieces carry it otherwise ====
(= (code-only $need) ((o 1 plan-started (op1)) (o 2 planned (op1 (plan1) ((Piece app code () (app.js))) () ($need author)))))
!(test (last-rc ((o 1 plan-started (op1)) (o 2 planned (op1 (plan1) (web) () (design author))))) (rejected studio-pieces-carry-the-design))
!(test (na (code-only design)) (think make-the-design))
!(test (ph (append (code-only design) ((o 3 dispatched (dz design ref1))))) designing)
!(test (na (append (code-only design) ((o 3 dispatched (dz design ref1)) (o 4 designed (dz des1))))) (think author-acceptance-tests))
!(test (last-rc (append (code-only design) ((o 3 dispatched (op2 author-tests ref1))))) (rejected tests-not-due))
!(test (na (code-only no-design)) (think author-acceptance-tests))
!(test (last-rc (append (code-only no-design) ((o 3 dispatched (dz design ref1))))) (rejected design-not-due))
; detect mode
(= (detect-log) ((o 1 plan-started (op1)) (o 2 planned (op1 (plan1) (web) () (no-design detect)))))
!(test (na (detect-log)) (do (detect-tests)))
!(test (ph (append (detect-log) ((o 3 dispatched (op2 detect-tests none)) (o 4 tests-detected (op2 suite0))))) testing-authored)
!(test (last-rc (append (detect-log) ((o 3 dispatched (op2 detect-tests none)) (o 4 tests-authored (op2 suite0))))) (rejected not-the-open-test-request))

; ==== tests first: no piece before the suite, and the scaffold must be red ====
!(test (last-rc (append (planned-log ()) ((o 3 piece-started (page t1 studio-a))))) (rejected piece-not-startable))
!(test (last-rc (append (planned-log ()) (append (tests-log) ((o 5 piece-started (page t1 studio-a)))))) (rejected piece-not-startable))
(= (green-base) (append (planned-log ()) (append (tests-log) ((o 5 dispatched (r0 run-checks base)) (o 6 check-pass (r0 base))))))
!(test (ph (green-base)) blocked)
!(test (na (green-base)) (tell ask-person (blocked tests-not-red)))
; the person's answer sends the plan back to author the suite again
!(test (na (append (green-base) ((o 7 question-asked (qb blocked)) (o 8 answered (qb jon ans-b))))) (think author-acceptance-tests))

; ==== cross-team dependency ordering and parallelism under the lease ====
!(test (may-start (ctx) (st (to-red))) (page style))
!(test (last-rc (append (to-red) ((o 7 piece-started (app t3 coder-a))))) (rejected piece-not-startable))
; app (code) waits on page (studio) only because the plan says so: after page integrates, app may start
!(test (may-start (ctx) (st (append (to-red) (append (studio-log) ())))) (app))
!(test (may-start (ctx) (st (append (to-red) ((o 7 piece-started (page t1 studio-a)) (o 9 piece-ready (page c1))
          (o 11 dispatched (v1 design-review (page c1))) (o 12 design-review-pass (page c1 rev1 shot1))
          (o 15 dispatched (i1 integrate (page c1))) (o 16 integrated (i1 page c1 k1)))))) (style app))
; teams in parallel when the plan names no cross-team edge
(= (par-graph) ((Piece page studio () (index.html)) (Piece app code () (app.js)) (Piece docs code () (README.md))))
(= (par-red) ((o 1 plan-started (op1)) (o 2 planned (op1 (plan1) (par-graph) () (no-design author)))
              (o 3 dispatched (op2 author-tests ref1)) (o 4 tests-authored (op2 suite1))
              (o 5 dispatched (r0 run-checks base)) (o 6 check-fail (r0 base (app.js)))))
!(test (may-start (ctx) (st (par-red))) (page app))
!(test (rc (append (par-red) ((o 7 piece-started (page t1 studio-a)) (o 8 piece-started (app t2 coder-a)) (o 9 piece-started (docs t3 coder-b)))))
       (accepted accepted accepted accepted accepted accepted accepted accepted (rejected lease-full)))
!(test (active-count (st (append (par-red) ((o 7 piece-started (page t1 studio-a)) (o 8 piece-started (app t2 coder-a)) (o 9 piece-started (docs t3 coder-b)))))) 2)
; a finished piece frees its lease slot
!(test (last-rc (append (par-red) ((o 7 piece-started (page t1 studio-a)) (o 8 piece-started (app t2 coder-a)) (o 9 piece-ready (app c1)) (o 10 piece-started (docs t3 coder-b))))) accepted)
; lease 1: one at a time
!(test (final-of (receipts (ctx-l1) (start-state) (append (par-red) ((o 7 piece-started (page t1 studio-a)) (o 8 piece-started (app t2 coder-a)))))) (rejected lease-full))
!(test (may-start (ctx-l1) (start-state)) ())

; ==== questions block only dependent work ====
(= (q-log) (append (planned-log ((q1 (piece page)))) (append (tests-log) (red-log))))
!(test (na (planned-log ((q1 (piece page))))) (tell ask-person q1))
(= (q-asked) (append (planned-log ((q1 (piece page)))) (append ((o 30 question-asked (q1 (piece page)))) (append (tests-log) (red-log)))))
; work that does not depend on the question keeps going: tests, the red check, and style
!(test (ph (q-asked)) building)
!(test (may-start (ctx) (st (q-asked))) (style))
!(test (last-rc (append (q-asked) ((o 7 piece-started (page t1 studio-a))))) (rejected awaiting-answer))
!(test (na (append (q-asked) ((o 8 piece-started (style t2 studio-b)) (o 10 piece-ready (style c2))
          (o 13 dispatched (v2 design-review (style c2))) (o 14 design-review-pass (style c2 rev1 shot2))
          (o 17 dispatched (i2 integrate (style c2))) (o 18 integrated (i2 style c2 k2))))) (rest awaiting-answer))
; the answer releases page and, through it, app
!(test (may-start (ctx) (st (append (q-asked) ((o 31 answered (q1 jon ans1)))))) (page style))
!(test (last-rc (append (q-asked) ((o 31 answered (q1 eve ans1))))) (rejected not-the-person))
!(test (last-rc (append (q-asked) ((o 31 answered (q1 planner ans1))))) (rejected not-the-person))
!(test (last-rc (append (q-log) ((o 31 answered (q1 jon ans1))))) (rejected not-an-open-question))
; a question about the whole plan stops every new effect; results still land
!(test (last-rc (append (to-red) ((o 31 question-asked (q9 plan)) (o 7 piece-started (page t1 studio-a))))) (rejected awaiting-answer))
!(test (last-rc (append (to-red) ((o 7 piece-started (page t1 studio-a)) (o 31 question-asked (q9 plan)) (o 9 piece-ready (page c1))))) accepted)

; ==== red -> fix -> green; failures route to the owning piece ====
(= (fail-style) (append (to-checking) ((o 25 dispatched (r1 run-checks k3)) (o 26 check-fail (r1 k3 (style.css))))))
!(test (ph (fail-style)) fixing)
!(test (pstat style (fail-style)) fixing)
!(test (na (fail-style)) (do (route-fix style r1)))
(= (fixed) (append (fail-style) ((o 40 dispatched (f1 route-fix style)) (o 41 piece-ready (style c4))
            (o 42 dispatched (v4 design-review (style c4))) (o 43 design-review-pass (style c4 rev1 shot4))
            (o 44 dispatched (i4 integrate (style c4))) (o 45 integrated (i4 style c4 k4)))))
!(test (ph (fixed)) checking)
!(test (na (fixed)) (do (run-checks k4)))
!(test (ph (append (fixed) ((o 46 dispatched (r2 run-checks k4)) (o 47 check-pass (r2 k4))))) previewing)
; a fix must change the candidate
!(test (last-rc (append (fail-style) ((o 40 dispatched (f1 route-fix style)) (o 41 piece-ready (style c2))))) (rejected candidate-unchanged))
; a failing app.js routes to the code piece; two files route to both owners
!(test (pstat app (append (to-checking) ((o 25 dispatched (r1 run-checks k3)) (o 26 check-fail (r1 k3 (app.js)))))) fixing)
!(test (map-atom (sv (st (append (to-checking) ((o 25 dispatched (r1 run-checks k3)) (o 26 check-fail (r1 k3 (app.js index.html)))))) pieces) $r (index-atom $r 2))
       (fixing integrated fixing))
; an unowned file cannot be routed: the plan blocks and asks
!(test (sv (st (append (to-checking) ((o 25 dispatched (r1 run-checks k3)) (o 26 check-fail (r1 k3 (server.py)))))) why) (unrouted-failure (server.py)))
; design-review-fail routes the fix back to the studio piece
(= (dr-fail) (append (to-red) ((o 7 piece-started (page t1 studio-a)) (o 9 piece-ready (page c1))
            (o 11 dispatched (v1 design-review (page c1))) (o 12 design-review-fail (page c1 rev1 shot1)))))
!(test (pstat page (dr-fail)) fixing)
!(test (na (dr-fail)) (do (route-fix page v1)))
!(test (ph (append (dr-fail) ((o 13 dispatched (f1 route-fix page)) (o 14 piece-ready (page c5))))) building)
; review-fail on the code piece routes back to it
!(test (pstat app (append (to-red) (append (studio-log) ((o 19 piece-started (app t3 coder-a)) (o 20 piece-ready (app c3))
          (o 21 dispatched (v3 review (app c3))) (o 22 review-fail (app c3 rev1)))))) fixing)

; ==== review covers both teams, by its own kind, with independent reviewers ====
(= (page-built) (append (to-red) ((o 7 piece-started (page t1 studio-a)) (o 9 piece-ready (page c1)))))
!(test (last-rc (append (page-built) ((o 11 dispatched (v1 review (page c1)))))) (rejected review-not-due))
!(test (last-rc (append (page-built) ((o 11 dispatched (v1 design-review (page c1))) (o 12 review-pass (page c1 rev1))))) (rejected wrong-review-kind))
!(test (last-rc (append (page-built) ((o 11 dispatched (v1 design-review (page c1))) (o 12 design-review-pass (page c1 rev1 none))))) (rejected design-review-needs-render-evidence))
!(test (last-rc (append (page-built) ((o 12 design-review-pass (page c1 rev1 shot1))))) (rejected review-not-requested))
; exclusion across teams: a Code builder can't design-review Studio's piece, nor a Studio builder review Code's
!(test (last-rc (append (page-built) ((o 8 piece-started (style t2 coder-z)) (o 11 dispatched (v1 design-review (page c1))) (o 12 design-review-pass (page c1 coder-z shot1)))))
       (rejected reviewer-not-independent))
!(test (last-rc (append (to-red) (append (studio-log) ((o 19 piece-started (app t3 coder-a)) (o 20 piece-ready (app c3))
          (o 21 dispatched (v3 review (app c3))) (o 22 review-pass (app c3 studio-a))))))
       (rejected reviewer-not-independent))
!(test (last-rc (append (page-built) ((o 11 dispatched (v1 design-review (page c1))) (o 12 design-review-pass (page c1 planner shot1))))) (rejected reviewer-not-independent))
!(test (last-rc (append (page-built) ((o 11 dispatched (v1 design-review (page c1))) (o 12 design-review-pass (page c1 jon shot1))))) (rejected reviewer-not-independent))
; an unreviewed piece can't integrate
!(test (last-rc (append (page-built) ((o 11 dispatched (i1 integrate (page c1)))))) (rejected integrate-not-due))
; review-unavailable: blocks under review-required; waived under review-waivable, and the go is asked as unreviewed
(= (unavail) (append (page-built) ((o 11 dispatched (v1 design-review (page c1))) (o 12 review-unavailable (page c1)))))
!(test (ph (unavail)) blocked)
!(test (phase-of (replay (ctx-w) (start-state) (unavail))) building)
!(test (status-of page (replay (ctx-w) (start-state) (unavail))) reviewed)
(= (waived-ready) (append (to-red) ((o 7 piece-started (page t1 studio-a)) (o 8 piece-started (style t2 studio-b))
                 (o 9 piece-ready (page c1)) (o 10 piece-ready (style c2))
                 (o 11 dispatched (v1 design-review (page c1))) (o 12 review-unavailable (page c1))
                 (o 13 dispatched (v2 design-review (style c2))) (o 14 design-review-pass (style c2 rev1 shot2))
                 (o 15 dispatched (i1 integrate (page c1))) (o 16 integrated (i1 page c1 k1))
                 (o 17 dispatched (i2 integrate (style c2))) (o 18 integrated (i2 style c2 k2))
                 (o 19 piece-started (app t3 coder-a)) (o 20 piece-ready (app c3))
                 (o 21 dispatched (v3 review (app c3))) (o 22 review-pass (app c3 rev1))
                 (o 23 dispatched (i3 integrate (app c3))) (o 24 integrated (i3 app c3 k3))
                 (o 25 dispatched (r1 run-checks k3)) (o 26 check-pass (r1 k3))
                 (o 27 dispatched (p1 preview k3)) (o 28 preview-deployed (p1 k3 url1)))))
!(test (next-action (ctx-w) (replay (ctx-w) (start-state) (waived-ready))) (tell confirm-unreviewed-deploy pl1))

; ==== caps: past a cap the plan blocks and asks the person ====
(= (c1-st $log) (replay (ctx-c1) (start-state) $log))
(= (fail2) (append (to-checking) ((o 25 dispatched (r1 run-checks k3)) (o 26 check-fail (r1 k3 (style.css)))
            (o 40 dispatched (f1 route-fix style)) (o 41 piece-ready (style c4))
            (o 42 dispatched (v4 design-review (style c4))) (o 43 design-review-pass (style c4 rev1 shot4))
            (o 44 dispatched (i4 integrate (style c4))) (o 45 integrated (i4 style c4 k4))
            (o 46 dispatched (r2 run-checks k4)) (o 47 check-fail (r2 k4 (app.js))))))
!(test (phase-of (c1-st (fail2))) blocked)
!(test (sv (c1-st (fail2)) why) (cap-exceeded fix-rounds))
!(test (ph (fail2)) fixing)
!(test (next-action (ctx-c1) (c1-st (fail2))) (tell ask-person (blocked (cap-exceeded fix-rounds))))
; piece repairs: two design-review fails on page under Caps 1
(= (dr-fail2) (append (dr-fail) ((o 13 dispatched (f1 route-fix page)) (o 14 piece-ready (page c5))
               (o 15 dispatched (v5 design-review (page c5))) (o 16 design-review-fail (page c5 rev1 shot5)))))
!(test (sv (c1-st (dr-fail2)) why) (cap-exceeded piece-repairs))
!(test (ph (dr-fail2)) building)
; a hold: no new effect, uncertainty does not release it, a withdrawal does not release it, only the person's answer
!(test (final-of (receipts (ctx-c1) (start-state) (append (fail2) ((o 48 dispatched (f2 route-fix app)))))) (rejected hold-kept))
!(test (phase-of (c1-st (append (fail2) ((o 48 unknown (zz9)) (o 49 reconciled (zz9)))))) blocked)
!(test (final-of (receipts (ctx-c1) (start-state) (append (fail2) ((o 48 question-asked (qb blocked)) (o 49 question-withdrawn (qb)))))) (rejected hold-needs-the-persons-answer))
!(test (final-of (receipts (ctx-c1) (start-state) (append (fail2) ((o 48 question-asked (qb blocked)) (o 49 answered (qb eve ans)))))) (rejected not-the-person))
!(test (next-action (ctx-c1) (c1-st (append (fail2) ((o 48 question-asked (qb blocked)) (o 49 answered (qb jon ans)))))) (do (route-fix app r2)))
; piece-blocked (the piece's own R3.12 task blocked) blocks the plan
!(test (sv (st (append (to-red) ((o 7 piece-started (page t1 studio-a)) (o 8 piece-blocked (page))))) why) (piece-blocked page))

; ==== the deploy: only the person's go produces deployed ====
!(test (last-rc (append (to-ready) ((o 29 deployed (d1))))) (rejected deploy-not-approved-by-the-person))
!(test (last-rc (append (to-ready) ((o 29 deploy-approved (d1 eve))))) (rejected not-the-person))
!(test (last-rc (append (to-ready) ((o 29 deploy-approved (d1 planner))))) (rejected not-the-person))
!(test (last-rc (append (to-ready) ((o 29 deploy-approved (d1 jon)) (o 30 deployed (d9))))) (rejected deploy-not-approved-by-the-person))
!(test (last-rc (append (to-checking) ((o 29 deploy-approved (d1 jon))))) (rejected not-ready-to-deploy))
!(test (last-rc (append (to-ready) ((o 29 deploy-approved (r1 jon))))) (rejected operation-id-reused))
!(test (last-rc (append (to-ready) ((o 29 dispatched (d1 deploy k3))))) (rejected not-dispatchable))
; a refusal returns to ready and asks again
!(test (na (append (to-ready) ((o 29 deploy-approved (d1 jon)) (o 30 deploy-refused (d1))))) (tell confirm-deploy pl1))
; a deploy question holds the go; asked after the go, it withdraws consent and the deploy becomes debt to reconcile
!(test (last-rc (append (to-ready) ((o 29 question-asked (q7 deploy)) (o 30 deploy-approved (d1 jon))))) (rejected awaiting-answer))
!(test (na (append (to-ready) ((o 29 deploy-approved (d1 jon)) (o 30 question-asked (q7 deploy))))) (do (reconcile d1)))
!(test (last-rc (append (to-ready) ((o 29 deploy-approved (d1 jon)) (o 30 question-asked (q7 deploy)) (o 31 deployed (d1))))) (rejected deploy-not-approved-by-the-person))
; a deploy question does not stop the preview
!(test (na (append (to-checking) ((o 25 dispatched (r1 run-checks k3)) (o 26 check-pass (r1 k3)) (o 27 question-asked (q7 deploy))))) (do (preview-deploy k3)))

; ==== replay, idempotency, wrong / late / forged observations ====
!(test (== (st (append (to-deployed) (to-deployed))) (st (to-deployed))) True)
!(test (last-rc (append (to-red) ((o 6 check-fail (r0 base (app.test.js)))))) duplicate)
!(test (last-rc (append (to-red) ((o 6 check-pass (r0 base))))) (rejected conflicting-duplicate))
!(test (last-rc (append (to-red) ((O 7 piece-started pl2 e1 (page t1 studio-a))))) (rejected wrong-plan))
!(test (last-rc (append (to-red) ((O 7 piece-started pl1 e0 (page t1 studio-a))))) (rejected wrong-plan))
!(test (last-rc (append (to-red) ((o 7 piece-started (page t1))))) (rejected malformed-fields))
!(test (last-rc (append (to-red) ((o 7 teleport (page))))) (rejected unknown-kind))
!(test (last-rc (append (to-checking) ((o 25 check-pass (r1 k3))))) (rejected run-not-dispatched-for-this-checkpoint))
!(test (last-rc (append (to-checking) ((o 25 dispatched (r1 run-checks k2))))) (rejected checks-not-due))
!(test (last-rc (append (to-red) ((o 7 piece-ready (page c1))))) (rejected not-a-running-piece))
!(test (last-rc (append (to-red) ((o 7 piece-started (page t1 studio-a)) (o 8 piece-started (style t1 studio-b))))) (rejected operation-id-reused))
!(test (last-rc (append (to-red) ((o 7 dispatched (op2 run-checks base))))) (rejected operation-id-reused))
!(test (last-rc (append (to-red) ((o 7 piece-started (ghost t1 studio-a))))) (rejected piece-not-in-plan))
; a check result of unknown fate: reconcile first; the late result is then refused and a fresh run is proposed
(= (unk) (append (to-checking) ((o 25 dispatched (r1 run-checks k3)) (o 26 check-unknown (r1)))))
!(test (na (unk)) (do (reconcile r1)))
!(test (last-rc (append (unk) ((o 27 dispatched (r2 run-checks k3))))) (rejected unresolved-effect-first))
!(test (na (append (unk) ((o 27 reconciled (r1))))) (do (run-checks k3)))
!(test (last-rc (append (unk) ((o 27 reconciled (r1)) (o 28 check-pass (r1 k3))))) (rejected run-not-dispatched-for-this-checkpoint))
; a lost piece start: reconciled puts the piece back to waiting so it can start again under a fresh task id
!(test (pstat page (append (to-red) ((o 7 piece-started (page t1 studio-a)) (o 8 unknown (t1)) (o 9 reconciled (t1))))) waiting)
!(test (last-rc (append (to-red) ((o 7 piece-started (page t1 studio-a)) (o 8 unknown (t1)) (o 9 reconciled (t1)) (o 10 piece-ready (page c1))))) (rejected not-a-running-piece))
; merge conflicts send the piece back for a fix
!(test (pstat page (append (to-red) ((o 7 piece-started (page t1 studio-a)) (o 9 piece-ready (page c1))
          (o 11 dispatched (v1 design-review (page c1))) (o 12 design-review-pass (page c1 rev1 shot1))
          (o 15 dispatched (i1 integrate (page c1))) (o 16 merge-conflict (i1 page))))) fixing)
; terminal: stop keeps cleanup owed; deployed admits only loss reports and readbacks
!(test (na (append (to-red) ((o 7 piece-started (page t1 studio-a)) (o 8 cancelled ())))) (do (reconcile t1)))
!(test (ph (append (to-red) ((o 7 piece-started (page t1 studio-a)) (o 8 cancelled ()) (o 9 reconciled (t1))))) stopped)
!(test (last-rc (append (to-deployed) ((o 31 dispatched (r9 run-checks k3))))) (rejected terminal))
!(test (ph (append (to-deployed) ((o 31 unknown (x1))))) deployed)
