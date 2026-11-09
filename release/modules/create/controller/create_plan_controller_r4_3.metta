; Create plan controller R4.3 (Dot; R4.2, R4.1 and R4.0 stay beside it unchanged).
;   One rule added to R4.2's: no piece may own the acceptance suite or a reserved path, so no build can edit the checks
;   that judge it. tests-authored / tests-detected (op suite (check-paths...)) name the suite's paths; they are refused
;   when any piece's files include one (piece-owns-suite-file). The plan may carry (Reserved path...) atoms (data, e.g.
;   import-shadowing paths); planned is refused when any piece's files include one (piece-owns-reserved-path). Reducer
;   symbols (none True False Empty) are never artifact kinds (reducer-symbol-kind).
; Plan needs: (Needs design-need tests-mode (ReviewFor...) (AssigneeCap...) (Reserved path...)...)
; Was R4.2 (Dot; R4.1 and R4.0 stay beside it unchanged).
;   One invariant added to R4.1's: every retry is bounded. Each lost operation of any kind (plan, design, author-tests,
;   detect-tests, run-checks, start, route-fix, review, integrate, preview, and host effects outside the ledger), once
;   reconciled, spends one unit of the plan's retry budget (Ctx Caps, third field), shared with failed plans and failed
;   previews; past it the plan blocks and asks the person. A deploy is never retried by the reducer: its readback is
;   deployed-confirmed or reconciled-not-deployed, and any new deploy needs a fresh go from the person. Every other path
;   that repeats work is bounded by a cap (piece repairs, fix rounds, retries) or passes through the person.
; Ctx: (Ctx plan epoch person (authors...) (Caps piece-repairs fix-rounds retries) budget review-policy (ReviewFor...))
; Was R4.1 (Dot, at Jon's direction: "we always generalise the rules"); only start, route-fix and run-checks losses counted.
;   One invariant, as R4.0: a plan reaches `deployed` only through the person's own go on a previewed, checked checkpoint
;   whose every piece was built after a red acceptance check, passed every review its artifact kinds require, and was
;   integrated; every step toward delivery is journalled before its effect under a lifetime-unique operation id; and
;   uncertainty (unknown, reconciled, a withdrawal, a late, forged, malformed or non-ground observation) never releases a
;   hold or skips a step. The reducer always returns exactly one state: anything it cannot read is refused, never dropped.
;   1. Assignee is data: (Assignee team swarm) | (Assignee mind agent) | (Assignee capability cap) | (Assignee hive hive cap)
;      | (Assignee open cap) (any mind or team offering cap, the whole hive included). The host resolves it and journals
;      piece-started (p task builder resolved); a mind or team selector must resolve to exactly itself, a hive selector to
;      that hive. assignee-unavailable (p) holds the piece and asks the person (no silent fallback); the person's answer
;      returns it to the queue.
;   2. The artifact kind decides the review: a piece declares the kinds it produces; (ReviewFor kind review-kind evidence)
;      atoms in Ctx (the hive's catalogue) plus any the plan adds (it may add, never remove) say which reviews it needs and
;      what evidence each needs (none, or e.g. render: an evidence atom (render ref)). A kind with no ReviewFor makes the
;      plan invalid. One result pair, review-pass / review-fail (p cand review-kind reviewer evidence), is checked against
;      those atoms; a piece is reviewed when every review kind it needs has passed.
;   3. Parallelism: the budget is Ctx data; the plan may cap any selector with (AssigneeCap selector n). may-start folds
;      both limits over the graph; piece-started and route-fix past either are refused.
;   4. Reviewers: never in the Ctx author set, never a builder or repairer the journal names (piece-started, route-fix),
;      never the person.
;   5. A plan whose pieces produce `design` carries its design in them (no serial design phase).
;   Review fixes on R4.0 (BLOCK, folded in): B1 observations must be ground and fit their kind's field shape, plans are
;   checked to the leaf (symbol ids, lists of symbols); B2 piece-ready / piece-blocked name the task or route-fix op they
;   answer; S3 only the person withdraws a question; S4 a deploy of unknown fate is settled only by its own readback
;   (deployed-confirmed / reconciled-not-deployed, R3.13's pattern), never by a plain reconcile; S5 any open question
;   holds the go and a new question clears it. Nits: checkpoint ids are never reused; the repairer is named; review
;   dispatch respects question holds; the go records the form the person confirmed; lost start, route-fix and check
;   operations count against the plan's retry budget (liveness).
; Plan needs: (Needs design-need tests-mode (ReviewFor...) (AssigneeCap...)); graph node: (Piece id assignee (kinds) (deps) (files))
; Piece record: (Pc id status cand repairs fixrun mark passed resolved);
;   status waiting|started|fixing|built|reviewed|integrated|(unassignable prior). Observation: (O id kind plan epoch fields).
; Was R4.0: teams as an enum (studio, code), per-team review kinds, the lease as a single constant.

(= (start-state) ((phase claimed) (held none) (why none) (plan none) (graph ()) (needs (none none)) (design none)
                  (suite none) (pieces ()) (ckpt none) (ckpts ()) (rounds 0) (retries 0) (questions ()) (answers ())
                  (preview none) (go none) (reviews ()) (caps ()) (reserved ()) (suite-paths ()) (ledger ()) (unres ()) (seen ())))

; ---- generic helpers ---------------------------------------------------------------------------------------
(= (kv-get $k $xs) (if (== $xs ()) none (let ($kk $v) (car-atom $xs) (if (== $kk $k) $v (kv-get $k (cdr-atom $xs))))))
(= (sv $st $k) (kv-get $k $st))
(= (sput $st $k $v) (map-atom $st $e (let ($kk $vv) $e (if (== $kk $k) ($k $v) $e))))
(= (has? $x $xs) (if (is-expr $xs) (not (== (filter-atom $xs $y (== $y $x)) ())) False))   ; PeTTa's is-member is member/2: one result per duplicate, and it unifies variables
(= (all-in $xs $ys) (if (== $xs ()) True (if (has? (car-atom $xs) $ys) (all-in (cdr-atom $xs) $ys) False)))
(= (without $x $xs) (filter-atom $xs $y (not (== $y $x))))
(= (count-of $xs) (size-atom $xs))
(= (has-dups? $xs) (not (== (size-atom (unique-atom $xs)) (size-atom $xs))))
(= (flatten1 $xss) (if (== $xss ()) () (append (car-atom $xss) (flatten1 (cdr-atom $xss)))))
(= (acc $st) ($st accepted))
(= (rej $st $why) ($st (rejected $why)))
; B1: shapes. atomic = a symbol or grounded value; never a variable or an expression
(= (atomic? $x) (has? (get-metatype $x) (Symbol Grounded)))
(= (ref? $x) (if (atomic? $x) (not (== $x none)) False))
(= (num? $x) (== (get-type $x) Number))
(= (atoms? $xs) (if (is-expr $xs) (== (filter-atom $xs $x (not (atomic? $x))) ()) False))   ; a list of atomics
(= (fits-spec? $spec $f)   ; a = atomic, l = list of atomics, s = atomic or list of atomics, x = any (checked by its kind)
   (if (== $spec ()) (== $f ())
   (if (not (is-expr $f)) False
   (if (== $f ()) False
   (let $k (car-atom $spec)
     (if (case $k ((a (atomic? (car-atom $f))) (l (atoms? (car-atom $f))) (s (or (atomic? (car-atom $f)) (atoms? (car-atom $f)))) ($o True)))
         (fits-spec? (cdr-atom $spec) (cdr-atom $f)) False))))))
(= (shape-of $k)   ; each kind's field shape; a kind not listed is unknown
   (case $k ((plan-started (a)) (planned (a x x x x)) (plan-failed (a)) (designed (a a)) (dispatched (a a s))
             (tests-authored (a a l)) (tests-detected (a a l)) (piece-started (a a a s)) (piece-ready (a a a)) (piece-blocked (a a))
             (assignee-unavailable (a)) (review-pass (a a a a s)) (review-fail (a a a a s)) (review-unavailable (a a a))
             (integrated (a a a a)) (merge-conflict (a a)) (check-pass (a a)) (check-fail (a a l)) (check-unknown (a))
             (question-asked (a s)) (answered (a a a)) (question-withdrawn (a a)) (preview-deployed (a a a)) (preview-failed (a))
             (deploy-approved (a a a)) (deployed (a)) (deploy-refused (a)) (deployed-confirmed (a a)) (reconciled-not-deployed (a))
             (cancelled ()) (unknown (a)) (reconciled (a)) ($o none))))

(= (ctx-plan (Ctx $pl $ep $pe $au $caps $b $pol $rf)) $pl)
(= (ctx-epoch (Ctx $pl $ep $pe $au $caps $b $pol $rf)) $ep)
(= (ctx-person (Ctx $pl $ep $pe $au $caps $b $pol $rf)) $pe)
(= (ctx-authors (Ctx $pl $ep $pe $au $caps $b $pol $rf)) $au)
(= (ctx-piece-cap (Ctx $pl $ep $pe $au (Caps $pc $fc $rc) $b $pol $rf)) $pc)
(= (ctx-fix-cap (Ctx $pl $ep $pe $au (Caps $pc $fc $rc) $b $pol $rf)) $fc)
(= (ctx-retry-cap (Ctx $pl $ep $pe $au (Caps $pc $fc $rc) $b $pol $rf)) $rc)
(= (ctx-budget (Ctx $pl $ep $pe $au $caps $b $pol $rf)) $b)
(= (ctx-policy (Ctx $pl $ep $pe $au $caps $b $pol $rf)) $pol)
(= (ctx-reviews (Ctx $pl $ep $pe $au $caps $b $pol $rf)) $rf)

; ---- assignees and reviews are data ------------------------------------------------------------------------
(= (assignee-ok? $a)
   (case $a (((Assignee team $r) (ref? $r)) ((Assignee mind $r) (ref? $r)) ((Assignee capability $r) (ref? $r))
             ((Assignee hive $h $c) (if (ref? $h) (ref? $c) False)) ((Assignee open $c) (ref? $c)) ($o False))))
(= (fits? $sel $res)   ; does the host's resolution honour the selector?
   (if (== $res none) False
   (case $sel (((Assignee mind $m) (== $res (mind $m)))
               ((Assignee team $t) (== $res (team $t)))
               ((Assignee hive $h $c) (case $res (((hive $h2 $x) (== $h2 $h)) ($o2 False))))
               ($o True)))))
(= (review-for-ok? $r) (case $r (((ReviewFor $k $rk $ev) (if (ref? $k) (if (ref? $rk) (atomic? $ev) False) False)) ($o False))))
(= (cap-ok? $c) (case $c (((AssigneeCap $sel $n) (if (assignee-ok? $sel) (if (num? $n) (> $n 0) False) False)) ($o False))))
(= (required-reviews $p $st)   ; the review kinds a piece needs, from the ReviewFor atoms of its artifact kinds
   (let $ks (kinds-of $p (sv $st graph))
     (unique-atom (map-atom (filter-atom (sv $st reviews) $r (has? (index-atom $r 1) $ks)) $r (index-atom $r 2)))))
(= (evidence-for $p $rk $st)   ; the evidence that review needs: none, or a kind such as render
   (let $ks (kinds-of $p (sv $st graph))
     (let $m (filter-atom (sv $st reviews) $r (and (has? (index-atom $r 1) $ks) (and (== (index-atom $r 2) $rk) (not (== (index-atom $r 3) none)))))
       (if (== $m ()) none (index-atom (car-atom $m) 3)))))
(= (evidence-ok? $need $ev)
   (if (== $need none) True (case $ev ((($k $r) (if (== $k $need) (ref? $r) False)) ($o False)))))

; ---- the plan graph (atoms) --------------------------------------------------------------------------------
(= (node-of $p $graph) (let $m (filter-atom $graph $n (== (index-atom $n 1) $p)) (if (== $m ()) none (car-atom $m))))
(= (assignee-of $p $graph) (let $n (node-of $p $graph) (if (== $n none) none (index-atom $n 2))))
(= (kinds-of $p $graph) (let $n (node-of $p $graph) (if (== $n none) () (index-atom $n 3))))
(= (deps-of $p $graph) (let $n (node-of $p $graph) (if (== $n none) () (index-atom $n 4))))
(= (graph-ids $graph) (map-atom $graph $n (index-atom $n 1)))
(= (well-formed-node? $n)   ; B1: checked to the leaf
   (case $n (((Piece $p $a $ks $ds $fs)
               (if (ref? $p) (if (assignee-ok? $a) (if (atoms? $ks) (if (== $ks ()) False (if (atoms? $ds) (if (atoms? $fs) (not (== $fs ())) False) False)) False) False) False))
             ($o False))))
(= (kahn $rem $done)   ; acyclic iff repeatedly removing pieces whose deps are done empties the graph
   (if (== $rem ()) True
       (let $free (filter-atom $rem $n (all-in (index-atom $n 4) $done))
         (if (== $free ()) False
             (kahn (filter-atom $rem $n (not (has? $n $free))) (append (graph-ids $free) $done))))))
(= (graph-fault $graph)   ; OmegaPlanner validate_plan refusal codes, in its order
   (if (not (is-expr $graph)) invalid_plan_object
   (if (== $graph ()) step_count_limit
   (if (not (== (filter-atom $graph $n (not (well-formed-node? $n))) ())) invalid_step
   (if (has-dups? (graph-ids $graph)) duplicate_step
   (if (not (== (filter-atom $graph $n (has-dups? (index-atom $n 4))) ())) invalid_dependencies
   (if (not (all-in (flatten1 (map-atom $graph $n (index-atom $n 4))) (graph-ids $graph))) unknown_dependency
   (if (not (kahn $graph ())) dependency_cycle
   (if (has-dups? (flatten1 (map-atom $graph $n (index-atom $n 5)))) file_owned_twice
       none)))))))))
(= (owner-of $file $graph)   ; a failing file routes to the piece that owns it
   (let $m (filter-atom $graph $n (has? $file (index-atom $n 5))) (if (== $m ()) none (index-atom (car-atom $m) 1))))
(= (has-design-pieces? $graph) (has? design (flatten1 (map-atom $graph $n (index-atom $n 3)))))
(= (kinds-reviewable? $graph $reviews)
   (all-in (flatten1 (map-atom $graph $n (index-atom $n 3))) (map-atom $reviews $r (index-atom $r 1))))

; ---- piece records -------------------------------------------------------------------------------------
(= (pc-id $r) (index-atom $r 1))
(= (pc-status $r) (index-atom $r 2))
(= (pc-cand $r) (index-atom $r 3))
(= (pc-reps $r) (index-atom $r 4))
(= (pc-fixrun $r) (index-atom $r 5))
(= (pc-mark $r) (index-atom $r 6))
(= (pc-passed $r) (index-atom $r 7))
(= (pc-resolved $r) (index-atom $r 8))
(= (piece-rec $p $st) (let $m (filter-atom (sv $st pieces) $r (== (index-atom $r 1) $p)) (if (== $m ()) none (car-atom $m))))
(= (status-of $p $st) (let $r (piece-rec $p $st) (if (== $r none) none (pc-status $r))))
(= (set-piece $st $new) (sput $st pieces (map-atom (sv $st pieces) $r (if (== (index-atom $r 1) (index-atom $new 1)) $new $r))))
(= (with-status $r $s) (Pc (pc-id $r) $s (pc-cand $r) (pc-reps $r) (pc-fixrun $r) (pc-mark $r) (pc-passed $r) (pc-resolved $r)))
(= (pieces-with $s $st) (filter-atom (sv $st pieces) $r (== (index-atom $r 2) $s)))
(= (active-count $st) (count-of (pieces-with started $st)))
(= (init-pieces $graph) (map-atom $graph $n (Pc (index-atom $n 1) waiting none 0 none reviewed () none)))
(= (unassignable? $s) (case $s (((unassignable $x) True) ($o False))))
(= (assignee-count $sel $st)   ; started pieces under one declared selector
   (count-of (filter-atom (pieces-with started $st) $r (== (assignee-of (index-atom $r 1) (sv $st graph)) $sel))))
(= (assignee-cap $sel $st)
   (let $m (filter-atom (sv $st caps) $c (== (index-atom $c 1) $sel)) (if (== $m ()) none (index-atom (car-atom $m) 2))))
(= (assignee-room? $sel $st $extra)
   (let $cap (assignee-cap $sel $st) (if (== $cap none) True (< (+ (assignee-count $sel $st) $extra) $cap))))

; ---- questions: (q about status), about: (piece p) | plan | deploy | blocked; status raised|asked|closed ----
(= (q-of $q $st) (let $m (filter-atom (sv $st questions) $e (== (index-atom $e 0) $q)) (if (== $m ()) none (car-atom $m))))
(= (open-q? $e) (not (== (index-atom $e 2) closed)))
(= (any-open-q? $st) (not (== (filter-atom (sv $st questions) $e (open-q? $e)) ())))
(= (open-about? $about $st) (not (== (filter-atom (sv $st questions) $e (and (open-q? $e) (== (index-atom $e 1) $about))) ())))
(= (first-raised $st) (let $m (filter-atom (sv $st questions) $e (== (index-atom $e 2) raised)) (if (== $m ()) none (index-atom (car-atom $m) 0))))
(= (set-q $st $q $status) (sput $st questions (map-atom (sv $st questions) $e (if (== (index-atom $e 0) $q) ((index-atom $e 0) (index-atom $e 1) $status) $e))))
(= (valid-about? $about $graph)
   (case $about (((piece $p) (not (== (node-of $p $graph) none))) (plan True) (deploy True) ($o False))))
(= (q-held? $p $st)   ; a question about p, or about anything p depends on, holds p (dependent work only)
   (if (open-about? (piece $p) $st) True (q-held-any? (deps-of $p (sv $st graph)) $st)))
(= (q-held-any? $ps $st) (if (== $ps ()) False (if (q-held? (car-atom $ps) $st) True (q-held-any? (cdr-atom $ps) $st))))

; ---- the parallelism query: pieces that may start now, under the budget and the per-assignee caps --------
(= (startable? $r $st)
   (and (== (pc-status $r) waiting)
        (and (all-in (deps-of (pc-id $r) (sv $st graph)) (map-atom (pieces-with integrated $st) $x (index-atom $x 1)))
             (not (q-held? (pc-id $r) $st)))))
(= (may-start $ctx $st)
   (pick (- (ctx-budget $ctx) (active-count $st)) (map-atom (filter-atom (sv $st pieces) $r (startable? $r $st)) $r (index-atom $r 1)) () $st))
(= (pick $n $ps $chosen $st)
   (if (or (<= $n 0) (== $ps ())) $chosen
       (let* (($p (car-atom $ps)) ($sel (assignee-of $p (sv $st graph)))
              ($same (count-of (filter-atom $chosen $x (== (assignee-of $x (sv $st graph)) $sel)))))
         (if (assignee-room? $sel $st $same)
             (pick (- $n 1) (cdr-atom $ps) (append $chosen ($p)) $st)
             (pick $n (cdr-atom $ps) $chosen $st)))))

; ---- ledger: (op kind subject); unresolved keeps whole entries so a readback can restore its piece -------
(= (in-ledger? $e $st) (has? $e (sv $st ledger)))
(= (op-entry $op $st) (let $m (filter-atom (sv $st ledger) $e (== (index-atom $e 0) $op)) (if (== $m ()) none (car-atom $m))))
(= (unres-entry $op $st) (let $m (filter-atom (sv $st unres) $e (== (index-atom $e 0) $op)) (if (== $m ()) none (car-atom $m))))
(= (entry-for $kind $subj $st) (let $m (filter-atom (sv $st ledger) $e (and (== (index-atom $e 1) $kind) (== (index-atom $e 2) $subj))) (if (== $m ()) none (car-atom $m))))
(= (kind-in-flight? $kind $st) (not (== (filter-atom (sv $st ledger) $e (== (index-atom $e 1) $kind)) ())))
(= (entry-piece $e)   ; the piece a start or route-fix entry builds, else none
   (case $e ((($o start $p) $p) (($o route-fix ($p $b)) $p) ($x none))))
(= (review-entry $p $c $rk $st) (entry-for review ($p $c $rk) $st))
(= (reviews-in-flight $p $c $st)
   (map-atom (filter-atom (sv $st ledger) $e (case $e ((($o review ($p2 $c2 $k2)) (and (== $p2 $p) (== $c2 $c))) ($x False))))
             $e (index-atom (index-atom $e 2) 2)))
(= (add-entry $st $e) (sput $st ledger (cons-atom $e (sv $st ledger))))
(= (drop-entry $st $e) (sput $st ledger (without $e (sv $st ledger))))
(= (drain $st) (sput (sput $st unres (append (sv $st ledger) (sv $st unres))) ledger ()))   ; readback is never lost
(= (op-uses $op $seen)   ; operation ids are unique for the plan's lifetime, across every journalled kind
   (if (== $seen ()) 0
       (let ($i $b) (car-atom $seen)
         (+ (case $b (((plan-started ($op)) 1) ((dispatched ($op $k $s)) 1) ((piece-started ($p $op $h $rs)) 1)
                      ((deploy-approved ($op $pp $fm)) 1) ($o 0)))
            (op-uses $op (cdr-atom $seen))))))
(= (fresh-op? $op $st) (and (ref? $op) (<= (op-uses $op (sv $st seen)) 1)))   ; seen already holds this one
(= (builder-named? $v $seen)   ; any builder or repairer the journal ever named (rejected ones count too)
   (if (== $seen ()) False
       (let ($i $b) (car-atom $seen)
         (if (case $b (((piece-started ($p $t $v $rs)) True) ((dispatched ($o route-fix ($p $v))) True) ($x False))) True
             (builder-named? $v (cdr-atom $seen))))))
(= (independent? $v $ctx $st)
   (if (not (ref? $v)) False
       (and (not (has? $v (ctx-authors $ctx))) (and (not (== $v (ctx-person $ctx))) (not (builder-named? $v (sv $st seen)))))))
(= (the-person? $p $ctx) (and (== $p (ctx-person $ctx)) (not (has? $p (ctx-authors $ctx)))))

; ---- phases --------------------------------------------------------------------------------------------
(= (terminal? $ph) (or (== $ph deployed) (== $ph stopped)))
(= (build-phase? $ph) (has? $ph (building fixing integrating)))
(= (tests-due? $st)
   (let $ph (sv $st phase)
     (or (== $ph designed) (and (== $ph planned) (== (index-atom (sv $st needs) 0) no-design)))))
(= (settle $st)   ; the build phase follows from the piece records
   (if (not (build-phase? (sv $st phase))) $st
       (let $ps (sv $st pieces)
         (if (not (== (filter-atom $ps $r (or (has? (index-atom $r 2) (waiting started fixing built)) (unassignable? (index-atom $r 2)))) ()))
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
                          pieces (map-atom (sv $st pieces) $r (Pc (pc-id $r) (pc-status $r) (pc-cand $r) 0 (pc-fixrun $r) (pc-mark $r) (pc-passed $r) (pc-resolved $r)))))
(= (go-drain ($st $v))   ; a go cleared by anything but its own deployed leaves the deploy as unresolved debt
   (if (not (== (sv $st go) none)) ($st $v)
       (let $ds (filter-atom (sv $st ledger) $e (== (index-atom $e 1) deploy))
         (if (== $ds ()) ($st $v)
             ((sput (sput $st ledger (filter-atom (sv $st ledger) $e (not (== (index-atom $e 1) deploy)))) unres (append $ds (sv $st unres))) $v)))))
(= (expected-form $st) (if (== (filter-atom (sv $st pieces) $r (== (index-atom $r 6) unreviewed)) ()) confirm-deploy confirm-unreviewed-deploy))

; ---- the reducer ---------------------------------------------------------------------------------------
(= (apply-obs $ctx $st $obs)
   (if (not (is-ground $obs)) (rej $st not-ground)   ; B1: a variable can unify with anything; it is never evidence
   (case $obs
     (((O $id $kind $opl $oep $f)
        (if (not (and (atomic? $id) (atomic? $kind))) (rej $st malformed-observation)
        (let $prior (kv-get $id (sv $st seen))
          (if (not (== $prior none))
              (if (== $prior ($kind $f)) ($st duplicate) (rej $st conflicting-duplicate))
              (if (not (and (== $opl (ctx-plan $ctx)) (== $oep (ctx-epoch $ctx))))
                  (rej $st wrong-plan)
                  (let $st2 (sput $st seen (cons-atom ($id ($kind $f)) (sv $st seen)))
                    (if (and (terminal? (sv $st phase)) (not (has? $kind (unknown reconciled deployed-confirmed reconciled-not-deployed))))
                        (rej $st2 terminal)
                    (let $spec (shape-of $kind)
                    (if (== $spec none) (rej $st2 unknown-kind)
                    (if (not (fits-spec? $spec $f)) (rej $st2 malformed-fields)
                        (go-drain (by-kind $ctx $st2 $kind $f))))))))))))
      ($o (rej $st malformed-observation))))))

(= (by-kind $ctx $st $kind $f)
   (case $kind
     ((plan-started (let ($op) $f (on-plan-started $ctx $st $op)))
      (planned (let ($op $pl $graph $unknowns $needs) $f (on-planned $ctx $st $op $pl $graph $unknowns $needs)))
      (plan-failed (let ($op) $f (on-plan-failed $ctx $st $op)))
      (designed (let ($op $ref) $f (on-designed $st $op $ref)))
      (dispatched (let ($op $k $s) $f (on-dispatched $ctx $st $op $k $s)))
      (tests-authored (let ($op $suite $paths) $f (on-tests $st $op $suite $paths author-tests)))
      (tests-detected (let ($op $suite $paths) $f (on-tests $st $op $suite $paths detect-tests)))
      (piece-started (let ($p $task $builder $res) $f (on-piece-started $ctx $st $p $task $builder $res)))
      (piece-ready (let ($p $op $c) $f (on-piece-ready $st $p $op $c)))
      (piece-blocked (let ($p $op) $f (on-piece-blocked $st $p $op)))
      (assignee-unavailable (let ($p) $f (on-assignee-unavailable $st $p)))
      (review-pass (let ($p $c $rk $v $ev) $f (on-review-pass $ctx $st $rk $p $c $v $ev)))
      (review-fail (let ($p $c $rk $v $ev) $f (on-review-fail $ctx $st $rk $p $c $v $ev)))
      (review-unavailable (let ($p $c $rk) $f (on-review-unavailable $ctx $st $p $c $rk)))
      (integrated (let ($op $p $c $ck) $f (on-integrated $st $op $p $c $ck)))
      (merge-conflict (let ($op $p) $f (on-merge-conflict $ctx $st $op $p)))
      (check-pass (let ($run $ck) $f (on-check-pass $st $run $ck)))
      (check-fail (let ($run $ck $files) $f (on-check-fail $ctx $st $run $ck $files)))
      (check-unknown (let ($run) $f (on-check-unknown $st $run)))
      (question-asked (let ($q $about) $f (on-question-asked $st $q $about)))
      (answered (let ($q $p $ref) $f (on-answered $ctx $st $q $p $ref)))
      (question-withdrawn (let ($q $p) $f (on-question-withdrawn $ctx $st $q $p)))
      (preview-deployed (let ($op $ck $url) $f (on-preview-deployed $st $op $ck $url)))
      (preview-failed (let ($op) $f (on-preview-failed $ctx $st $op)))
      (deploy-approved (let ($op $p $form) $f (on-deploy-approved $ctx $st $op $p $form)))
      (deployed (let ($op) $f (on-deployed $st $op)))
      (deploy-refused (let ($op) $f (on-deploy-refused $st $op)))
      (deployed-confirmed (let ($op $receipt) $f (on-deployed-confirmed $st $op $receipt)))
      (reconciled-not-deployed (let ($op) $f (on-reconciled-not-deployed $st $op)))
      (cancelled (acc (sput (sput (drain $st) go none) phase stopped)))   ; cleanup owed for everything open
      (unknown (let ($op) $f (on-unknown $st $op)))
      (reconciled (let ($op) $f (on-reconciled $ctx $st $op)))
      ($other (rej $st unknown-kind)))))

(= (on-plan-started $ctx $st $op)
   (if (not (fresh-op? $op $st)) (rej $st operation-id-reused)
   (if (not (== (sv $st phase) claimed)) (rej $st plan-not-due)
   (let $g (effect-gate $st) (if (not (== $g none)) (rej $st $g)
       (acc (add-entry (sput $st phase planning) ($op plan none))))))))

(= (valid-needs? $n)
   (case $n (((Needs $d $t $rf $caps $res)
               (if (not (and (has? $d (design no-design)) (has? $t (author detect)))) False
               (if (not (and (is-expr $rf) (and (is-expr $caps) (is-expr $res)))) False
                   (and (== (filter-atom $rf $r (not (review-for-ok? $r))) ())
                        (and (== (filter-atom $caps $c (not (cap-ok? $c))) ()) (== (filter-atom $res $r (not (reserved-ok? $r))) ()))))))
             ($o False))))
(= (reserved-ok? $r)   ; (Reserved path...): one or more paths no piece may own
   (if (not (is-expr $r)) False
   (if (== $r ()) False
   (if (not (== (car-atom $r) Reserved)) False
       (let $ps (cdr-atom $r) (if (== $ps ()) False (atoms? $ps)))))))
(= (reserved-paths $res) (flatten1 (map-atom $res $r (cdr-atom $r))))
(= (graph-files $graph) (flatten1 (map-atom $graph $n (index-atom $n 5))))
(= (any-in? $xs $ys) (not (== (filter-atom $xs $x (has? $x $ys)) ())))
(= (reducer-symbol? $k) (has? $k (none True False Empty)))
(= (unknowns-fault $us $graph)
   (if (not (is-expr $us)) invalid_unknowns
   (if (not (== (filter-atom $us $u (case $u ((($q $a) (if (ref? $q) (not (valid-about? $a $graph)) True)) ($o True)))) ())) invalid_unknowns
   (if (has-dups? (map-atom $us $u (index-atom $u 0))) invalid_unknowns none))))
(= (on-planned $ctx $st $op $pl $graph $unknowns $needs)   ; pl: (Plan ref revision digest parent-digest), OmegaPlanner's shape
   (if (not (and (== (sv $st phase) planning) (in-ledger? ($op plan none) $st))) (rej $st not-the-open-plan)
   (case $pl
     (((Plan $ref $rev $digest $parent)
        (if (not (and (== $rev 1) (and (== $parent none) (and (ref? $ref) (ref? $digest))))) (rej $st stale_revision)
        (if (not (valid-needs? $needs)) (rej $st invalid_needs)
        (let $gf (graph-fault $graph) (if (not (== $gf none)) (rej $st $gf)
        (if (any-in? (flatten1 (map-atom $graph $n (index-atom $n 3))) (none True False Empty)) (rej $st reducer-symbol-kind)
        (if (any-in? (graph-files $graph) (reserved-paths (index-atom $needs 5))) (rej $st piece-owns-reserved-path)
        (if (and (has-design-pieces? $graph) (== (index-atom $needs 1) design)) (rej $st design-pieces-carry-the-design)
        (let $rv (append (ctx-reviews $ctx) (index-atom $needs 3))   ; the plan may add reviews, never remove the hive's
        (if (not (kinds-reviewable? $graph $rv)) (rej $st no-review-for-artifact-kind)
        (let $uf (unknowns-fault $unknowns $graph) (if (not (== $uf none)) (rej $st $uf)
            (acc (drop-entry (sput (sput (sput (sput (sput (sput (sput (sput (sput $st phase planned) plan ($ref $digest)) graph $graph)
                                       needs ((index-atom $needs 1) (index-atom $needs 2))) reviews $rv) caps (index-atom $needs 4)) reserved (reserved-paths (index-atom $needs 5)))
                                     pieces (init-pieces $graph))
                               questions (map-atom $unknowns $u ((index-atom $u 0) (index-atom $u 1) raised)))
                             ($op plan none)))))))))))))))
      ($o (rej $st invalid_plan_object))))))

(= (bump-retries $ctx $st $held $why)   ; liveness: failed plans and previews, and lost operations, spend one budget
   (if (or (terminal? (sv $st phase)) (== (sv $st phase) blocked)) $st
   (let $r (+ (sv $st retries) 1)
     (if (> $r (ctx-retry-cap $ctx)) (block (sput $st retries $r) $why $held) (sput $st retries $r)))))

(= (on-plan-failed $ctx $st $op)
   (if (not (and (== (sv $st phase) planning) (in-ledger? ($op plan none) $st))) (rej $st not-the-open-plan)
       (let $s2 (sput (drop-entry $st ($op plan none)) phase claimed)
         (acc (bump-retries $ctx $s2 claimed (cap-exceeded plan-failed))))))

(= (on-designed $st $op $ref)
   (let $e (op-entry $op $st)
     (if (or (== $e none) (or (not (== (sv $st phase) designing)) (not (ref? $ref)))) (rej $st not-the-open-design)
     (if (not (== (index-atom $e 1) design)) (rej $st not-the-open-design)
         (acc (sput (sput (drop-entry $st $e) phase designed) design $ref))))))

(= (on-tests $st $op $suite $paths $k)   ; the suite names its check paths; no piece may own one
   (let $e (op-entry $op $st)
     (if (or (== $e none) (not (ref? $suite))) (rej $st not-the-open-test-request)
     (if (not (and (== (index-atom $e 1) $k) (tests-due? $st))) (rej $st not-the-open-test-request)
     (if (== $paths ()) (rej $st suite-names-no-check-path)
     (if (any-in? $paths (graph-files (sv $st graph))) (rej $st piece-owns-suite-file)
         (acc (sput (sput (sput (drop-entry $st $e) phase testing-authored) suite $suite) suite-paths $paths))))))))

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
      (route-fix (let $p (index-atom $s 0) (set-piece $st (with-status (piece-rec $p $st) started))))
      ($o $st))))
(= (dispatch-fault $ctx $st $k $s)
   (let $ph (sv $st phase)
   (case $k
     ((design (if (and (== $ph planned) (== (index-atom (sv $st needs) 0) design)) none design-not-due))
      (author-tests (if (and (tests-due? $st) (and (== (index-atom (sv $st needs) 1) author) (not (or (kind-in-flight? author-tests $st) (kind-in-flight? detect-tests $st))))) none tests-not-due))
      (detect-tests (if (and (tests-due? $st) (and (== (index-atom (sv $st needs) 1) detect) (not (or (kind-in-flight? author-tests $st) (kind-in-flight? detect-tests $st))))) none tests-not-due))
      (run-checks (if (and (not (== (check-target $st) none)) (and (== $s (check-target $st)) (not (kind-in-flight? run-checks $st)))) none checks-not-due))
      (review (review-dispatch-fault $st $s))
      (integrate (case $s ((($p $c) (if (and (build-phase? $ph) (and (== (status-of $p $st) reviewed) (and (== (pc-cand (piece-rec $p $st)) $c)
                                          (and (not (q-held? $p $st)) (not (kind-in-flight? integrate $st)))))) none integrate-not-due))
                            ($o integrate-not-due))))
      (route-fix (case $s ((($p $b) (route-fault $ctx $st $p $b)) ($o route-not-due))))
      (preview (if (and (== $ph previewing) (and (== $s (sv $st ckpt)) (not (kind-in-flight? preview $st)))) none preview-not-due))
      ($o not-dispatchable)))))   ; plan, start and deploy are journalled by their own kinds
(= (route-fault $ctx $st $p $b)   ; the repairer is named, so it can never review the piece
   (if (not (and (build-phase? (sv $st phase)) (and (== (status-of $p $st) fixing) (ref? $b)))) route-not-due
   (if (q-held? $p $st) awaiting-answer
   (if (not (< (active-count $st) (ctx-budget $ctx))) lease-full
   (if (not (assignee-room? (assignee-of $p (sv $st graph)) $st 0)) assignee-cap-full
       none)))))
(= (review-dispatch-fault $st $s)   ; a review kind the piece's artifact kinds require, not yet passed, not in flight
   (case $s ((($p $c $rk)
               (if (not (and (build-phase? (sv $st phase)) (and (== (status-of $p $st) built) (== (pc-cand (piece-rec $p $st)) $c)))) review-not-due
               (if (q-held? $p $st) awaiting-answer
               (if (not (and (has? $rk (required-reviews $p $st)) (and (not (has? $rk (pc-passed (piece-rec $p $st)))) (== (review-entry $p $c $rk $st) none))))
                   review-not-due none))))
             ($o review-not-due))))

(= (on-piece-started $ctx $st $p $task $builder $res)
   (if (not (fresh-op? $task $st)) (rej $st operation-id-reused)
   (let $g (effect-gate $st) (if (not (== $g none)) (rej $st $g)
   (if (or (not (build-phase? (sv $st phase))) (not (ref? $builder))) (rej $st piece-not-startable)
   (let $r (piece-rec $p $st)
     (if (== $r none) (rej $st piece-not-in-plan)
     (if (unassignable? (pc-status $r)) (rej $st assignee-unavailable)   ; held until the person answers
     (if (q-held? $p $st) (rej $st awaiting-answer)
     (if (not (startable? $r $st)) (rej $st piece-not-startable)
     (if (>= (active-count $st) (ctx-budget $ctx)) (rej $st lease-full)
     (if (not (assignee-room? (assignee-of $p (sv $st graph)) $st 0)) (rej $st assignee-cap-full)
     (if (not (fits? (assignee-of $p (sv $st graph)) $res)) (rej $st assignee-mismatch)
         (acc (settle (add-entry (set-piece $st (Pc $p started (pc-cand $r) (pc-reps $r) (pc-fixrun $r) (pc-mark $r) (pc-passed $r) $res)) ($task start $p)))))))))))))))))

(= (on-assignee-unavailable $st $p)   ; no one the selector names can take the piece: hold it and ask the person
   (let $s (status-of $p $st)
     (if (not (and (build-phase? (sv $st phase)) (or (== $s waiting) (== $s fixing)))) (rej $st assignee-not-due)
         (acc (settle (set-piece $st (with-status (piece-rec $p $st) (unassignable $s))))))))
(= (first-unassignable-unasked $st)
   (let $m (filter-atom (sv $st pieces) $r (and (unassignable? (index-atom $r 2)) (not (open-about? (piece (index-atom $r 1)) $st))))
     (if (== $m ()) none (index-atom (car-atom $m) 1))))

(= (open-piece-entry $p $op $st)   ; B2: the result must answer the piece's own open start or route-fix
   (let $e (op-entry $op $st) (if (== $e none) none (if (== (entry-piece $e) $p) $e none))))
(= (on-piece-ready $st $p $op $c)
   (let $e (open-piece-entry $p $op $st)
     (if (or (== $e none) (not (== (status-of $p $st) started))) (rej $st not-a-running-piece)
     (if (not (ref? $c)) (rej $st candidate-is-not-a-reference)
     (let $r (piece-rec $p $st)
       (if (== $c (pc-cand $r)) (rej $st candidate-unchanged)
           (acc (settle (set-piece (drop-entry $st $e) (Pc $p built $c (pc-reps $r) (pc-fixrun $r) reviewed () (pc-resolved $r)))))))))))

(= (on-piece-blocked $st $p $op)
   (let $e (open-piece-entry $p $op $st)
     (if (or (== $e none) (not (== (status-of $p $st) started))) (rej $st not-a-running-piece)
         (let $s2 (set-piece (drop-entry $st $e) (with-status (piece-rec $p $st) fixing))
           (acc (block $s2 (piece-blocked $p) (sv (settle $s2) phase)))))))

(= (review-common $ctx $st $rk $p $c $v $ev)   ; none, or why this review result is refused (checked against ReviewFor)
   (let $e (review-entry $p $c $rk $st)
     (if (or (== $e none) (not (== (status-of $p $st) built))) review-not-requested
     (if (not (independent? $v $ctx $st)) reviewer-not-independent
     (if (not (evidence-ok? (evidence-for $p $rk $st) $ev)) review-needs-evidence
         none)))))
(= (pass-review $st $p $rk $mark)   ; a piece is reviewed once every review kind its artifacts require has passed
   (let* (($r (piece-rec $p $st)) ($passed (cons-atom $rk (pc-passed $r))) ($done (all-in (required-reviews $p $st) $passed)))
     (settle (set-piece $st (Pc $p (if $done reviewed built) (pc-cand $r) (pc-reps $r) (pc-fixrun $r)
                                (if (== $mark unreviewed) unreviewed (pc-mark $r)) $passed (pc-resolved $r))))))
(= (on-review-pass $ctx $st $rk $p $c $v $ev)
   (let $why (review-common $ctx $st $rk $p $c $v $ev)
     (if (not (== $why none)) (rej $st $why)
         (acc (pass-review (drop-entry $st (review-entry $p $c $rk $st)) $p $rk reviewed)))))
(= (on-review-fail $ctx $st $rk $p $c $v $ev)   ; a refuted piece goes back to its own assignee for a fix
   (let $why (review-common $ctx $st $rk $p $c $v $ev)
     (if (not (== $why none)) (rej $st $why)
         (let* (($e (review-entry $p $c $rk $st)) ($s2 (drop-entry $st $e)))
           (acc (route-pieces $ctx $s2 ($p) (index-atom $e 0) False))))))
(= (on-review-unavailable $ctx $st $p $c $rk)   ; never a pass
   (let $e (review-entry $p $c $rk $st)
     (if (or (== $e none) (not (== (status-of $p $st) built))) (rej $st review-not-requested)
         (let $s2 (drop-entry $st $e)
           (if (== (ctx-policy $ctx) review-waivable)
               ((pass-review $s2 $p $rk unreviewed) (accepted (review-unavailable waived)))
               ((block $s2 (review-unavailable $p $rk) (sv $st phase)) (accepted (review-unavailable blocked))))))))

(= (route-pieces $ctx $st $ps $run $plan-round)   ; mark each owner fixing, count its repair, check both caps
   (let* (($s1 (if $plan-round (sput $st rounds (+ (sv $st rounds) 1)) $st))
          ($s2 (foldl-atom $ps $s1 $acc $p (let $r (piece-rec $p $acc) (set-piece $acc (Pc $p fixing (pc-cand $r) (+ (pc-reps $r) 1) $run (pc-mark $r) () (pc-resolved $r)))))))
     (if (> (sv $s2 rounds) (ctx-fix-cap $ctx)) (block (sput $s2 phase fixing) (cap-exceeded fix-rounds) fixing)
     (if (not (== (filter-atom (sv $s2 pieces) $r (> (index-atom $r 4) (ctx-piece-cap $ctx))) ()))
         (block (settle (sput $s2 phase building)) (cap-exceeded piece-repairs) (sv (settle (sput $s2 phase building)) phase))
         (settle (sput $s2 phase building))))))

(= (on-integrated $st $op $p $c $ck)
   (if (not (in-ledger? ($op integrate ($p $c)) $st)) (rej $st not-the-open-integration)
   (if (or (not (ref? $ck)) (or (== $ck base) (has? $ck (sv $st ckpts)))) (rej $st checkpoint-not-new)   ; never reused
       (acc (settle (sput (sput (set-piece (drop-entry $st ($op integrate ($p $c))) (with-status (piece-rec $p $st) integrated)) ckpt $ck)
                          ckpts (cons-atom $ck (sv $st ckpts))))))))

(= (on-merge-conflict $ctx $st $op $p)
   (let $e (op-entry $op $st)
     (if (== $e none) (rej $st not-the-open-integration)
     (if (not (case $e ((($o integrate ($pp $cc)) (== $pp $p)) ($x False)))) (rej $st not-the-open-integration)
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
               (if (has? none $owners) (acc (block $s2 (unrouted-failure $files) checking))
                   (acc (route-pieces $ctx $s2 $owners $run True)))))))))
(= (on-check-unknown $st $run)
   (let $e (op-entry $run $st)
     (if (== $e none) (rej $st run-not-dispatched-for-this-checkpoint)
     (if (not (== (index-atom $e 1) run-checks)) (rej $st run-not-dispatched-for-this-checkpoint)
         (acc (sput (drop-entry $st $e) unres (cons-atom $e (sv $st unres))))))))

(= (on-question-asked $st $q $about)
   (let $e (q-of $q $st)
     (if (not (== $e none))
         (if (and (== (index-atom $e 2) raised) (== (index-atom $e 1) $about)) (acc (sput (set-q $st $q asked) go none)) (rej $st question-id-reused))
     (if (not (ref? $q)) (rej $st question-id-reused)
     (if (== $about blocked)
         (if (and (== (sv $st phase) blocked) (not (open-about? blocked $st))) (acc (sput $st questions (cons-atom ($q blocked asked) (sv $st questions)))) (rej $st not-blocked))
     (if (valid-about? $about (sv $st graph))
         (acc (sput (sput $st questions (cons-atom ($q $about asked) (sv $st questions))) go none))   ; S5: any new doubt withdraws consent
         (rej $st invalid-question-subject)))))))
(= (on-answered $ctx $st $q $p $ref)
   (let $e (q-of $q $st)
     (if (== $e none) (rej $st not-an-open-question)
     (if (not (== (index-atom $e 2) asked)) (rej $st not-an-open-question)
     (if (not (the-person? $p $ctx)) (rej $st not-the-person)
     (if (not (ref? $ref)) (rej $st answer-is-not-a-reference)
         (let $s2 (sput (set-q $st $q closed) answers (cons-atom ($q $ref) (sv $st answers)))
           (if (== (index-atom $e 1) blocked)   ; only the person's answer releases a hold, with fresh allowances
               (acc (settle (reset-caps (sput (sput (sput $s2 phase (sv $st held)) held none) why none))))
               (acc (settle (requeue $s2 (index-atom $e 1))))))))))))
(= (requeue $st $about)   ; the person's answer returns an unassignable piece to where it was
   (case $about (((piece $p) (case (status-of $p $st) (((unassignable $prior) (set-piece $st (with-status (piece-rec $p $st) $prior))) ($o $st))))
                 ($x $st))))
(= (on-question-withdrawn $ctx $st $q $p)   ; S3: only the person withdraws, and never a hold
   (let $e (q-of $q $st)
     (if (== $e none) (rej $st not-an-open-question)
     (if (not (open-q? $e)) (rej $st not-an-open-question)
     (if (not (the-person? $p $ctx)) (rej $st not-the-person)
     (if (== (index-atom $e 1) blocked) (rej $st hold-needs-the-persons-answer)
         (acc (set-q $st $q closed))))))))

(= (on-preview-deployed $st $op $ck $url)
   (if (not (and (== (sv $st phase) previewing) (and (in-ledger? ($op preview $ck) $st) (== $ck (sv $st ckpt))))) (rej $st not-the-open-preview)
   (if (not (ref? $url)) (rej $st preview-is-not-a-reference)
       (acc (sput (sput (drop-entry $st ($op preview $ck)) phase ready-to-deploy) preview ($ck $url))))))
(= (on-preview-failed $ctx $st $op)
   (let $e (op-entry $op $st)
     (if (== $e none) (rej $st not-the-open-preview)
     (if (not (== (index-atom $e 1) preview)) (rej $st not-the-open-preview)
         (acc (bump-retries $ctx (drop-entry $st $e) previewing (cap-exceeded preview-failed)))))))

(= (on-deploy-approved $ctx $st $op $p $form)   ; the person's go journals the deploy (ledger) before any effect
   (if (not (fresh-op? $op $st)) (rej $st operation-id-reused)
   (if (not (the-person? $p $ctx)) (rej $st not-the-person)
   (if (not (== (sv $st phase) ready-to-deploy)) (rej $st not-ready-to-deploy)
   (let $g (effect-gate $st) (if (not (== $g none)) (rej $st $g)
   (if (any-open-q? $st) (rej $st awaiting-answer)   ; S5: any open question holds the go
   (if (not (and (== (sv $st go) none) (== (sv $st ledger) ()))) (rej $st something-else-open)
   (if (not (== $form (expected-form $st))) (rej $st not-the-form-the-person-was-shown)
   (let $pv (sv $st preview)
     (if (if (== $pv none) True (not (== (index-atom $pv 0) (sv $st ckpt)))) (rej $st preview-not-current)
         (acc (add-entry (sput $st go ($op (sv $st ckpt) $p $form)) ($op deploy (sv $st ckpt)))))))))))))))
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
; S4 (R3.13's pattern): a deploy of unknown fate is settled only by its own readback
(= (unres-deploy? $op $st) (let $e (unres-entry $op $st) (if (== $e none) False (== (index-atom $e 1) deploy))))
(= (on-deployed-confirmed $st $op $receipt)   ; the readback proves the person's approved deploy landed
   (if (not (unres-deploy? $op $st)) (rej $st not-an-unresolved-deploy)
   (if (not (ref? $receipt)) (rej $st receipt-is-not-a-reference)
   (if (== (sv $st phase) deployed) (rej $st terminal)
       (acc (sput (sput $st unres (without (unres-entry $op $st) (sv $st unres))) phase deployed))))))
(= (on-reconciled-not-deployed $st $op)   ; the readback proves it did not land: consent cleared, no debt, a fresh go needed
   (if (not (unres-deploy? $op $st)) (rej $st not-an-unresolved-deploy)
       (let $go (sv $st go)
         (acc (sput (sput $st unres (without (unres-entry $op $st) (sv $st unres)))
                    go (if (if (== $go none) False (== (index-atom $go 0) $op)) none $go))))))

(= (on-unknown $st $op)
   (if (has? $op (map-atom (sv $st unres) $e (index-atom $e 0))) (rej $st already-unresolved)
       (let* (($e (op-entry $op $st)) ($ent (if (== $e none) ($op host none) $e)) ($s2 (if (== $e none) $st (drop-entry $st $e))))
         (let $go (sv $st go)
           (acc (sput (if (if (== $go none) False (== (index-atom $go 0) $op)) (sput $s2 go none) $s2) unres (cons-atom $ent (sv $s2 unres))))))))
(= (on-reconciled $ctx $st $op)   ; the readback resolves the operation; it restores its piece but never releases a hold
   (let $e (unres-entry $op $st)
     (if (== $e none) (rej $st not-an-unresolved-operation)
     (if (== (index-atom $e 1) deploy) (rej $st deploy-needs-its-own-readback)   ; S4: landed or not, never "unknown, try again"
         (let $s2 (restore (sput $st unres (without $e (sv $st unres))) (index-atom $e 1) (index-atom $e 2))
           (acc (settle (bump-retries $ctx $s2 (sv $s2 phase) (cap-exceeded lost-operations)))))))))   ; R4.2: every lost operation, of any kind
(= (restore $st $k $s)
   (case $k
     ((start (if (== (status-of $s $st) started) (set-piece $st (with-status (piece-rec $s $st) waiting)) $st))
      (route-fix (let $p (index-atom $s 0) (if (== (status-of $p $st) started) (set-piece $st (with-status (piece-rec $p $st) fixing)) $st)))
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
   (let $ua (if (build-phase? $ph) (first-unassignable-unasked $st) none)
   (if (not (== $ua none)) (tell ask-person (assignee-unavailable $ua))
   (if (== $ph blocked) (if (open-about? blocked $st) (rest awaiting-answer) (tell ask-person (blocked (sv $st why))))
   (if (open-about? plan $st) (if (== (sv $st ledger) ()) (rest awaiting-answer) (rest awaiting-results))
       (phase-action $ctx $st $ph))))))))))))
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
        (if (any-open-q? $st) (rest awaiting-answer)
        (let $go (sv $st go)
          (if (== $go none) (tell (expected-form $st) (ctx-plan $ctx))
              (if (== (sv $st ledger) (((index-atom $go 0) deploy (sv $st ckpt)))) (do (deploy (index-atom $go 0))) (rest awaiting-results))))))
      ($o (if (build-phase? $ph) (build-action $ctx $st) (rest needs-person))))))
(= (missing-review $r $st)   ; the first review kind the piece needs, neither passed nor in flight
   (let $m (filter-atom (required-reviews (index-atom $r 1) $st) $k
             (and (not (has? $k (index-atom $r 7))) (not (has? $k (reviews-in-flight (index-atom $r 1) (index-atom $r 3) $st)))))
     (if (== $m ()) none (car-atom $m))))
(= (free-pieces $s $st) (filter-atom (pieces-with $s $st) $r (not (q-held? (index-atom $r 1) $st))))
(= (build-action $ctx $st)
   (let* (($g (sv $st graph))
          ($fix (filter-atom (free-pieces fixing $st) $r (assignee-room? (assignee-of (index-atom $r 1) $g) $st 0)))
          ($built (filter-atom (free-pieces built $st) $r (not (== (missing-review $r $st) none))))
          ($rev (free-pieces reviewed $st)) ($starts (may-start $ctx $st)))
     (if (and (not (== $fix ())) (< (active-count $st) (ctx-budget $ctx)))
         (let $r (car-atom $fix) (do (route-fix (index-atom $r 1) (index-atom $r 5) (assignee-of (index-atom $r 1) $g))))
     (if (not (== $built ())) (let $r (car-atom $built) (do (request-review (index-atom $r 1) (index-atom $r 3) (missing-review $r $st))))
     (if (and (not (== $rev ())) (not (kind-in-flight? integrate $st))) (do (integrate (index-atom (car-atom $rev) 1) (index-atom (car-atom $rev) 3)))
     (if (not (== $starts ())) (do (start-piece (car-atom $starts) (assignee-of (car-atom $starts) $g)))
     (if (not (== (sv $st ledger) ())) (rest awaiting-pieces)
     (if (any-open-q? $st) (rest awaiting-answer)
         (rest needs-person)))))))))

(= (needs-model (think $g)) True)
(= (needs-model (do $x)) False)
(= (needs-model (tell $x $y)) False)
(= (needs-model (rest $w)) False)
