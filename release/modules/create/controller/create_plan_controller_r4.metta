; Create plan controller R4.0 (Dot, at Jon's direction). Sits above the per-change reducer R3.12
;   (modules/code/controller/coding_controller_r3_12.metta, unchanged): each plan piece is built by its own R3.12 task.
;   One invariant: a plan reaches `deployed` only through the person's own go on a previewed, checked checkpoint whose
;   every piece was built after a red acceptance check, reviewed by its team's kind of review, and integrated; every
;   step toward delivery is journalled before its effect under a lifetime-unique operation id, and uncertainty (unknown,
;   reconciled, withdrawn questions, late or forged results) never releases a hold or skips a step.
;   1. Pure and replayed: (replay ctx state log). Journal first: an effect is admitted by its own journalled observation
;      (plan-started, dispatched, piece-started, deploy-approved); a rejected one means the host performs no effect.
;   2. The plan's dependency graph is atoms (Piece id team deps files), validated like OmegaPlanner's validate_plan
;      (unique ids, known and non-repeated deps, acyclic, a file owned once). Which pieces may start is a MeTTa query
;      over that graph (may-start), bounded by the lease in Ctx; piece-started past the lease is refused.
;   3. Teams: a piece belongs to studio (UI and design, the Make team) or code (logic and wiring). Teams run in parallel;
;      a cross-team wait exists only where the plan names the dependency. A plan with studio pieces carries its design
;      in those pieces (no serial design phase); a plan without them may declare an optional design phase or skip it.
;   4. Tests are authored or detected before any piece starts, and the first check runs against the base scaffold: it
;      must be red; a green base blocks (the suite proves nothing) and asks the person.
;   5. Review covers both teams: a code piece needs review-pass (diff and test), a studio piece needs design-review-pass
;      against the brief with render evidence. Reviewers exclude the Ctx authors, every builder any piece-started named
;      (either team) and the person. review-unavailable blocks under review-required and marks the piece unreviewed
;      under review-waivable (the go is then asked as confirm-unreviewed-deploy).
;   6. A failing check routes to the piece(s) owning the failing files (a MeTTa query over the graph); an unowned file
;      blocks. Repairs per piece and fix rounds per plan are capped (Ctx Caps); past a cap the plan blocks and asks.
;   7. Questions: a question about a piece holds that piece and its dependants only; about plan, every new effect;
;      about deploy, the go only. Other work continues. Only the person's answer releases a blocked hold.
;   8. `deployed` is produced only after deploy-approved (op person) by the person (not an author), on the previewed
;      current checkpoint, with nothing else open; deploy-refused returns to ready; a go cleared any other way becomes
;      unresolved debt (as R3.11.4's apply).
; Ctx: (Ctx plan epoch person (authors...) (Caps piece-repairs fix-rounds) lease review-policy)
; State: key/value list (see start-state). Observation: (O id kind plan epoch fields).
; Piece record: (Pc id status cand repairs fixrun mark); status waiting|started|fixing|built|reviewed|integrated.

(= (start-state) ((phase claimed) (held none) (why none) (plan none) (graph ()) (needs (none none)) (design none)
                  (suite none) (pieces ()) (ckpt none) (rounds 0) (retries 0) (questions ()) (answers ())
                  (preview none) (go none) (ledger ()) (unres ()) (seen ())))

; ---- generic helpers ---------------------------------------------------------------------------------------
(= (kv-get $k $xs) (if (== $xs ()) none (let ($kk $v) (car-atom $xs) (if (== $kk $k) $v (kv-get $k (cdr-atom $xs))))))
(= (sv $st $k) (kv-get $k $st))
(= (sput $st $k $v) (map-atom $st $e (let ($kk $vv) $e (if (== $kk $k) ($k $v) $e))))
(= (all-in $xs $ys) (if (== $xs ()) True (if (is-member (car-atom $xs) $ys) (all-in (cdr-atom $xs) $ys) False)))
(= (without $x $xs) (filter-atom $xs $y (not (== $y $x))))
(= (count-of $xs) (size-atom $xs))
(= (has-dups? $xs) (not (== (size-atom (unique-atom $xs)) (size-atom $xs))))
(= (flatten1 $xss) (if (== $xss ()) () (append (car-atom $xss) (flatten1 (cdr-atom $xss)))))
(= (acc $st) ($st accepted))
(= (rej $st $why) ($st (rejected $why)))

(= (ctx-plan (Ctx $pl $ep $pe $au $caps $lease $pol)) $pl)
(= (ctx-epoch (Ctx $pl $ep $pe $au $caps $lease $pol)) $ep)
(= (ctx-person (Ctx $pl $ep $pe $au $caps $lease $pol)) $pe)
(= (ctx-authors (Ctx $pl $ep $pe $au $caps $lease $pol)) $au)
(= (ctx-piece-cap (Ctx $pl $ep $pe $au (Caps $pc $fc) $lease $pol)) $pc)
(= (ctx-fix-cap (Ctx $pl $ep $pe $au (Caps $pc $fc) $lease $pol)) $fc)
(= (ctx-lease (Ctx $pl $ep $pe $au $caps $lease $pol)) $lease)
(= (ctx-policy (Ctx $pl $ep $pe $au $caps $lease $pol)) $pol)

; ---- the plan graph (atoms) --------------------------------------------------------------------------------
(= (known-team? $t) (is-member $t (studio code)))
(= (review-kind-of code) review)
(= (review-kind-of studio) design-review)
(= (node-id $n) (index-atom $n 1))
(= (node-of $p $graph) (let $m (filter-atom $graph $n (== (index-atom $n 1) $p)) (if (== $m ()) none (car-atom $m))))
(= (team-of $p $graph) (let $n (node-of $p $graph) (if (== $n none) none (index-atom $n 2))))
(= (deps-of $p $graph) (let $n (node-of $p $graph) (if (== $n none) () (index-atom $n 3))))
(= (files-of $p $graph) (let $n (node-of $p $graph) (if (== $n none) () (index-atom $n 4))))
(= (graph-ids $graph) (map-atom $graph $n (index-atom $n 1)))
(= (well-formed-node? $n) (case $n (((Piece $p $t $ds $fs) (and (not (== $p none)) (known-team? $t))) ($o False))))
(= (kahn $rem $done)   ; acyclic iff repeatedly removing pieces whose deps are done empties the graph
   (if (== $rem ()) True
       (let $free (filter-atom $rem $n (all-in (index-atom $n 3) $done))
         (if (== $free ()) False
             (kahn (filter-atom $rem $n (not (is-member $n $free))) (append (graph-ids $free) $done))))))
(= (graph-fault $graph)   ; OmegaPlanner validate_plan refusal codes, in its order
   (if (== $graph ()) step_count_limit
   (if (not (== (filter-atom $graph $n (not (well-formed-node? $n))) ())) invalid_step
   (if (has-dups? (graph-ids $graph)) duplicate_step
   (if (not (== (filter-atom $graph $n (has-dups? (index-atom $n 3))) ())) invalid_dependencies
   (if (not (all-in (flatten1 (map-atom $graph $n (index-atom $n 3))) (graph-ids $graph))) unknown_dependency
   (if (not (kahn $graph ())) dependency_cycle
   (if (has-dups? (flatten1 (map-atom $graph $n (index-atom $n 4)))) file_owned_twice
       none))))))))
(= (owner-of $file $graph)   ; a failing file routes to the piece that owns it
   (let $m (filter-atom $graph $n (is-member $file (index-atom $n 4))) (if (== $m ()) none (index-atom (car-atom $m) 1))))
(= (has-studio? $graph) (not (== (filter-atom $graph $n (== (index-atom $n 2) studio)) ())))

; ---- piece records -------------------------------------------------------------------------------------
(= (pc-id $r) (index-atom $r 1))
(= (pc-status $r) (index-atom $r 2))
(= (pc-cand $r) (index-atom $r 3))
(= (pc-reps $r) (index-atom $r 4))
(= (pc-fixrun $r) (index-atom $r 5))
(= (pc-mark $r) (index-atom $r 6))
(= (piece $p $st) (let $m (filter-atom (sv $st pieces) $r (== (index-atom $r 1) $p)) (if (== $m ()) none (car-atom $m))))
(= (status-of $p $st) (let $r (piece $p $st) (if (== $r none) none (pc-status $r))))
(= (set-piece $st $new) (sput $st pieces (map-atom (sv $st pieces) $r (if (== (index-atom $r 1) (index-atom $new 1)) $new $r))))
(= (with-status $r $s) (Pc (pc-id $r) $s (pc-cand $r) (pc-reps $r) (pc-fixrun $r) (pc-mark $r)))
(= (pieces-with $s $st) (filter-atom (sv $st pieces) $r (== (index-atom $r 2) $s)))
(= (active-count $st) (count-of (pieces-with started $st)))
(= (init-pieces $graph) (map-atom $graph $n (Pc (index-atom $n 1) waiting none 0 none reviewed)))

; ---- questions: (q about status), about: (piece p) | plan | deploy | blocked; status raised|asked|closed ----
(= (q-of $q $st) (let $m (filter-atom (sv $st questions) $e (== (index-atom $e 0) $q)) (if (== $m ()) none (car-atom $m))))
(= (open-q? $e) (not (== (index-atom $e 2) closed)))
(= (open-about? $about $st) (not (== (filter-atom (sv $st questions) $e (and (open-q? $e) (== (index-atom $e 1) $about))) ())))
(= (first-raised $st) (let $m (filter-atom (sv $st questions) $e (== (index-atom $e 2) raised)) (if (== $m ()) none (index-atom (car-atom $m) 0))))
(= (set-q $st $q $status) (sput $st questions (map-atom (sv $st questions) $e (if (== (index-atom $e 0) $q) ((index-atom $e 0) (index-atom $e 1) $status) $e))))
(= (valid-about? $about $graph)
   (case $about (((piece $p) (not (== (node-of $p $graph) none))) (plan True) (deploy True) ($o False))))
(= (q-held? $p $st)   ; a question about p, or about anything p depends on, holds p (dependent work only)
   (if (open-about? (piece $p) $st) True (q-held-any? (deps-of $p (sv $st graph)) $st)))
(= (q-held-any? $ps $st) (if (== $ps ()) False (if (q-held? (car-atom $ps) $st) True (q-held-any? (cdr-atom $ps) $st))))

; ---- the parallelism query: pieces that may start now, under the lease ----------------------------------
(= (startable? $r $st)
   (and (== (pc-status $r) waiting)
        (and (all-in (deps-of (pc-id $r) (sv $st graph)) (map-atom (pieces-with integrated $st) $x (index-atom $x 1)))
             (not (q-held? (pc-id $r) $st)))))
(= (take-n $n $xs) (if (or (<= $n 0) (== $xs ())) () (cons-atom (car-atom $xs) (take-n (- $n 1) (cdr-atom $xs)))))
(= (may-start $ctx $st)
   (take-n (- (ctx-lease $ctx) (active-count $st)) (map-atom (filter-atom (sv $st pieces) $r (startable? $r $st)) $r (index-atom $r 1))))

; ---- ledger: (op kind subject); unresolved keeps whole entries so a readback can restore its piece -------
(= (in-ledger? $e $st) (is-member $e (sv $st ledger)))
(= (op-entry $op $st) (let $m (filter-atom (sv $st ledger) $e (== (index-atom $e 0) $op)) (if (== $m ()) none (car-atom $m))))
(= (entry-for $kind $subj $st) (let $m (filter-atom (sv $st ledger) $e (and (== (index-atom $e 1) $kind) (== (index-atom $e 2) $subj))) (if (== $m ()) none (car-atom $m))))
(= (kind-in-flight? $kind $st) (not (== (filter-atom (sv $st ledger) $e (== (index-atom $e 1) $kind)) ())))
(= (piece-entry $p $st)   ; the open build entry of a piece: its start or its route-fix
   (let $m (filter-atom (sv $st ledger) $e (and (or (== (index-atom $e 1) start) (== (index-atom $e 1) route-fix)) (== (index-atom $e 2) $p)))
     (if (== $m ()) none (car-atom $m))))
(= (review-entry $p $c $st)
   (let $m (filter-atom (sv $st ledger) $e (and (or (== (index-atom $e 1) review) (== (index-atom $e 1) design-review)) (== (index-atom $e 2) ($p $c))))
     (if (== $m ()) none (car-atom $m))))
(= (unres-ops $st) (map-atom (sv $st unres) $e (index-atom $e 0)))
(= (add-entry $st $e) (sput $st ledger (cons-atom $e (sv $st ledger))))
(= (drop-entry $st $e) (sput $st ledger (without $e (sv $st ledger))))
(= (drain $st) (sput (sput $st unres (append (sv $st ledger) (sv $st unres))) ledger ()))   ; readback is never lost
(= (op-uses $op $seen)   ; operation ids are unique for the plan's lifetime, across every journalled kind
   (if (== $seen ()) 0
       (let ($i $b) (car-atom $seen)
         (+ (case $b (((plan-started ($op)) 1) ((dispatched ($op $k $s)) 1) ((piece-started ($p $op $h)) 1)
                      ((deploy-approved ($op $pp)) 1) ($o 0)))
            (op-uses $op (cdr-atom $seen))))))
(= (fresh-op? $op $st) (and (not (== $op none)) (<= (op-uses $op (sv $st seen)) 1)))   ; seen already holds this one
(= (builder-named? $v $seen)   ; any builder a piece-started ever named, on either team (rejected starts count too)
   (if (== $seen ()) False
       (let ($i $b) (car-atom $seen)
         (if (case $b (((piece-started ($p $t $v)) True) ($o False))) True (builder-named? $v (cdr-atom $seen))))))
(= (independent? $v $ctx $st)
   (and (not (== $v none)) (and (not (is-member $v (ctx-authors $ctx))) (and (not (== $v (ctx-person $ctx))) (not (builder-named? $v (sv $st seen)))))))

; ---- phases --------------------------------------------------------------------------------------------
(= (terminal? $ph) (or (== $ph deployed) (== $ph stopped)))
(= (build-phase? $ph) (is-member $ph (building fixing integrating)))
(= (tests-due? $st)   ; tests are authored or detected after the plan (and the optional design), before any piece
   (let $ph (sv $st phase)
     (or (== $ph designed) (and (== $ph planned) (== (index-atom (sv $st needs) 0) no-design)))))
(= (settle $st)   ; the build phase follows from the piece records
   (if (not (build-phase? (sv $st phase))) $st
       (let $ps (sv $st pieces)
         (if (not (== (filter-atom $ps $r (is-member (index-atom $r 2) (waiting started fixing built))) ()))
             (sput $st phase (if (> (sv $st rounds) 0) fixing building))
             (if (not (== (filter-atom $ps $r (== (index-atom $r 2) reviewed)) ())) (sput $st phase integrating)
                 (sput $st phase checking))))))
(= (block $st $why $held) (drain (sput (sput (sput (sput $st phase blocked) held $held) why $why) go none)))
(= (check-target $st) (case (sv $st phase) ((testing-authored base) (checking (sv $st ckpt)) ($o none))))
(= (effect-gate $st)   ; what stops any new effect: unresolved debt, a hold, a plan-wide question
   (if (not (== (sv $st unres) ())) unresolved-effect-first
   (if (== (sv $st phase) blocked) hold-kept
   (if (open-about? plan $st) awaiting-answer
       none))))
(= (reset-caps $st) (sput (sput (sput $st rounds 0) retries 0)
                          pieces (map-atom (sv $st pieces) $r (Pc (pc-id $r) (pc-status $r) (pc-cand $r) 0 (pc-fixrun $r) (pc-mark $r)))))
(= (go-drain ($st $v))   ; a go cleared by anything but its own deployed leaves the deploy as unresolved debt
   (if (not (== (sv $st go) none)) ($st $v)
       (let $ds (filter-atom (sv $st ledger) $e (== (index-atom $e 1) deploy))
         (if (== $ds ()) ($st $v)
             ((sput (sput $st ledger (filter-atom (sv $st ledger) $e (not (== (index-atom $e 1) deploy)))) unres (append $ds (sv $st unres))) $v)))))

; ---- the reducer ---------------------------------------------------------------------------------------
(= (apply-obs $ctx $st (O $id $kind $opl $oep $f))
   (let $prior (kv-get $id (sv $st seen))
     (if (not (== $prior none))
         (if (== $prior ($kind $f)) ($st duplicate) (rej $st conflicting-duplicate))
         (if (not (and (== $opl (ctx-plan $ctx)) (== $oep (ctx-epoch $ctx))))
             (rej $st wrong-plan)
             (let $st2 (sput $st seen (cons-atom ($id ($kind $f)) (sv $st seen)))
               (if (and (terminal? (sv $st phase)) (not (or (== $kind unknown) (== $kind reconciled))))
                   (rej $st2 terminal)
                   (if (== (arity-of $kind) -1) (rej $st2 unknown-kind)
                   (if (not (== (size-atom $f) (arity-of $kind))) (rej $st2 malformed-fields)
                       (go-drain (by-kind $ctx $st2 $kind $f))))))))))
(= (arity-of $k)   ; each kind's field count; a malformed observation is refused, never dropped from replay
   (case $k ((plan-started 1) (planned 5) (plan-failed 1) (designed 2) (dispatched 3) (tests-authored 2) (tests-detected 2)
             (piece-started 3) (piece-ready 2) (piece-blocked 1) (review-pass 3) (design-review-pass 4) (review-fail 3)
             (design-review-fail 4) (review-unavailable 2) (integrated 4) (merge-conflict 2) (check-pass 2) (check-fail 3)
             (check-unknown 1) (question-asked 2) (answered 3) (question-withdrawn 1) (preview-deployed 3) (preview-failed 1)
             (deploy-approved 2) (deployed 1) (deploy-refused 1) (cancelled 0) (unknown 1) (reconciled 1) ($o -1))))

(= (by-kind $ctx $st $kind $f)
   (case $kind
     ((plan-started (let ($op) $f (on-plan-started $ctx $st $op)))
      (planned (let ($op $pl $graph $unknowns $needs) $f (on-planned $ctx $st $op $pl $graph $unknowns $needs)))
      (plan-failed (let ($op) $f (on-plan-failed $ctx $st $op)))
      (designed (let ($op $ref) $f (on-designed $st $op $ref)))
      (dispatched (let ($op $k $s) $f (on-dispatched $ctx $st $op $k $s)))
      (tests-authored (let ($op $suite) $f (on-tests $st $op $suite author-tests)))
      (tests-detected (let ($op $suite) $f (on-tests $st $op $suite detect-tests)))
      (piece-started (let ($p $task $builder) $f (on-piece-started $ctx $st $p $task $builder)))
      (piece-ready (let ($p $c) $f (on-piece-ready $st $p $c)))
      (piece-blocked (let ($p) $f (on-piece-blocked $st $p)))
      (review-pass (let ($p $c $v) $f (on-review-pass $ctx $st review $p $c $v none)))
      (design-review-pass (let ($p $c $v $ev) $f (on-review-pass $ctx $st design-review $p $c $v $ev)))
      (review-fail (let ($p $c $v) $f (on-review-fail $ctx $st review $p $c $v none)))
      (design-review-fail (let ($p $c $v $ev) $f (on-review-fail $ctx $st design-review $p $c $v $ev)))
      (review-unavailable (let ($p $c) $f (on-review-unavailable $ctx $st $p $c)))
      (integrated (let ($op $p $c $ck) $f (on-integrated $st $op $p $c $ck)))
      (merge-conflict (let ($op $p) $f (on-merge-conflict $ctx $st $op $p)))
      (check-pass (let ($run $ck) $f (on-check-pass $st $run $ck)))
      (check-fail (let ($run $ck $files) $f (on-check-fail $ctx $st $run $ck $files)))
      (check-unknown (let ($run) $f (on-check-unknown $st $run)))
      (question-asked (let ($q $about) $f (on-question-asked $st $q $about)))
      (answered (let ($q $p $ref) $f (on-answered $ctx $st $q $p $ref)))
      (question-withdrawn (let ($q) $f (on-question-withdrawn $st $q)))
      (preview-deployed (let ($op $ck $url) $f (on-preview-deployed $st $op $ck $url)))
      (preview-failed (let ($op) $f (on-preview-failed $ctx $st $op)))
      (deploy-approved (let ($op $p) $f (on-deploy-approved $ctx $st $op $p)))
      (deployed (let ($op) $f (on-deployed $st $op)))
      (deploy-refused (let ($op) $f (on-deploy-refused $st $op)))
      (cancelled (acc (sput (sput (drain $st) go none) phase stopped)))   ; cleanup owed for everything open
      (unknown (let ($op) $f (on-unknown $st $op)))
      (reconciled (let ($op) $f (on-reconciled $st $op)))
      ($other (rej $st unknown-kind)))))

(= (on-plan-started $ctx $st $op)
   (if (not (fresh-op? $op $st)) (rej $st operation-id-reused)
   (if (not (== (sv $st phase) claimed)) (rej $st plan-not-due)
   (let $g (effect-gate $st) (if (not (== $g none)) (rej $st $g)
       (acc (add-entry (sput $st phase planning) ($op plan none))))))))

(= (valid-needs? $n) (case $n ((($d $t) (and (is-member $d (design no-design)) (is-member $t (author detect)))) ($o False))))
(= (unknowns-fault $us $graph)
   (if (not (== (filter-atom $us $u (case $u ((($q $a) (not (valid-about? $a $graph))) ($o True)))) ())) invalid_unknowns
   (if (has-dups? (map-atom $us $u (index-atom $u 0))) invalid_unknowns none)))
(= (on-planned $ctx $st $op $pl $graph $unknowns $needs)   ; pl: (Plan ref revision digest parent-digest), OmegaPlanner's shape
   (if (not (and (== (sv $st phase) planning) (in-ledger? ($op plan none) $st))) (rej $st not-the-open-plan)
   (case $pl
     (((Plan $ref $rev $digest $parent)
        (if (not (and (== $rev 1) (and (== $parent none) (and (not (== $ref none)) (not (== $digest none)))))) (rej $st stale_revision)
        (if (not (valid-needs? $needs)) (rej $st invalid_needs)
        (let $gf (graph-fault $graph) (if (not (== $gf none)) (rej $st $gf)
        (if (and (has-studio? $graph) (== (index-atom $needs 0) design)) (rej $st studio-pieces-carry-the-design)
        (let $uf (unknowns-fault $unknowns $graph) (if (not (== $uf none)) (rej $st $uf)
            (acc (drop-entry (sput (sput (sput (sput (sput (sput $st phase planned) plan ($ref $digest)) graph $graph) needs $needs)
                                     pieces (init-pieces $graph))
                               questions (map-atom $unknowns $u ((index-atom $u 0) (index-atom $u 1) raised)))
                             ($op plan none)))))))))))
      ($o (rej $st invalid_plan_object))))))

(= (bump-retries $ctx $st $held $why)
   (let $r (+ (sv $st retries) 1)
     (if (> $r (ctx-fix-cap $ctx)) (block (sput $st retries $r) $why $held) (sput $st retries $r))))

(= (on-plan-failed $ctx $st $op)
   (if (not (and (== (sv $st phase) planning) (in-ledger? ($op plan none) $st))) (rej $st not-the-open-plan)
       (let $s2 (sput (drop-entry $st ($op plan none)) phase claimed)
         (acc (bump-retries $ctx $s2 claimed (cap-exceeded plan-failed))))))

(= (on-designed $st $op $ref)
   (let $e (op-entry $op $st)
     (if (or (== $e none) (or (not (== (sv $st phase) designing)) (== $ref none))) (rej $st not-the-open-design)
     (if (not (== (index-atom $e 1) design)) (rej $st not-the-open-design)
         (acc (sput (sput (drop-entry $st $e) phase designed) design $ref))))))

(= (on-tests $st $op $suite $k)
   (let $e (op-entry $op $st)
     (if (or (== $e none) (== $suite none)) (rej $st not-the-open-test-request)
     (if (not (and (== (index-atom $e 1) $k) (tests-due? $st))) (rej $st not-the-open-test-request)
         (acc (sput (sput (drop-entry $st $e) phase testing-authored) suite $suite))))))

; dispatched: the journal entry for every host effect not journalled by its own kind
(= (on-dispatched $ctx $st $op $k $s)
   (if (not (fresh-op? $op $st)) (rej $st operation-id-reused)
   (let $g (effect-gate $st) (if (not (== $g none)) (rej $st $g)
   (let $why (dispatch-fault $ctx $st $k $s)
     (if (not (== $why none)) (rej $st $why)
         (acc (settle (after-dispatch (add-entry $st ($op $k $s)) $k $s)))))))))
(= (after-dispatch $st $k $s)
   (case $k
     ((design (sput $st phase designing))
      (route-fix (set-piece $st (with-status (piece $s $st) started)))
      ($o $st))))
(= (dispatch-fault $ctx $st $k $s)
   (let $ph (sv $st phase)
   (case $k
     ((design (if (and (== $ph planned) (== (index-atom (sv $st needs) 0) design)) none design-not-due))
      (author-tests (if (and (tests-due? $st) (and (== (index-atom (sv $st needs) 1) author) (not (or (kind-in-flight? author-tests $st) (kind-in-flight? detect-tests $st))))) none tests-not-due))
      (detect-tests (if (and (tests-due? $st) (and (== (index-atom (sv $st needs) 1) detect) (not (or (kind-in-flight? author-tests $st) (kind-in-flight? detect-tests $st))))) none tests-not-due))
      (run-checks (if (and (not (== (check-target $st) none)) (and (== $s (check-target $st)) (not (kind-in-flight? run-checks $st)))) none checks-not-due))
      (review (review-dispatch-fault $st code $s))
      (design-review (review-dispatch-fault $st studio $s))
      (integrate (case $s ((($p $c) (if (and (build-phase? $ph) (and (== (status-of $p $st) reviewed) (and (== (pc-cand (piece $p $st)) $c)
                                          (and (not (q-held? $p $st)) (not (kind-in-flight? integrate $st)))))) none integrate-not-due))
                            ($o integrate-not-due))))
      (route-fix (if (and (build-phase? $ph) (and (== (status-of $s $st) fixing) (and (not (q-held? $s $st)) (< (active-count $st) (ctx-lease $ctx)))))
                     none (if (== (status-of $s $st) fixing) (if (q-held? $s $st) awaiting-answer lease-full) route-not-due)))
      (preview (if (and (== $ph previewing) (and (== $s (sv $st ckpt)) (not (kind-in-flight? preview $st)))) none preview-not-due))
      ($o not-dispatchable)))))   ; plan, start and deploy are journalled by their own kinds
(= (review-dispatch-fault $st $team $s)
   (case $s ((($p $c) (if (and (build-phase? (sv $st phase)) (and (== (status-of $p $st) built) (and (== (pc-cand (piece $p $st)) $c)
                             (and (== (team-of $p (sv $st graph)) $team) (== (review-entry $p $c $st) none))))) none review-not-due))
             ($o review-not-due))))

(= (on-piece-started $ctx $st $p $task $builder)
   (if (not (fresh-op? $task $st)) (rej $st operation-id-reused)
   (let $g (effect-gate $st) (if (not (== $g none)) (rej $st $g)
   (if (or (not (build-phase? (sv $st phase))) (== $builder none)) (rej $st piece-not-startable)
   (let $r (piece $p $st)
     (if (== $r none) (rej $st piece-not-in-plan)
     (if (q-held? $p $st) (rej $st awaiting-answer)
     (if (not (startable? $r $st)) (rej $st piece-not-startable)
     (if (>= (active-count $st) (ctx-lease $ctx)) (rej $st lease-full)
         (acc (settle (add-entry (set-piece $st (with-status $r started)) ($task start $p))))))))))))))

(= (on-piece-ready $st $p $c)
   (let $e (piece-entry $p $st)
     (if (or (== $e none) (not (== (status-of $p $st) started))) (rej $st not-a-running-piece)
     (if (== $c none) (rej $st candidate-is-not-a-reference)
     (let $r (piece $p $st)
       (if (== $c (pc-cand $r)) (rej $st candidate-unchanged)
           (acc (settle (set-piece (drop-entry $st $e) (Pc $p built $c (pc-reps $r) (pc-fixrun $r) reviewed))))))))))

(= (on-piece-blocked $st $p)
   (let $e (piece-entry $p $st)
     (if (or (== $e none) (not (== (status-of $p $st) started))) (rej $st not-a-running-piece)
         (let $s2 (set-piece (drop-entry $st $e) (with-status (piece $p $st) fixing))
           (acc (block $s2 (piece-blocked $p) (sv (settle $s2) phase)))))))

(= (review-common $ctx $st $k $p $c $v $ev)   ; none, or why this review result is refused
   (let $e (review-entry $p $c $st)
     (if (or (== $e none) (not (== (status-of $p $st) built))) review-not-requested
     (if (not (== (index-atom $e 1) $k)) wrong-review-kind
     (if (not (independent? $v $ctx $st)) reviewer-not-independent
     (if (and (== $k design-review) (== $ev none)) design-review-needs-render-evidence
         none))))))
(= (on-review-pass $ctx $st $k $p $c $v $ev)
   (let $why (review-common $ctx $st $k $p $c $v $ev)
     (if (not (== $why none)) (rej $st $why)
         (acc (settle (set-piece (drop-entry $st (review-entry $p $c $st)) (with-status (piece $p $st) reviewed)))))))
(= (on-review-fail $ctx $st $k $p $c $v $ev)   ; a refuted piece goes back to its own team for a fix
   (let $why (review-common $ctx $st $k $p $c $v $ev)
     (if (not (== $why none)) (rej $st $why)
         (let* (($e (review-entry $p $c $st)) ($s2 (drop-entry $st $e)))
           (acc (route-pieces $ctx $s2 ($p) (index-atom $e 0) False))))))
(= (on-review-unavailable $ctx $st $p $c)   ; never a pass
   (let $e (review-entry $p $c $st)
     (if (or (== $e none) (not (== (status-of $p $st) built))) (rej $st review-not-requested)
         (let $s2 (drop-entry $st $e)
           (if (== (ctx-policy $ctx) review-waivable)
               ((settle (set-piece $s2 (Pc $p reviewed $c (pc-reps (piece $p $st)) (pc-fixrun (piece $p $st)) unreviewed))) (accepted (review-unavailable waived)))
               ((block $s2 (review-unavailable $p) (sv $st phase)) (accepted (review-unavailable blocked))))))))

(= (route-pieces $ctx $st $ps $run $plan-round)   ; mark each owner fixing, count its repair, check both caps
   (let* (($s1 (if $plan-round (sput $st rounds (+ (sv $st rounds) 1)) $st))
          ($s2 (foldl-atom $ps $s1 $acc $p (let $r (piece $p $acc) (set-piece $acc (Pc $p fixing (pc-cand $r) (+ (pc-reps $r) 1) $run (pc-mark $r)))))))
     (if (> (sv $s2 rounds) (ctx-fix-cap $ctx)) (block (sput $s2 phase fixing) (cap-exceeded fix-rounds) fixing)
     (if (not (== (filter-atom (sv $s2 pieces) $r (> (index-atom $r 4) (ctx-piece-cap $ctx))) ()))
         (block (settle (sput $s2 phase building)) (cap-exceeded piece-repairs) (sv (settle (sput $s2 phase building)) phase))
         (settle (sput $s2 phase building))))))

(= (on-integrated $st $op $p $c $ck)
   (if (not (in-ledger? ($op integrate ($p $c)) $st)) (rej $st not-the-open-integration)
   (if (or (== $ck none) (or (== $ck base) (== $ck (sv $st ckpt)))) (rej $st checkpoint-not-new)
       (acc (settle (sput (set-piece (drop-entry $st ($op integrate ($p $c))) (with-status (piece $p $st) integrated)) ckpt $ck))))))

(= (on-merge-conflict $ctx $st $op $p)
   (let $e (op-entry $op $st)
     (if (== $e none) (rej $st not-the-open-integration)
     (if (not (and (== (index-atom $e 1) integrate) (== (index-atom (index-atom $e 2) 0) $p))) (rej $st not-the-open-integration)
         (acc (route-pieces $ctx (drop-entry $st $e) ($p) $op False))))))

(= (on-check-pass $st $run $ck)
   (if (not (and (in-ledger? ($run run-checks $ck) $st) (== $ck (check-target $st)))) (rej $st run-not-dispatched-for-this-checkpoint)
       (let $s2 (drop-entry $st ($run run-checks $ck))
         (if (== (sv $st phase) testing-authored)   ; a green scaffold: the suite proves nothing; author again with the person
             (acc (block (sput $s2 suite none) tests-not-red (if (== (sv $st design) none) planned designed)))
             (acc (sput $s2 phase previewing))))))
(= (on-check-fail $ctx $st $run $ck $files)
   (if (not (and (in-ledger? ($run run-checks $ck) $st) (== $ck (check-target $st)))) (rej $st run-not-dispatched-for-this-checkpoint)
   (if (== $files ()) (rej $st failure-names-no-file)
       (let $s2 (drop-entry $st ($run run-checks $ck))
         (if (== (sv $st phase) testing-authored)
             (acc (settle (sput $s2 phase building)))   ; the real red against the scaffold
             (let $owners (unique-atom (map-atom $files $x (owner-of $x (sv $st graph))))
               (if (is-member none $owners) (acc (block $s2 (unrouted-failure $files) checking))
                   (acc (route-pieces $ctx $s2 $owners $run True)))))))))
(= (on-check-unknown $st $run)
   (let $e (op-entry $run $st)
     (if (== $e none) (rej $st run-not-dispatched-for-this-checkpoint)
     (if (not (== (index-atom $e 1) run-checks)) (rej $st run-not-dispatched-for-this-checkpoint)
         (acc (sput (drop-entry $st $e) unres (cons-atom $e (sv $st unres))))))))

(= (on-question-asked $st $q $about)
   (let $e (q-of $q $st)
     (if (not (== $e none))
         (if (and (== (index-atom $e 2) raised) (== (index-atom $e 1) $about)) (acc (clear-go-for $about (set-q $st $q asked))) (rej $st question-id-reused))
     (if (== $q none) (rej $st question-id-reused)
     (if (== $about blocked)
         (if (and (== (sv $st phase) blocked) (not (open-about? blocked $st))) (acc (sput $st questions (cons-atom ($q blocked asked) (sv $st questions)))) (rej $st not-blocked))
     (if (valid-about? $about (sv $st graph))
         (acc (clear-go-for $about (sput $st questions (cons-atom ($q $about asked) (sv $st questions)))))
         (rej $st invalid-question-subject)))))))
(= (clear-go-for $about $st) (if (or (== $about deploy) (== $about plan)) (sput $st go none) $st))   ; new doubt withdraws consent
(= (on-answered $ctx $st $q $p $ref)
   (let $e (q-of $q $st)
     (if (== $e none) (rej $st not-an-open-question)
     (if (not (== (index-atom $e 2) asked)) (rej $st not-an-open-question)
     (if (not (and (== $p (ctx-person $ctx)) (not (is-member $p (ctx-authors $ctx))))) (rej $st not-the-person)
     (if (== $ref none) (rej $st answer-is-not-a-reference)
         (let $s2 (sput (set-q $st $q closed) answers (cons-atom ($q $ref) (sv $st answers)))
           (if (== (index-atom $e 1) blocked)   ; only the person's answer releases a hold, with fresh allowances
               (acc (settle (reset-caps (sput (sput (sput $s2 phase (sv $st held)) held none) why none))))
               (acc $s2)))))))))
(= (on-question-withdrawn $st $q)
   (let $e (q-of $q $st)
     (if (== $e none) (rej $st not-an-open-question)
     (if (not (open-q? $e)) (rej $st not-an-open-question)
     (if (== (index-atom $e 1) blocked) (rej $st hold-needs-the-persons-answer)
         (acc (set-q $st $q closed)))))))

(= (on-preview-deployed $st $op $ck $url)
   (if (not (and (== (sv $st phase) previewing) (and (in-ledger? ($op preview $ck) $st) (== $ck (sv $st ckpt))))) (rej $st not-the-open-preview)
   (if (== $url none) (rej $st preview-is-not-a-reference)
       (acc (sput (sput (drop-entry $st ($op preview $ck)) phase ready-to-deploy) preview ($ck $url))))))
(= (on-preview-failed $ctx $st $op)
   (let $e (op-entry $op $st)
     (if (== $e none) (rej $st not-the-open-preview)
     (if (not (== (index-atom $e 1) preview)) (rej $st not-the-open-preview)
         (acc (bump-retries $ctx (drop-entry $st $e) previewing (cap-exceeded preview-failed)))))))

(= (on-deploy-approved $ctx $st $op $p)   ; the person's go journals the deploy (ledger) before any effect
   (if (not (fresh-op? $op $st)) (rej $st operation-id-reused)
   (if (not (and (== $p (ctx-person $ctx)) (not (is-member $p (ctx-authors $ctx))))) (rej $st not-the-person)
   (if (not (== (sv $st phase) ready-to-deploy)) (rej $st not-ready-to-deploy)
   (let $g (effect-gate $st) (if (not (== $g none)) (rej $st $g)
   (if (open-about? deploy $st) (rej $st awaiting-answer)
   (if (not (and (== (sv $st go) none) (== (sv $st ledger) ()))) (rej $st something-else-open)
   (let $pv (sv $st preview)
     (if (if (== $pv none) True (not (== (index-atom $pv 0) (sv $st ckpt)))) (rej $st preview-not-current)
         (acc (add-entry (sput $st go ($op (sv $st ckpt) $p)) ($op deploy (sv $st ckpt))))))))))))))
(= (on-deployed $st $op)
   (let $go (sv $st go)
     (if (if (== $go none) True (not (== (index-atom $go 0) $op))) (rej $st deploy-not-approved-by-the-person)
     (if (not (and (== (sv $st phase) ready-to-deploy) (and (== (sv $st ledger) (($op deploy (sv $st ckpt)))) (== (sv $st unres) ()))))
         (rej $st deploy-not-approved-by-the-person)
         (acc (sput (sput $st phase deployed) ledger ()))))))
(= (on-deploy-refused $st $op)
   (let $go (sv $st go)
     (if (if (== $go none) True (not (and (== (index-atom $go 0) $op) (in-ledger? ($op deploy (sv $st ckpt)) $st)))) (rej $st not-the-approved-deploy)
         (acc (sput (drop-entry $st ($op deploy (sv $st ckpt))) go none)))))

(= (on-unknown $st $op)
   (if (is-member $op (unres-ops $st)) (rej $st already-unresolved)
       (let* (($e (op-entry $op $st)) ($ent (if (== $e none) ($op host none) $e)) ($s2 (if (== $e none) $st (drop-entry $st $e))))
         (let $go (sv $st go)
           (acc (sput (if (if (== $go none) False (== (index-atom $go 0) $op)) (sput $s2 go none) $s2) unres (cons-atom $ent (sv $s2 unres))))))))
(= (on-reconciled $st $op)   ; the readback resolves the operation; it restores its piece but never releases a hold
   (let $m (filter-atom (sv $st unres) $e (== (index-atom $e 0) $op))
     (if (== $m ()) (rej $st not-an-unresolved-operation)
         (let* (($e (car-atom $m)) ($s2 (sput $st unres (without $e (sv $st unres)))))
           (acc (settle (restore $s2 (index-atom $e 1) (index-atom $e 2))))))))
(= (restore $st $k $s)
   (case $k
     ((start (if (== (status-of $s $st) started) (set-piece $st (with-status (piece $s $st) waiting)) $st))
      (route-fix (if (== (status-of $s $st) started) (set-piece $st (with-status (piece $s $st) fixing)) $st))
      (plan (if (== (sv $st phase) planning) (sput $st phase claimed) $st))
      (design (if (== (sv $st phase) designing) (sput $st phase planned) $st))
      ($o $st))))

(= (replay $ctx $state $log)
   (if (== $log ()) $state
       (let ($s2 $v) (apply-obs $ctx $state (car-atom $log)) (replay $ctx $s2 (cdr-atom $log)))))
(= (receipts $ctx $state $log)
   (if (== $log ()) ()
       (let ($s2 $v) (apply-obs $ctx $state (car-atom $log)) (cons-atom $v (receipts $ctx $s2 (cdr-atom $log))))))
(= (phase-of $st) (sv $st phase))

; ---- next action: unresolved effects first, then questions, then the phase's own work -----------------
(= (next-action $ctx $st)
   (if (not (== (sv $st unres) ())) (do (reconcile (index-atom (car-atom (sv $st unres)) 0)))
   (let $ph (sv $st phase)
   (if (== $ph deployed) (rest done)
   (if (== $ph stopped) (rest stopped)
   (let $rq (first-raised $st)
   (if (not (== $rq none)) (tell ask-person $rq)
   (if (== $ph blocked) (if (open-about? blocked $st) (rest awaiting-answer) (tell ask-person (blocked (sv $st why))))
   (if (open-about? plan $st) (if (== (sv $st ledger) ()) (rest awaiting-answer) (rest awaiting-results))
       (phase-action $ctx $st $ph))))))))))
(= (tests-action $st)
   (if (or (kind-in-flight? author-tests $st) (kind-in-flight? detect-tests $st)) (rest awaiting-results)
       (if (== (index-atom (sv $st needs) 1) author) (think author-acceptance-tests) (do (detect-tests)))))
(= (phase-action $ctx $st $ph)
   (case $ph
     ((claimed (think make-the-plan))
      (planning (rest awaiting-planner))
      (planned (if (== (index-atom (sv $st needs) 0) design) (think make-the-design) (tests-action $st)))
      (designing (rest awaiting-results))
      (designed (tests-action $st))
      (testing-authored (if (kind-in-flight? run-checks $st) (rest awaiting-results) (do (run-checks base))))
      (checking (if (kind-in-flight? run-checks $st) (rest awaiting-results) (do (run-checks (sv $st ckpt)))))
      (previewing (if (kind-in-flight? preview $st) (rest awaiting-results) (do (preview-deploy (sv $st ckpt)))))
      (ready-to-deploy
        (if (open-about? deploy $st) (rest awaiting-answer)
        (let $go (sv $st go)
          (if (== $go none)
              (if (== (filter-atom (sv $st pieces) $r (== (index-atom $r 6) unreviewed)) ()) (tell confirm-deploy (ctx-plan $ctx)) (tell confirm-unreviewed-deploy (ctx-plan $ctx)))
              (if (== (sv $st ledger) (((index-atom $go 0) deploy (sv $st ckpt)))) (do (deploy (index-atom $go 0))) (rest awaiting-results))))))
      ($o (if (build-phase? $ph) (build-action $ctx $st) (rest needs-person))))))
(= (free-pieces $s $st) (filter-atom (pieces-with $s $st) $r (not (q-held? (index-atom $r 1) $st))))
(= (build-action $ctx $st)
   (let* (($fix (free-pieces fixing $st)) ($built (filter-atom (free-pieces built $st) $r (== (review-entry (index-atom $r 1) (index-atom $r 3) $st) none)))
          ($rev (free-pieces reviewed $st)) ($starts (may-start $ctx $st)))
     (if (and (not (== $fix ())) (< (active-count $st) (ctx-lease $ctx))) (do (route-fix (index-atom (car-atom $fix) 1) (index-atom (car-atom $fix) 5)))
     (if (not (== $built ()))
         (let $r (car-atom $built)
           (if (== (team-of (index-atom $r 1) (sv $st graph)) studio) (do (request-design-review (index-atom $r 1) (index-atom $r 3))) (do (request-review (index-atom $r 1) (index-atom $r 3)))))
     (if (and (not (== $rev ())) (not (kind-in-flight? integrate $st))) (do (integrate (index-atom (car-atom $rev) 1) (index-atom (car-atom $rev) 3)))
     (if (not (== $starts ())) (do (start-piece (car-atom $starts)))
     (if (not (== (sv $st ledger) ())) (rest awaiting-pieces)
     (if (not (== (filter-atom (sv $st questions) $e (open-q? $e)) ())) (rest awaiting-answer)
         (rest needs-person)))))))))

(= (needs-model (think $g)) True)
(= (needs-model (do $x)) False)
(= (needs-model (tell $x $y)) False)
(= (needs-model (rest $w)) False)
