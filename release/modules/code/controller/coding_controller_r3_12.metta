; Coding controller R3.12 (Dot, peer of OmegaCode, at Jon's direction; R3.11.5 stays beside it unchanged).
;   One invariant: every host event has its own observation kind, so no real event is mapped onto a kind that means
;   something else; each new kind can only retire, refute or re-validate, never skip a step toward delivery, and every
;   R3.11.5 invariant holds (journal before effect, lifetime-unique operation ids, `applied` produced only by the person's
;   own apply, holds never released by uncertainty, readback never lost).
;   1. Under root-suggest, reading is a host effect: open/needs-read propose (do (host-read goal)), never a think, and the
;      only admissible model proposal is suggest (read/search proposals are refused under that profile).
;   2. think-started (attempt helper) is journalled before a helper model call (understood/red only; attempt ids are
;      lifetime-unique operation ids); while it is open the controller rests awaiting-helper. think-failed (attempt): the
;      helper ended without a proposal; it counts one repair (blocked past the cap) and leaves the phase otherwise unchanged.
;   3. review-unavailable (cand): no second opinion can run. Ctx carries the person's review policy: review-required
;      blocks exactly like check-unavailable (unavailability is never a pass); review-waivable marks the candidate
;      (unreviewed cand), which reaches ready and asks (tell confirm-unreviewed-to-apply cand); the apply re-checks policy.
;   4. reconciled-current (op cand): a readback that proves the held candidate still current retires op and re-retains
;      the candidate in a fresh validation generation (re-test, re-review) without a model call; only on a clean
;      reconcile, never for a refuted candidate (tested = (failed cand)), never under a hold.
;   5. Ctx author is a set; reviewers are excluded if in it, if named as a helper by any think-started, or the person.
;   6. changes-requested (cand person): the person's own words refute a waiting candidate (green/ready); no forged review.
;   7. apply-refused (op): a definite refusal of the confirmed apply retires its ledger entry with no debt and keeps the
;      phase (ready stays ready); anything uncertain is still unknown(op).
;   Ctx: (Ctx task epoch person authors max-repairs profile review-policy). State shape unchanged (14 fields);
;   prop gains (thinking attempt helper); tested may be (failed cand); reviewed may be (unreviewed cand).
; Was: Coding controller R3.11 (Kimi + stand-in R3.10, one invariant: an executing proposal's operation is outstanding until its own
;   proposal-done, or an explicit unknown -> reconciled readback that forces a fresh read. Drains never move it; they move runs only.
;   Reconciling one operation never retires another: open runs left at the end of a reconcile are drained to unresolved, not dropped.
;   Dispatch no longer exempts an unexecuted proposal from invalidation. A rejected execution drops the selection.
;   Stale/cancel under a hold still drain open runs, so their readback is never lost.
;   New candidate-retained observation for the root profile (F4 addendum 4): a retained suggestion starts a fresh validation
;   generation without claiming the origin changed; changed (an origin edit) is refused under that profile.
;   Scope note: the reducer enforces ordering (proposal-done before the result, one executing operation); that the host journals
;   proposal-executing before the effect is host-enforced, as for run dispatch: a rejected proposal-executing (or dispatched)
;   means the host must not perform the effect; a host that already did reports unknown(op).
;   R3.11.1 (Kimi R3.11 P2): under root-suggest, next-action-for turns test/check runs into proposal-test/proposal-check on the
;   retained candidate (the host binds candidate -> fork from its retention receipt) and never proposes apply: it waits for the
;   person's own apply, whose receipt is the only `applied` producer.)
; R3.11.2 (stand-in + Kimi R3.11.1): apply needs no unresolved debt; a stopped/delivered task still accepts a loss report for an
;   operation it holds (and stays terminal), but no new dispatch; dispatch can't forge the internal `proposal` kind; under
;   root-suggest an `edit` proposal is never admissible (the root acts by `suggest`, whose result re-enters as candidate-retained);
;   root opens read-only and requests reviews on the retained candidate; duplicate loss reports are refused. `unknown` may still
;   name host effects outside the run ledger (open, apply); that is intentional and they are reconciled the same way.
; R3.11.3 (stand-in + Kimi R3.11.2): any accepted transition that clears a confirmed apply (other than its own `applied`) turns
;   that apply into unresolved debt when it was armed (ready, nothing pending/outstanding/unresolved), since it may be in flight; a stopped task accepts a repeated loss report for debt it
;   holds; required-check lists can't name the reserved kinds test/review.
; R3.11.4 (stand-in + Kimi R3.11.3, same root cause): an apply's exposure is historical, not a snapshot, so the confirmed apply
;   is now an operation in the ledger like runs and proposals: `approved` journals (op apply cand); only its own `applied`
;   retires it; drains move it to unresolved; and if anything else clears the confirmation, the entry becomes unresolved debt.
;   This replaces R3.11.3's armed-snapshot rule. Reserved kinds (test review proposal apply none) can't be required checks,
;   check results or dispatches.
; R3.11.5 (stand-in R3.11.4; Kimi SHIP): operation ids are lifetime-unique across applies (approval ids), runs and proposal
;   executions in both orders; a stopped or delivered task admits any loss report (host effects outside the ledger, such as an
;   open, included) and stays terminal; after delivery such a report turns (rest done) into a readback, by the same
;   conservative rule as a cleared apply (Kimi R3.11.5). Note for hosts: a superseded or cleared apply always costs a readback and a full
;   re-validation before a new apply. R3.10 (Kimi + stand-in R3.8: an executing proposal is an outstanding operation in the ledger, so it blocks delivery, drains to unresolved and needs proposal-done; execution re-checks admissibility, holds and approvals; operation ids are lifetime-unique; any other accepted observation clears an unexecuted proposal; changed is refused while a proposal effect is unreported). R3.9 (OmegaCode's R3.8 pre-admission cases: green waits for an in-flight review; stale and cancel move open runs to unresolved so their readback/cleanup is never lost). R3.8 (proposal kinds in the reducer, per OmegaCode's contract: proposed / proposal-selected / proposal-executing; a model proposal is never evidence, is phase-admissible only, becomes exactly one operation, and is consumed or invalidated by real results). R3.7 (stand-in + Kimi R3.6: check results can't retire test/review requests; review passes complete in edited/green/ready; next-action waits for outstanding results; entering blocked drains open runs into unresolved). R3.6 (Kimi + stand-in R3.5: results are tracked to completion: each result retires its dispatched entry, green needs no open test/check, apply needs nothing outstanding; review failure counts in any open phase; refused/unavailable also clear confirmation). R3.5 (stand-in R3.4 fixes: a current-generation test/check/review failure counts in any open phase and invalidates readiness, review and confirmation, whatever order results arrive). R3.4 (stand-in R3.3 fixes: a newer approval supersedes an older confirmation and apply needs nothing pending; review needs a review request dispatched in this generation; approval ids are lifetime-unique; reviewer 'none' refused). R3.3 (stand-in R3.2 fixes: a blocked hold survives unknown/reconcile; a run id can be dispatched only once in the task's lifetime). R3.2 (stand-in R3.1 fixes: approval needs a real pending intent; every change, stale or reconcile starts a fresh validation generation so old runs can't count; check-fail only in edited). R3.1: Was: Coding controller R3: correction of R2 after OmegaCode's review
; (OmegaCode owner response to R2, 2026-10-29). R0 and R2 stay as references.
;
; New in R3, one per correction:
; 1. A candidate is a real reference, never the `none` sentinel; tests are always required, extra checks travel with it.
; 2. Every test/check result must name a run this controller journalled as dispatched, for this candidate and kind.
; 3. Pending approval and the confirmed approval are kept apart; apply must match the confirmed (op, candidate, person).
; 4. Unresolved effects are their own list, carried through stale/read/change/cancel; only reconciling that op clears it.
; 5. Dispatch is journalled BEFORE the effect (`dispatched` observation); a repeated id with a different body refuses.
; 6. Checks can fail, be unavailable or be unknown; each has its own outcome.
; The reducer stays pure and only proposes; the host dispatcher revalidates authority before any effect.
;
; Context: (Ctx task epoch person author max-repairs profile), profile: delegated | root-suggest (root-controller-suggest/1)
; State: (S phase repairs pending confirmed candidate tested reviewed required done unresolved dispatched $prop seen)
;   pending/confirmed: none | op / (op cand person);  tested/reviewed: none | cand
;   dispatched: list of (op kind cand);  seen: list of (id body)
; Observation: (O id kind task epoch fields)

(= (start-state) (S claimed 0 none none none none none () () () () none ()))

(= (all-in $xs $ys)
   (if (== $xs ()) True (if (is-member (car-atom $xs) $ys) (all-in (cdr-atom $xs) $ys) False)))
(= (without $x $xs) (filter-atom $xs $y (not (== $y $x))))
(= (body-of $id $seen)
   (if (== $seen ()) none
       (let ($i $b) (car-atom $seen) (if (== $i $id) $b (body-of $id (cdr-atom $seen))))))
; R3.3: how many dispatched observations in the log name this run id (lifetime-unique run identities)
(= (run-uses $run $seen)
   (if (== $seen ()) 0
       (let ($i $b) (car-atom $seen)
         (+ (case $b (((dispatched ($run $k $c)) 1) ($other 0))) (run-uses $run (cdr-atom $seen))))))
(= (approval-uses $op $seen)
   (if (== $seen ()) 0
       (let ($i $b) (car-atom $seen)
         (+ (case $b (((approval-needed ($op)) 1) ($other 0))) (approval-uses $op (cdr-atom $seen))))))
(= (no-open-checks $d)   ; R3.6: no outstanding test or check run (reviews and, R3.11.4, a confirmed apply may still be open)
   (if (== $d ()) True
       (let ($o $k $c) (car-atom $d) (if (or (== $k review) (== $k apply)) (no-open-checks (cdr-atom $d)) False))))
(= (check-kind? $k) (not (is-member $k (review test proposal apply none))))   ; R3.7: result-kind separation; R3.11.4 all reserved kinds (a list headed by `test` would parse as a call)
(= (open-entries $d) (map-atom $d $e (let ($o $k $c) $e $o)))   ; R3.7: open run ids, moved to unresolved on blocking
(= (prop-entry? $e) (let ($o $k $c) $e (== $k proposal)))   ; R3.11: a proposal operation's ledger entry
(= (run-entries $d) (filter-atom $d $e (not (prop-entry? $e))))
(= (prop-entries $d) (filter-atom $d $e (prop-entry? $e)))
(= (drain-unres $d $u) (append (open-entries (run-entries $d)) $u))   ; R3.11: drains move runs only; proposal entries stay in the ledger
(= (admissible-p? $profile $ph $a)   ; R3.11.2: the root profile never proposes an origin edit; it suggests instead
   (if (== $profile root-suggest)   ; R3.12 (1): and reading is the host's, so suggest is its only model proposal
       (if (== $a suggest) (admissible? $ph edit) False)
       (if (== $a suggest) False (admissible? $ph $a))))
(= (without-op $op $d) (filter-atom $d $e (let ($o $k $c) $e (not (== $o $op)))))   ; R3.11.2: a lost run leaves the ledger
(= (conf-of (S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp $prop $seen)) $conf)
(= (apply-entry $conf) ((index-atom $conf 0) apply (index-atom $conf 1)))   ; R3.11.4: the confirmed apply's ledger entry
(= (apply-entry? $e) (let ($o $k $c) $e (== $k apply)))
(= (conf-drain ($st $v))   ; R3.11.4: a confirmation cleared by anything but its own applied leaves its apply as unresolved debt
   (let (S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp $prop $seen) $st
     (if (not (== $conf none)) ($st $v)
         (let $aps (filter-atom $disp $e (apply-entry? $e))
           (if (== $aps ()) ($st $v)
               ((S $ph $rep $pend $conf $cand $tested $rev $req $done (append (open-entries $aps) $unres)
                   (filter-atom $disp $e (not (apply-entry? $e))) $prop $seen) $v))))))
(= (all-checks? $r) (if (== $r ()) True (if (check-kind? (car-atom $r)) (all-checks? (cdr-atom $r)) False)))
(= (edit-phase? $ph) (or (== $ph understood) (or (== $ph red) (or (== $ph edited) (or (== $ph green) (== $ph ready))))))
(= (unexecuted-dropped $prop) (if (== $prop none) none (if (or (== (car-atom $prop) executing) (== (car-atom $prop) thinking)) $prop none)))   ; R3.11; R3.12 a running helper is not a selection
; ---- R3.12 helpers --------------------------------------------------------------------------------------------
(= (thinking? $p) (if (== $p none) False (== (car-atom $p) thinking)))   ; (2) an open helper attempt
(= (refuted? $t) (case $t (((failed $x) True) ($o False))))   ; (4) a candidate a failure or the person refuted
(= (refute-keep $t) (if (refuted? $t) $t none))   ; a fresh read keeps the refutation of the held candidate
(= (rev-ok $rev $c) (or (== $rev $c) (== $rev (unreviewed $c))))   ; (3) reviewed, or unreviewed under a waivable policy
(= (rev-ok-for-apply $rev $c $policy) (or (== $rev $c) (and (== $policy review-waivable) (== $rev (unreviewed $c)))))
(= (think-phase? $ph) (or (== $ph understood) (== $ph red)))   ; (2) the phases whose think produces a candidate
(= (helper-named? $v $seen)   ; (5) any helper a think-started ever named (conservative: rejected starts count too)
   (if (== $seen ()) False
       (let ($i $b) (car-atom $seen)
         (if (case $b (((think-started ($a $v)) True) ($o False))) True (helper-named? $v (cdr-atom $seen))))))
(= (independent? $v $authors $person $seen)   ; (5) a second opinion: real, not an author or helper, not the person
   (and (not (== $v none)) (and (not (is-member $v $authors)) (and (not (== $v $person)) (not (helper-named? $v $seen))))))
; ---- R3.8: proposals ---------------------------------------------------------------------
; prop: none | (pending pid action digest) | (selected pid action digest) | (executing pid action digest op)
(= (admissible? $ph $a)
   (case $ph
     ((open       (or (== $a read) (== $a search)))
      (needs-read (== $a read))
      (understood (== $a edit))
      (red        (or (== $a edit) (or (== $a read) (== $a search))))
      ($other     False))))
(= (proposal-uses $pid $seen)
   (if (== $seen ()) 0
       (let ($i $b) (car-atom $seen)
         (+ (case $b (((proposed ($pid $a $d)) 1) ($other 0))) (proposal-uses $pid (cdr-atom $seen))))))
(= (proposal-kind? $kind) (is-member $kind (proposed proposal-selected proposal-executing proposal-done)))   ; R3.11: dispatch no longer exempt
(= (op-uses $op $seen)   ; R3.10: operation ids are lifetime-unique across proposal executions and dispatches
   (if (== $seen ()) 0
       (let ($i $b) (car-atom $seen)
         (+ (case $b (((proposal-executing ($pid $op)) 1) ((dispatched ($op $k $c)) 1) ((approval-needed ($op)) 1) ((think-started ($op $h)) 1) ($other 0))) (op-uses $op (cdr-atom $seen))))))   ; R3.11.5 approvals too; R3.12 helper attempts
(= (prop-op-open? $prop $disp)   ; is the executing proposal's operation still in the ledger?
   (if (== $prop none) False
       (if (== (car-atom $prop) executing) (is-member ((index-atom $prop 4) proposal (index-atom $prop 1)) $disp) False)))
(= (set-prop (S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp $old $seen) $new)
   (S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp $new $seen))
(= (prop-of (S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp $prop $seen)) $prop)
(= (disp-of (S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp $prop $seen)) $disp)
(= (consume-prop $kind ($st $v))   ; R3.10: any other accepted observation clears an unexecuted proposal;
   (if (or (proposal-kind? $kind) (== $v duplicate))   ; an executing one stays only while its operation is still in the ledger
       ($st $v)
       (case $v
         (((rejected $why) ($st $v))
          ($ok (if (or (prop-op-open? (prop-of $st) (disp-of $st)) (thinking? (prop-of $st))) ($st $v) ((set-prop $st none) $v)))))))   ; R3.12: a running helper is cleared only by its candidate or think-failed
(= (think-or-proposal $prop $goal)
   (case $prop
     ((none (think $goal))
      ((pending $pid $a $d) (do (select-proposal $pid)))
      ((selected $pid $a $d) (do (execute-proposal $pid $a $d)))
      ((executing $pid $a $d $op) (rest awaiting-results))
      ((thinking $att $h) (rest awaiting-helper)))))   ; R3.12 (2)
(= (read-or-proposal $prop $goal)   ; R3.12: a running helper never delays a read (open/needs-read)
   (if (thinking? $prop) (think $goal) (think-or-proposal $prop $goal)))
(= (begin-candidate $keep $ph $rep $unres $disp $prop $seen $c $r)   ; R3.2 fresh generation; R3.10 old runs keep their obligation
   (if (== $c none) ($keep (rejected candidate-is-not-a-reference))
   (if (not (all-checks? $r)) ($keep (rejected reserved-check-kind))   ; R3.11.3
   (if (not (== $unres ())) ($keep (rejected unresolved-effect-first))
   (if (prop-op-open? $prop $disp) ($keep (rejected proposal-effect-unreported))
   (if (edit-phase? $ph)
       ((S edited $rep none none $c none none $r () (drain-unres $disp $unres) (prop-entries $disp) (if (thinking? $prop) none $prop) $seen) accepted)   ; R3.12: the candidate ends the helper attempt
       ($keep (rejected edit-without-fresh-read))))))))
(= (in-flight? $k $d)   ; R3.8: is a run of this kind already dispatched and unresulted?
   (if (== $d ()) False
       (let ($o $kk $c) (car-atom $d) (if (== $kk $k) True (in-flight? $k (cdr-atom $d))))))
(= (first-missing-idle $xs $ys $d)   ; first required check neither done nor in flight
   (if (== $xs ()) none
       (let $x (car-atom $xs)
         (if (or (is-member $x $ys) (in-flight? $x $d)) (first-missing-idle (cdr-atom $xs) $ys $d) $x))))
(= (open-for-results? $ph) (or (== $ph edited) (or (== $ph green) (== $ph ready))))   ; R3.5
(= (terminal? $ph) (or (== $ph delivered) (== $ph stopped)))

(= (apply-obs (Ctx $task $epoch $person $author $max $profile $policy)
              (S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp $prop $seen)
              (O $id $kind $otask $oepoch $f))
   (let* (($keep (S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp $prop $seen))
          ($prior (body-of $id $seen)))
     (if (not (== $prior none))
         (if (== $prior ($kind $f)) ($keep duplicate) ($keep (rejected conflicting-duplicate)))
         (if (not (and (== $otask $task) (== $oepoch $epoch)))
             ($keep (rejected wrong-task))
             (let $seen2 (cons-atom ($id ($kind $f)) $seen)
               (if (and (terminal? $ph) (not (or (== $kind reconciled) (or (== $kind proposal-done) (== $kind unknown)))))   ; R3.11: an executing proposal may still report after a stop; R3.11.2 so may a loss, and nothing new is dispatched
                   ((S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp $prop $seen2) (rejected terminal))
                   (conf-drain (consume-prop $kind (by-kind $person $author $max $profile $policy $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp $prop $seen2 $kind $f)))))))))

(= (by-kind $person $author $max $profile $policy $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp $prop $seen $kind $f)
   (let $keep (S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp $prop $seen)
   (case $kind
     ((dispatched
        (let ($op $k $c) $f
          (if (or (== $k proposal) (== $k apply)) ($keep (rejected run-kind-not-dispatchable))   ; R3.11.2/R3.11.4: internal ledger kinds
          (if (> (op-uses $op $seen) 1)   ; R3.3: $seen already holds this observation, so >1 means an earlier dispatch reused it
              ($keep (rejected run-id-reused))
              ((S $ph $rep $pend $conf $cand $tested $rev $req $done $unres (cons-atom ($op $k $c) $disp) $prop $seen) accepted)))))
      (opened
        (if (== $ph claimed) ((S open $rep $pend $conf $cand $tested $rev $req $done $unres $disp $prop $seen) accepted) ($keep (rejected not-claimed))))
      (read
        (if (or (== $ph open) (or (== $ph understood) (== $ph needs-read)))
            ((S understood $rep $pend $conf $cand $tested $rev $req $done $unres $disp $prop $seen) accepted)
            ($keep accepted)))
      (changed   ; an origin edit; R3.11: not in the root suggest-only profile
        (let ($c $r) $f
          (if (== $profile root-suggest) ($keep (rejected origin-edit-not-in-profile))
              (begin-candidate $keep $ph $rep $unres $disp $prop $seen $c $r))))
      (candidate-retained   ; R3.11 (F4 addendum 4): a retained suggestion with its own fork; the origin is unchanged
        (let ($c $r $fork) $f
          (if (not (== $profile root-suggest)) ($keep (rejected candidate-retained-not-in-profile))
          (if (== $fork none) ($keep (rejected candidate-needs-its-fork))
              (begin-candidate $keep $ph $rep $unres $disp $prop $seen $c $r)))))
      (tests-pass
        (let ($c $run) $f
          (if (and (open-for-results? $ph) (and (== $c $cand) (is-member ($run test $c) $disp)))   ; R3.6: a result retires its run
              (let $d2 (without ($run test $c) $disp)
                (if (== $ph edited)
                    (if (and (all-in $req $done) (no-open-checks $d2))
                        ((S (if (rev-ok $rev $cand) ready green) $rep $pend $conf $cand $c $rev $req $done $unres $d2 $prop $seen) accepted)
                        ((S edited $rep $pend $conf $cand $c $rev $req $done $unres $d2 $prop $seen) accepted))
                    ((S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $d2 $prop $seen) accepted)))
              ($keep (rejected run-not-dispatched-for-this-candidate)))))
      (tests-fail
        (let ($c $run) $f
          (if (and (open-for-results? $ph) (and (== $c $cand) (is-member ($run test $c) $disp)))   ; R3.5: also after green/ready
              (let* (($r2 (+ $rep 1)) ($d2 (without ($run test $c) $disp)))
                (if (> $r2 $max)
                    ((S blocked $r2 none none $cand (failed $cand) none $req $done (drain-unres $d2 $unres) (prop-entries $d2) $prop $seen) accepted)
                    ((S red $r2 none none $cand (failed $cand) none $req $done $unres $d2 $prop $seen) accepted)))   ; R3.12 (4) refuted
              ($keep (rejected run-not-dispatched-for-this-candidate)))))
      (check-pass
        (let ($c $k $run) $f
          (if (and (check-kind? $k) (and (open-for-results? $ph) (and (== $c $cand) (is-member ($run $k $c) $disp))))   ; R3.6; R3.7 kind
              (let* (($dn (cons-atom $k $done)) ($d2 (without ($run $k $c) $disp)))
                (if (== $ph edited)
                    (if (and (== $tested $cand) (and (all-in $req $dn) (no-open-checks $d2)))
                        ((S (if (rev-ok $rev $cand) ready green) $rep $pend $conf $cand $tested $rev $req $dn $unres $d2 $prop $seen) accepted)
                        ((S edited $rep $pend $conf $cand $tested $rev $req $dn $unres $d2 $prop $seen) accepted))
                    ((S $ph $rep $pend $conf $cand $tested $rev $req $dn $unres $d2 $prop $seen) accepted)))
              ($keep (rejected run-not-dispatched-for-this-candidate)))))
      (check-fail
        (let ($c $k $run) $f
          (if (and (check-kind? $k) (and (open-for-results? $ph) (and (== $c $cand) (is-member ($run $k $c) $disp))))   ; R3.5 open phases; R3.7 kind
              (let* (($r2 (+ $rep 1)) ($d2 (without ($run $k $c) $disp)))   ; R3.1 cap; R3.6 retire the run
                (if (> $r2 $max)
                    ((S blocked $r2 none none $cand (failed $cand) none $req $done (drain-unres $d2 $unres) (prop-entries $d2) $prop $seen) accepted)
                    ((S red $r2 none none $cand (failed $cand) none $req $done $unres $d2 $prop $seen) accepted)))   ; R3.12 (4) refuted
              ($keep (rejected run-not-dispatched-for-this-candidate)))))
      (check-unavailable
        (let ($c $k) $f
          (if (and (check-kind? $k) (== $c $cand))
              ((S blocked $rep none none $cand $tested $rev $req $done (drain-unres $disp $unres) (prop-entries $disp) $prop $seen) (accepted (check-unavailable $k)))   ; R3.6 clear confirmation; R3.7 drain open runs
              ($keep (rejected not-this-candidate)))))
      (check-unknown
        (let ($c $k $run) $f
          (if (and (check-kind? $k) (and (== $c $cand) (is-member ($run $k $c) $disp)))
              ((S (if (== $ph blocked) blocked reconcile) $rep $pend $conf $cand $tested $rev $req $done (cons-atom $run $unres) (without ($run $k $c) $disp) $prop $seen) accepted)   ; R3.3 hold; R3.6 moves the run to unresolved
              ($keep (rejected run-not-dispatched-for-this-candidate)))))
      (review-pass
        (let ($c $v $rq) $f   ; R3.4: the review request must be dispatched in this generation; reviewer is real and not the author
          (if (and (open-for-results? $ph) (and (== $c $cand) (and (independent? $v $author $person $seen) (is-member ($rq review $c) $disp))))   ; R3.7: edited/green/ready; R3.12 (5) author set
              ((S (if (== $ph edited) edited ready) $rep $pend $conf $cand $tested $c $req $done $unres (without ($rq review $c) $disp) $prop $seen) accepted)
              ($keep (rejected review-not-independent-or-not-this-candidate)))))
      (review-fail
        (let ($c $v $rq) $f
          (if (and (open-for-results? $ph) (and (== $c $cand) (and (independent? $v $author $person $seen) (is-member ($rq review $c) $disp))))   ; R3.6: any open phase; R3.12 (5)
              ((S understood $rep none none $cand (failed $cand) none $req $done $unres (without ($rq review $c) $disp) $prop $seen) accepted)
              ($keep (rejected review-not-independent-or-not-this-candidate)))))
      (approval-needed
        (let ($op) $f
          (if (> (op-uses $op $seen) 1)   ; R3.4: approval ids are lifetime-unique; R3.11.5 across all operation ids
              ($keep (rejected approval-id-reused))
              ((S $ph $rep $op none $cand $tested $rev $req $done $unres $disp $prop $seen) accepted))))   ; R3.4: a newer approval supersedes any older confirmation
      (approved
        (let ($op $p) $f
          (if (and (not (== $pend none)) (and (== $op $pend) (== $p $person)))   ; R3.2: a real pending intent
              ((S $ph $rep none ($op $cand $p) $cand $tested $rev $req $done $unres (cons-atom ($op apply $cand) $disp) $prop $seen) accepted)   ; R3.11.4 the apply is exposed from consent on
              ($keep (rejected approval-not-for-this-intent)))))
      (applied
        (let ($op $c $p) $f
          (if (and (== $ph ready) (and (== $pend none) (and (== $disp (($op apply $c))) (and (== $unres ()) (and (== $c $cand) (and (rev-ok-for-apply $rev $c $policy) (== $conf ($op $c $p))))))))   ; R3.4 nothing pending; R3.6 nothing else outstanding (R3.11.4: only its own entry); R3.11.2 no unresolved debt
              ((S delivered $rep none $conf $cand $tested $rev $req $done $unres () $prop $seen) accepted)
              ($keep (rejected apply-not-confirmed-for-this-candidate)))))
      (stale
        (if (or (== $ph blocked) (== $ph reconcile))
            ((S $ph $rep $pend $conf $cand $tested $rev $req $done (drain-unres $disp $unres) (prop-entries $disp) $prop $seen) accepted)   ; R3.11: a hold still owes readback
            ((S needs-read $rep none none $cand (refute-keep $tested) none $req () (drain-unres $disp $unres) (prop-entries $disp) $prop $seen) accepted)))   ; R3.9: keep the obligation; R3.12 and the refutation
      (refused ((S blocked $rep none none $cand $tested $rev $req $done (drain-unres $disp $unres) (prop-entries $disp) $prop $seen) accepted))   ; R3.7 drain
      (cancelled ((S stopped $rep none none $cand $tested $rev $req $done (drain-unres $disp $unres) (prop-entries $disp) $prop $seen) accepted))   ; R3.9: cleanup owed
      (unknown
        (let ($op) $f
          (if (is-member $op $unres) ($keep (rejected already-unresolved))   ; R3.11.2
          (let $own (if (== $prop none) False (if (== (car-atom $prop) executing) (== (index-atom $prop 4) $op) False))
            ((S (if (or (terminal? $ph) (== $ph blocked)) $ph reconcile) $rep $pend $conf $cand $tested $rev $req $done (cons-atom $op $unres)
                (if $own (without ($op proposal (index-atom $prop 1)) $disp) (without-op $op $disp)) (if $own none $prop) $seen) accepted)))))   ; R3.11.2 terminal stays terminal   ; R3.3 hold; R3.11 explicit loss of the executing operation
      (reconciled
        (let ($op) $f
          (if (is-member $op $unres)
              (let $u2 (without $op $unres)
                (if (or (terminal? $ph) (== $ph blocked))   ; R3.3: resolving uncertainty never releases a hold
                    ((S $ph $rep $pend $conf $cand $tested $rev $req $done $u2 $disp $prop $seen) accepted)
                    (let $u3 (drain-unres $disp $u2)   ; R3.11: runs still open are owed readback, never dropped
                      (if (== $u3 ())
                          ((S needs-read $rep none none $cand (refute-keep $tested) none $req () () (prop-entries $disp) $prop $seen) accepted)
                          ((S reconcile $rep $pend $conf $cand $tested $rev $req $done $u3 (prop-entries $disp) $prop $seen) accepted)))))
              ($keep (rejected not-an-unresolved-operation)))))
      (proposed   ; R3.8: a model proposal, never evidence
        (let ($pid $a $d) $f
          (if (> (proposal-uses $pid $seen) 1) ($keep (rejected proposal-id-reused))
          (if (not (and (== $prop none) (and (== $unres ()) (and (== $pend none) (admissible-p? $profile $ph $a)))))
              ($keep (rejected proposal-not-admissible))
              ((S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp (pending $pid $a $d) $seen) accepted)))))
      (proposal-selected   ; exact bytes only; a receipt, no capability
        (let ($pid $a $d) $f
          (if (and (== $prop (pending $pid $a $d)) (admissible-p? $profile $ph $a))
              ((S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp (selected $pid $a $d) $seen) accepted)
              ($keep (rejected proposal-not-pending-or-changed)))))
      (proposal-executing  ; the selected original becomes exactly one tracked operation
        (let ($pid $op) $f
          (if (> (op-uses $op $seen) 1) ((set-prop $keep (unexecuted-dropped $prop)) (rejected operation-id-reused))   ; R3.10; R3.11 drops the selection
          (if (if (== $prop none) False
                  (and (== (car-atom $prop) selected)
                       (and (== (index-atom $prop 1) $pid)
                            (and (admissible-p? $profile $ph (index-atom $prop 2)) (and (== $unres ()) (== $pend none))))))   ; R3.10: re-checked now
              ((S $ph $rep $pend $conf $cand $tested $rev $req $done $unres (cons-atom ($op proposal $pid) $disp)
                  (executing $pid (index-atom $prop 2) (index-atom $prop 3) $op) $seen) accepted)
              ((set-prop $keep (unexecuted-dropped $prop)) (rejected proposal-not-selected-or-not-admissible-now))))))   ; R3.11
      (proposal-done   ; R3.10: the executing operation's own completion retires it
        (let ($pid $op) $f
          (if (is-member ($op proposal $pid) $disp)
              ((S $ph $rep $pend $conf $cand $tested $rev $req $done $unres (without ($op proposal $pid) $disp) none $seen) accepted)
              ($keep (rejected not-the-executing-operation)))))
      ; ---- R3.12 kinds ----------------------------------------------------------------------------------
      (think-started   ; (2) journalled before the helper model call; a rejection means no call
        (let ($att $h) $f
          (if (> (op-uses $att $seen) 1) ($keep (rejected operation-id-reused))
          (if (not (and (think-phase? $ph) (and (== $prop none) (and (== $unres ()) (and (== $pend none) (not (== $h none)))))))
              ($keep (rejected think-not-due))
              ((S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp (thinking $att $h) $seen) accepted)))))
      (think-failed    ; (2) the helper ended without a proposal: one repair; the phase is otherwise unchanged
        (let ($att) $f
          (if (if (thinking? $prop) (== (index-atom $prop 1) $att) False)   ; PeTTa: `and` is eager, index-atom of none fails
              (let $r2 (+ $rep 1)
                (if (> $r2 $max)
                    ((S blocked $r2 none none $cand $tested none $req $done (drain-unres $disp $unres) (prop-entries $disp) none $seen) accepted)
                    ((S $ph $r2 $pend $conf $cand $tested $rev $req $done $unres $disp none $seen) accepted)))
              ($keep (rejected not-the-open-think)))))
      (review-unavailable   ; (3) no second opinion can run; never a pass
        (let ($c) $f
          (if (not (and (open-for-results? $ph) (and (== $c $cand) (not (rev-ok $rev $cand))))) ($keep (rejected review-not-due))
          (if (in-flight? review $disp) ($keep (rejected review-in-flight))
          (if (== $policy review-waivable)
              ((S (if (and (== $ph green) (== $tested $cand)) ready $ph) $rep $pend $conf $cand $tested (unreviewed $c) $req $done $unres $disp $prop $seen)
               (accepted (review-unavailable waived)))
              ((S blocked $rep none none $cand $tested $rev $req $done (drain-unres $disp $unres) (prop-entries $disp) $prop $seen)
               (accepted (review-unavailable blocked))))))))   ; as check-unavailable: clear confirmation, drain open runs
      (reconciled-current   ; (4) the readback of op proves the held candidate current: re-retain it, fresh generation
        (let ($op $c) $f
          (if (not (is-member $op $unres)) ($keep (rejected not-an-unresolved-operation))
          (if (not (and (== $c $cand) (and (not (== $c none)) (not (refuted? $tested))))) ($keep (rejected not-the-current-candidate))
          (if (or (terminal? $ph) (== $ph blocked)) ($keep (rejected hold-kept))   ; a hold is never released by a readback
          (let $u3 (drain-unres $disp (without $op $unres))
            (if (not (== $u3 ())) ($keep (rejected reconcile-not-clean))
            (if (prop-op-open? $prop $disp) ($keep (rejected proposal-effect-unreported))
                ((S edited $rep none none $c none none $req () () (prop-entries $disp) (if (thinking? $prop) none $prop) $seen) accepted)))))))))
      (changes-requested   ; (6) the person's own words refute the waiting candidate; no review is forged
        (let ($c $p) $f
          (if (and (or (== $ph green) (== $ph ready)) (and (== $c $cand) (== $p $person)))
              ((S understood $rep none none $cand (failed $cand) none $req $done $unres $disp $prop $seen) accepted)
              ($keep (rejected not-the-persons-waiting-candidate)))))
      (apply-refused   ; (7) a definite no for the confirmed apply: nothing applied, no debt, the phase stays
        (let ($op) $f
          (if (if (== $conf none) False (and (== (index-atom $conf 0) $op) (is-member (apply-entry $conf) $disp)))
              ((S $ph $rep none none $cand $tested $rev $req $done $unres (without (apply-entry $conf) $disp) $prop $seen) accepted)
              ($keep (rejected not-the-confirmed-apply)))))
      ($other ($keep (rejected unknown-kind)))))))

(= (replay $ctx $state $log)
   (if (== $log ()) $state
       (let ($s2 $v) (apply-obs $ctx $state (car-atom $log)) (replay $ctx $s2 (cdr-atom $log)))))
(= (receipts $ctx $state $log)
   (if (== $log ()) ()
       (let ($s2 $v) (apply-obs $ctx $state (car-atom $log)) (cons-atom $v (receipts $ctx $s2 (cdr-atom $log))))))
(= (phase-of (S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp $prop $seen)) $ph)

; ---- proposed next action; unresolved effects come first, even after a stop -------------------
(= (next-action (S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp $prop $seen) $task $test)
   (if (not (== $unres ()))
       (do (reconcile (car-atom $unres)))
       (if (not (== $pend none))
           (rest awaiting-approval)
           (case $ph
             ((claimed    (do (code-open $task)))
              (open       (read-or-proposal $prop find-the-relevant-code))   ; R3.12
              (needs-read (read-or-proposal $prop read-again-before-editing))
              (understood (think-or-proposal $prop make-the-smallest-change))
              (edited     (if (== $tested $cand)
                              (let $m (first-missing-idle $req $done $disp)   ; R3.8: never re-launch in-flight checks
                                (if (== $m none) (rest awaiting-results) (do (run-check $m))))
                              (if (in-flight? test $disp) (rest awaiting-results) (do (code-exec $test)))))   ; R3.8: wait for an in-flight test
              (red        (think-or-proposal $prop repair-from-the-failing-output))
              (green      (if (in-flight? review $disp) (rest awaiting-results) (do (review-request $cand))))   ; R3.9
              (ready      (if (== $conf none) (if (== $rev $cand) (tell confirm-to-apply $cand) (tell confirm-unreviewed-to-apply $cand))   ; R3.12 (3)
                              (let $e (apply-entry $conf)
                                (if (== $disp (cons-atom $e ())) (do (apply-confirmed $conf)) (rest awaiting-results)))))   ; R3.7: mirror the apply guard (R3.11.4: only its own entry)
              (delivered  (rest done))
              (blocked    (rest needs-person))
              (stopped    (rest stopped)))))))

(= (needs-model (think $g)) True)
(= (needs-model (do $x)) False)
(= (needs-model (tell $x $y)) False)
(= (needs-model (rest $w)) False)

; ---- R3.11.1: profile-aware next action (root-suggest never proposes origin runs or apply) --------------
(= (cand-of (S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp $prop $seen)) $cand)
(= (root-action $a $c)
   (case $a
     (((do (code-exec $t)) (do (proposal-test $c $t)))
      ((do (run-check $m)) (do (proposal-check $c $m)))
      ((do (apply-confirmed $x)) (rest awaiting-person-apply))
      ((do (code-open $t)) (do (code-open-readonly $t)))   ; R3.11.2
      ((do (review-request $c2)) (do (proposal-review $c2)))
      ((think find-the-relevant-code) (do (host-read find-the-relevant-code)))   ; R3.12 (1): the host reads the person's scope
      ((think read-again-before-editing) (do (host-read read-again-before-editing)))
      ($other $a))))
(= (next-action-for $profile $st $task $test)
   (let $a (next-action $st $task $test)
     (if (== $profile root-suggest) (root-action $a (cand-of $st)) $a)))
