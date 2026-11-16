; Coding task controller: deterministic state transitions and proposed actions.
;
; The host journals an operation before performing its effect. Only that
; operation's own result retires it; uncertain outcomes remain unresolved debt.
; Operation identifiers are unique for the task's lifetime. A model proposal
; supplies judgement and never counts as test, review or completion evidence.
;
; Readiness requires current-candidate tests, required checks and an independent
; review. Applying requires the person's matching confirmation and no other
; outstanding or unresolved operation. The root-suggest profile validates a
; retained candidate and waits for the person's own confirmed application.
;
; Context: (Ctx task epoch person author max-repairs profile)
; Profile: delegated | root-suggest
; State: (S phase repairs pending confirmed candidate tested reviewed
;           required done unresolved dispatched proposal seen)
; Observation: (O id kind task epoch fields)
; The reducer is pure; the host checks authority before every effect.

(= (start-state) (S claimed 0 none none none none none () () () () none ()))

(= (all-in $xs $ys)
   (if (== $xs ()) True (if (is-member (car-atom $xs) $ys) (all-in (cdr-atom $xs) $ys) False)))
(= (without $x $xs) (filter-atom $xs $y (not (== $y $x))))
(= (body-of $id $seen)
   (if (== $seen ()) none
       (let ($i $b) (car-atom $seen) (if (== $i $id) $b (body-of $id (cdr-atom $seen))))))

(= (run-uses $run $seen)
   (if (== $seen ()) 0
       (let ($i $b) (car-atom $seen)
         (+ (case $b (((dispatched ($run $k $c)) 1) ($other 0))) (run-uses $run (cdr-atom $seen))))))
(= (approval-uses $op $seen)
   (if (== $seen ()) 0
       (let ($i $b) (car-atom $seen)
         (+ (case $b (((approval-needed ($op)) 1) ($other 0))) (approval-uses $op (cdr-atom $seen))))))
(= (no-open-checks $d)
   (if (== $d ()) True
       (let ($o $k $c) (car-atom $d) (if (or (== $k review) (== $k apply)) (no-open-checks (cdr-atom $d)) False))))
(= (check-kind? $k) (not (is-member $k (review test proposal apply none))))
(= (open-entries $d) (map-atom $d $e (let ($o $k $c) $e $o)))
(= (prop-entry? $e) (let ($o $k $c) $e (== $k proposal)))
(= (run-entries $d) (filter-atom $d $e (not (prop-entry? $e))))
(= (prop-entries $d) (filter-atom $d $e (prop-entry? $e)))
(= (drain-unres $d $u) (append (open-entries (run-entries $d)) $u))
(= (admissible-p? $profile $ph $a)
   (if (== $profile root-suggest)
       (if (== $a edit) False (if (== $a suggest) (admissible? $ph edit) (admissible? $ph $a)))
       (if (== $a suggest) False (admissible? $ph $a))))
(= (without-op $op $d) (filter-atom $d $e (let ($o $k $c) $e (not (== $o $op)))))
(= (conf-of (S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp $prop $seen)) $conf)
(= (apply-entry $conf) ((index-atom $conf 0) apply (index-atom $conf 1)))
(= (apply-entry? $e) (let ($o $k $c) $e (== $k apply)))
(= (conf-drain ($st $v))
   (let (S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp $prop $seen) $st
     (if (not (== $conf none)) ($st $v)
         (let $aps (filter-atom $disp $e (apply-entry? $e))
           (if (== $aps ()) ($st $v)
               ((S $ph $rep $pend $conf $cand $tested $rev $req $done (append (open-entries $aps) $unres)
                   (filter-atom $disp $e (not (apply-entry? $e))) $prop $seen) $v))))))
(= (all-checks? $r) (if (== $r ()) True (if (check-kind? (car-atom $r)) (all-checks? (cdr-atom $r)) False)))
(= (edit-phase? $ph) (or (== $ph understood) (or (== $ph red) (or (== $ph edited) (or (== $ph green) (== $ph ready))))))
(= (unexecuted-dropped $prop) (if (== $prop none) none (if (== (car-atom $prop) executing) $prop none)))

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
(= (proposal-kind? $kind) (is-member $kind (proposed proposal-selected proposal-executing proposal-done)))
(= (op-uses $op $seen)
   (if (== $seen ()) 0
       (let ($i $b) (car-atom $seen)
         (+ (case $b (((proposal-executing ($pid $op)) 1) ((dispatched ($op $k $c)) 1) ((approval-needed ($op)) 1) ($other 0))) (op-uses $op (cdr-atom $seen))))))
(= (prop-op-open? $prop $disp)
   (if (== $prop none) False
       (if (== (car-atom $prop) executing) (is-member ((index-atom $prop 4) proposal (index-atom $prop 1)) $disp) False)))
(= (set-prop (S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp $old $seen) $new)
   (S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp $new $seen))
(= (prop-of (S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp $prop $seen)) $prop)
(= (disp-of (S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp $prop $seen)) $disp)
(= (consume-prop $kind ($st $v))
   (if (or (proposal-kind? $kind) (== $v duplicate))
       ($st $v)
       (case $v
         (((rejected $why) ($st $v))
          ($ok (if (prop-op-open? (prop-of $st) (disp-of $st)) ($st $v) ((set-prop $st none) $v)))))))
(= (think-or-proposal $prop $goal)
   (case $prop
     ((none (think $goal))
      ((pending $pid $a $d) (do (select-proposal $pid)))
      ((selected $pid $a $d) (do (execute-proposal $pid $a $d)))
      ((executing $pid $a $d $op) (rest awaiting-results)))))
(= (begin-candidate $keep $ph $rep $unres $disp $prop $seen $c $r)
   (if (== $c none) ($keep (rejected candidate-is-not-a-reference))
   (if (not (all-checks? $r)) ($keep (rejected reserved-check-kind))
   (if (not (== $unres ())) ($keep (rejected unresolved-effect-first))
   (if (prop-op-open? $prop $disp) ($keep (rejected proposal-effect-unreported))
   (if (edit-phase? $ph)
       ((S edited $rep none none $c none none $r () (drain-unres $disp $unres) (prop-entries $disp) $prop $seen) accepted)
       ($keep (rejected edit-without-fresh-read))))))))
(= (in-flight? $k $d)
   (if (== $d ()) False
       (let ($o $kk $c) (car-atom $d) (if (== $kk $k) True (in-flight? $k (cdr-atom $d))))))
(= (first-missing-idle $xs $ys $d)
   (if (== $xs ()) none
       (let $x (car-atom $xs)
         (if (or (is-member $x $ys) (in-flight? $x $d)) (first-missing-idle (cdr-atom $xs) $ys $d) $x))))
(= (open-for-results? $ph) (or (== $ph edited) (or (== $ph green) (== $ph ready))))
(= (terminal? $ph) (or (== $ph delivered) (== $ph stopped)))

(= (apply-obs (Ctx $task $epoch $person $author $max $profile)
              (S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp $prop $seen)
              (O $id $kind $otask $oepoch $f))
   (let* (($keep (S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp $prop $seen))
          ($prior (body-of $id $seen)))
     (if (not (== $prior none))
         (if (== $prior ($kind $f)) ($keep duplicate) ($keep (rejected conflicting-duplicate)))
         (if (not (and (== $otask $task) (== $oepoch $epoch)))
             ($keep (rejected wrong-task))
             (let $seen2 (cons-atom ($id ($kind $f)) $seen)
               (if (and (terminal? $ph) (not (or (== $kind reconciled) (or (== $kind proposal-done) (== $kind unknown)))))
                   ((S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp $prop $seen2) (rejected terminal))
                   (conf-drain (consume-prop $kind (by-kind $person $author $max $profile $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp $prop $seen2 $kind $f)))))))))

(= (by-kind $person $author $max $profile $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp $prop $seen $kind $f)
   (let $keep (S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp $prop $seen)
   (case $kind
     ((dispatched
        (let ($op $k $c) $f
          (if (or (== $k proposal) (== $k apply)) ($keep (rejected run-kind-not-dispatchable))
          (if (> (op-uses $op $seen) 1)
              ($keep (rejected run-id-reused))
              ((S $ph $rep $pend $conf $cand $tested $rev $req $done $unres (cons-atom ($op $k $c) $disp) $prop $seen) accepted)))))
      (opened
        (if (== $ph claimed) ((S open $rep $pend $conf $cand $tested $rev $req $done $unres $disp $prop $seen) accepted) ($keep (rejected not-claimed))))
      (read
        (if (or (== $ph open) (or (== $ph understood) (== $ph needs-read)))
            ((S understood $rep $pend $conf $cand $tested $rev $req $done $unres $disp $prop $seen) accepted)
            ($keep accepted)))
      (changed
        (let ($c $r) $f
          (if (== $profile root-suggest) ($keep (rejected origin-edit-not-in-profile))
              (begin-candidate $keep $ph $rep $unres $disp $prop $seen $c $r))))
      (candidate-retained
        (let ($c $r $fork) $f
          (if (not (== $profile root-suggest)) ($keep (rejected candidate-retained-not-in-profile))
          (if (== $fork none) ($keep (rejected candidate-needs-its-fork))
              (begin-candidate $keep $ph $rep $unres $disp $prop $seen $c $r)))))
      (tests-pass
        (let ($c $run) $f
          (if (and (open-for-results? $ph) (and (== $c $cand) (is-member ($run test $c) $disp)))
              (let $d2 (without ($run test $c) $disp)
                (if (== $ph edited)
                    (if (and (all-in $req $done) (no-open-checks $d2))
                        ((S (if (== $rev $cand) ready green) $rep $pend $conf $cand $c $rev $req $done $unres $d2 $prop $seen) accepted)
                        ((S edited $rep $pend $conf $cand $c $rev $req $done $unres $d2 $prop $seen) accepted))
                    ((S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $d2 $prop $seen) accepted)))
              ($keep (rejected run-not-dispatched-for-this-candidate)))))
      (tests-fail
        (let ($c $run) $f
          (if (and (open-for-results? $ph) (and (== $c $cand) (is-member ($run test $c) $disp)))
              (let* (($r2 (+ $rep 1)) ($d2 (without ($run test $c) $disp)))
                (if (> $r2 $max)
                    ((S blocked $r2 none none $cand none none $req $done (drain-unres $d2 $unres) (prop-entries $d2) $prop $seen) accepted)
                    ((S red $r2 none none $cand none none $req $done $unres $d2 $prop $seen) accepted)))
              ($keep (rejected run-not-dispatched-for-this-candidate)))))
      (check-pass
        (let ($c $k $run) $f
          (if (and (check-kind? $k) (and (open-for-results? $ph) (and (== $c $cand) (is-member ($run $k $c) $disp))))
              (let* (($dn (cons-atom $k $done)) ($d2 (without ($run $k $c) $disp)))
                (if (== $ph edited)
                    (if (and (== $tested $cand) (and (all-in $req $dn) (no-open-checks $d2)))
                        ((S (if (== $rev $cand) ready green) $rep $pend $conf $cand $tested $rev $req $dn $unres $d2 $prop $seen) accepted)
                        ((S edited $rep $pend $conf $cand $tested $rev $req $dn $unres $d2 $prop $seen) accepted))
                    ((S $ph $rep $pend $conf $cand $tested $rev $req $dn $unres $d2 $prop $seen) accepted)))
              ($keep (rejected run-not-dispatched-for-this-candidate)))))
      (check-fail
        (let ($c $k $run) $f
          (if (and (check-kind? $k) (and (open-for-results? $ph) (and (== $c $cand) (is-member ($run $k $c) $disp))))
              (let* (($r2 (+ $rep 1)) ($d2 (without ($run $k $c) $disp)))
                (if (> $r2 $max)
                    ((S blocked $r2 none none $cand none none $req $done (drain-unres $d2 $unres) (prop-entries $d2) $prop $seen) accepted)
                    ((S red $r2 none none $cand none none $req $done $unres $d2 $prop $seen) accepted)))
              ($keep (rejected run-not-dispatched-for-this-candidate)))))
      (check-unavailable
        (let ($c $k) $f
          (if (and (check-kind? $k) (== $c $cand))
              ((S blocked $rep none none $cand $tested $rev $req $done (drain-unres $disp $unres) (prop-entries $disp) $prop $seen) (accepted (check-unavailable $k)))
              ($keep (rejected not-this-candidate)))))
      (check-unknown
        (let ($c $k $run) $f
          (if (and (check-kind? $k) (and (== $c $cand) (is-member ($run $k $c) $disp)))
              ((S (if (== $ph blocked) blocked reconcile) $rep $pend $conf $cand $tested $rev $req $done (cons-atom $run $unres) (without ($run $k $c) $disp) $prop $seen) accepted)
              ($keep (rejected run-not-dispatched-for-this-candidate)))))
      (review-pass
        (let ($c $v $rq) $f
          (if (and (open-for-results? $ph) (and (== $c $cand) (and (not (== $v $author)) (and (not (== $v none)) (is-member ($rq review $c) $disp)))))
              ((S (if (== $ph edited) edited ready) $rep $pend $conf $cand $tested $c $req $done $unres (without ($rq review $c) $disp) $prop $seen) accepted)
              ($keep (rejected review-not-independent-or-not-this-candidate)))))
      (review-fail
        (let ($c $v $rq) $f
          (if (and (open-for-results? $ph) (and (== $c $cand) (and (not (== $v $author)) (and (not (== $v none)) (is-member ($rq review $c) $disp)))))
              ((S understood $rep none none $cand none none $req $done $unres (without ($rq review $c) $disp) $prop $seen) accepted)
              ($keep (rejected review-not-independent-or-not-this-candidate)))))
      (approval-needed
        (let ($op) $f
          (if (not (== $ph ready))
              ($keep (rejected approval-before-ready))   ; Peter on #43: approve only a tested, reviewed candidate
              (if (> (op-uses $op $seen) 1)
                  ($keep (rejected approval-id-reused))
                  ((S $ph $rep $op none $cand $tested $rev $req $done $unres $disp $prop $seen) accepted)))))
      (approved
        (let ($op $p) $f
          (if (and (== $ph ready) (and (not (== $pend none)) (and (== $op $pend) (== $p $person))))
              ((S $ph $rep none ($op $cand $p) $cand $tested $rev $req $done $unres (cons-atom ($op apply $cand) $disp) $prop $seen) accepted)
              ($keep (rejected approval-not-for-this-intent)))))
      (applied
        (let ($op $c $p) $f
          (if (and (== $ph ready) (and (== $pend none) (and (== $disp (($op apply $c))) (and (== $unres ()) (and (== $c $cand) (and (== $c $rev) (== $conf ($op $c $p))))))))
              ((S delivered $rep none $conf $cand $tested $rev $req $done $unres () $prop $seen) accepted)
              ($keep (rejected apply-not-confirmed-for-this-candidate)))))
      (stale
        (if (or (== $ph blocked) (== $ph reconcile))
            ((S $ph $rep $pend $conf $cand $tested $rev $req $done (drain-unres $disp $unres) (prop-entries $disp) $prop $seen) accepted)
            ((S needs-read $rep none none $cand none none $req () (drain-unres $disp $unres) (prop-entries $disp) $prop $seen) accepted)))
      (refused ((S blocked $rep none none $cand $tested $rev $req $done (drain-unres $disp $unres) (prop-entries $disp) $prop $seen) accepted))
      (cancelled ((S stopped $rep none none $cand $tested $rev $req $done (drain-unres $disp $unres) (prop-entries $disp) $prop $seen) accepted))
      (unknown
        (let ($op) $f
          (if (is-member $op $unres) ($keep (rejected already-unresolved))
          (let $own (if (== $prop none) False (if (== (car-atom $prop) executing) (== (index-atom $prop 4) $op) False))
            ((S (if (or (terminal? $ph) (== $ph blocked)) $ph reconcile) $rep $pend $conf $cand $tested $rev $req $done (cons-atom $op $unres)
                (if $own (without ($op proposal (index-atom $prop 1)) $disp) (without-op $op $disp)) (if $own none $prop) $seen) accepted)))))
      (reconciled
        (let ($op) $f
          (if (is-member $op $unres)
              (let $u2 (without $op $unres)
                (if (or (terminal? $ph) (== $ph blocked))
                    ((S $ph $rep $pend $conf $cand $tested $rev $req $done $u2 $disp $prop $seen) accepted)
                    (let $u3 (drain-unres $disp $u2)
                      (if (== $u3 ())
                          ((S needs-read $rep none none $cand none none $req () () (prop-entries $disp) $prop $seen) accepted)
                          ((S reconcile $rep $pend $conf $cand $tested $rev $req $done $u3 (prop-entries $disp) $prop $seen) accepted)))))
              ($keep (rejected not-an-unresolved-operation)))))
      (proposed
        (let ($pid $a $d) $f
          (if (> (proposal-uses $pid $seen) 1) ($keep (rejected proposal-id-reused))
          (if (not (and (== $prop none) (and (== $unres ()) (and (== $pend none) (admissible-p? $profile $ph $a)))))
              ($keep (rejected proposal-not-admissible))
              ((S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp (pending $pid $a $d) $seen) accepted)))))
      (proposal-selected
        (let ($pid $a $d) $f
          (if (and (== $prop (pending $pid $a $d)) (admissible-p? $profile $ph $a))
              ((S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp (selected $pid $a $d) $seen) accepted)
              ($keep (rejected proposal-not-pending-or-changed)))))
      (proposal-executing
        (let ($pid $op) $f
          (if (> (op-uses $op $seen) 1) ((set-prop $keep (unexecuted-dropped $prop)) (rejected operation-id-reused))
          (if (if (== $prop none) False
                  (and (== (car-atom $prop) selected)
                       (and (== (index-atom $prop 1) $pid)
                            (and (admissible-p? $profile $ph (index-atom $prop 2)) (and (== $unres ()) (== $pend none))))))
              ((S $ph $rep $pend $conf $cand $tested $rev $req $done $unres (cons-atom ($op proposal $pid) $disp)
                  (executing $pid (index-atom $prop 2) (index-atom $prop 3) $op) $seen) accepted)
              ((set-prop $keep (unexecuted-dropped $prop)) (rejected proposal-not-selected-or-not-admissible-now))))))
      (proposal-done
        (let ($pid $op) $f
          (if (is-member ($op proposal $pid) $disp)
              ((S $ph $rep $pend $conf $cand $tested $rev $req $done $unres (without ($op proposal $pid) $disp) none $seen) accepted)
              ($keep (rejected not-the-executing-operation)))))
      ($other ($keep (rejected unknown-kind)))))))

(= (replay $ctx $state $log)
   (if (== $log ()) $state
       (let ($s2 $v) (apply-obs $ctx $state (car-atom $log)) (replay $ctx $s2 (cdr-atom $log)))))
(= (receipts $ctx $state $log)
   (if (== $log ()) ()
       (let ($s2 $v) (apply-obs $ctx $state (car-atom $log)) (cons-atom $v (receipts $ctx $s2 (cdr-atom $log))))))
(= (phase-of (S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp $prop $seen)) $ph)

(= (next-action (S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp $prop $seen) $task $test)
   (if (not (== $unres ()))
       (do (reconcile (car-atom $unres)))
       (if (not (== $pend none))
           (rest awaiting-approval)
           (case $ph
             ((claimed    (do (code-open $task)))
              (open       (think-or-proposal $prop find-the-relevant-code))
              (needs-read (think-or-proposal $prop read-again-before-editing))
              (understood (think-or-proposal $prop make-the-smallest-change))
              (edited     (if (== $tested $cand)
                              (let $m (first-missing-idle $req $done $disp)
                                (if (== $m none) (rest awaiting-results) (do (run-check $m))))
                              (if (in-flight? test $disp) (rest awaiting-results) (do (code-exec $test)))))
              (red        (think-or-proposal $prop repair-from-the-failing-output))
              (green      (if (in-flight? review $disp) (rest awaiting-results) (do (review-request $cand))))
              (ready      (if (== $conf none) (tell confirm-to-apply $cand)
                              (let $e (apply-entry $conf)
                                (if (== $disp (cons-atom $e ())) (do (apply-confirmed $conf)) (rest awaiting-results)))))
              (delivered  (rest done))
              (blocked    (rest needs-person))
              (stopped    (rest stopped)))))))

(= (needs-model (think $g)) True)
(= (needs-model (do $x)) False)
(= (needs-model (tell $x $y)) False)
(= (needs-model (rest $w)) False)

(= (cand-of (S $ph $rep $pend $conf $cand $tested $rev $req $done $unres $disp $prop $seen)) $cand)
(= (root-action $a $c)
   (case $a
     (((do (code-exec $t)) (do (proposal-test $c $t)))
      ((do (run-check $m)) (do (proposal-check $c $m)))
      ((do (apply-confirmed $x)) (rest awaiting-person-apply))
      ((do (code-open $t)) (do (code-open-readonly $t)))
      ((do (review-request $c2)) (do (proposal-review $c2)))
      ($other $a))))
(= (next-action-for $profile $st $task $test)
   (let $a (next-action $st $task $test)
     (if (== $profile root-suggest) (root-action $a (cand-of $st)) $a)))
