; lib_mind: the personal mind's memory as a MeTTa AtomSpace (Surface mind-metta r2).
;
; Loaded after lib_nal, lib_pln and lib_hive (vendored, pinned in PIN.json). It adds no truth
; arithmetic of its own: every item goes through lib_hive's hive-integrate!, so revision is
; lib_hive's hive-truth-revision (an exact copy of lib_nal's Truth_Revision, checked by the
; parity tests), revision happens only on disjoint evidential stamps, and overlap is a choice.
; Inference is lib_pln's |~pln; recall scoring uses lib_nal's Truth_Expectation.
;
; Two spaces:
;   &mind     what is held now (forgetting removes from here)
;   &history  the append-only journal (nothing here is ever removed; it holds no words)
;
; Atoms in &mind (ids, kinds, texts and fingerprints are strings; times are seconds). The carrier
; is the one Platform's minds' memory plan uses (PLATFORM_MIND_MEMORY_MULTI_INDEX_PLAN_R2 §4.1):
;   (Current (Belief id) (stv f c) stamp)   a distilled belief about the person (lib_hive's atom)
;   (Current (Memory id) (stv f c) stamp)   a remembered exchange or episode (lib_hive's atom)
;                                           stamp = sorted ((ev agent n) ...)
;   (Said id kind text at)                  the words of either, and when their evidence arose
;   (Words id fp)                           fp = salted sha256 of the normalised words
;   (Chosen (Belief|Memory id) kept other)  lib_hive: overlapping evidence, one stamp chosen
;   (Promotion id value last)               attention, as the minds' helper promotion
;   (Forgotten id fp at)                    tombstone (fp none when the words were never held)
;   (ForgetAll at)                          the forget-everything watermark (at most one)
;   (Self tag salt) (Salt hex)              this space's evidence agent and salts
;   (EvCounter agent n)                     lib_hive's evidence minting
; Atoms in &history:
;   (Event (ev tag n) op at turn id detail) op: learned adopted revised chosen kept used
;                                           forgotten forgot-all purged
;   (EvCounter tag n)                       the journal's own counter
;
; The id joins the three parts of memory: vector entry id = atom id = Event target.
; The turn joins the events of one turn (the exchange and every belief learned in it).
;
; Written in the subset both MeTTaScript and PeTTa run: the parity tests run the same scenario on both.

; ---- small helpers -----------------------------------------------------------

; car-atom, cdr-atom and cons-atom do not evaluate their arguments on MeTTaScript (Hyperon's
; Expression-typed parameters) but do on PeTTa: their arguments are always bound first.
(= (mind-self) (let $s (collapse (match &mind (Self $x $salt) $x)) (car-atom $s)))

(= (mind-take $n $xs)
   (if (or (<= $n 0) (== $xs ()))
       ()
       (let* (($h (car-atom $xs))
              ($t (cdr-atom $xs))
              ($rest (mind-take (- $n 1) $t)))
             (cons-atom $h $rest))))

(= (mind-first $xs) (if (== $xs ()) none (car-atom $xs)))

; add-atom and remove-atom take their argument unevaluated on PeTTa: every value they store or
; remove is bound with let/let* first (as lib_hive does).
(= (mind-remove-all! $atoms)
   (let $removed (map-atom $atoms $x (remove-atom &mind $x)) (size-atom $atoms)))

; Belief or Memory, for a held id (none: not held).
(= (mind-class $id)
   (let $c (collapse (match &mind (Current ($k $id) $tv $s) $k)) (mind-first $c)))

; ---- forgetting: watermark and tombstones ------------------------------------

(= (mind-watermark)
   (let $w (collapse (match &mind (ForgetAll $at) $at))
        (if (== $w ()) -1 (car-atom $w))))

; Words forgotten at or after $since (when the evidence for them arose) are refused. Words
; forgotten before it may be said again: that is new evidence.
(= (mind-fp-forgotten? $fp $since)
   (not (== () (collapse (match &mind (Forgotten $i $fp $at) (if (>= $at $since) True (empty)))))))

(= (mind-fps-forgotten? $fps $since)
   (if (== $fps ())
       False
       (if (mind-fp-forgotten? (car-atom $fps) $since)
           True
           (mind-fps-forgotten? (cdr-atom $fps) $since))))

; Held at all: after the watermark, its id never forgotten, its words not forgotten since.
; $fps: the words' fingerprint under every salt in the space.
(= (mind-admit? $id $fps $at)
   (if (<= $at (mind-watermark))
       False
       (if (hive-exists? &mind (Forgotten $id $f $a))
           False
           (not (mind-fps-forgotten? $fps $at)))))

; ---- the journal ---------------------------------------------------------------

(= (mind-log! $op $at $turn $id $detail)
   (let* (($self (mind-self))
          ($n (hive-next-evidence! &history $self))
          ($added (add-atom &history (Event $n $op $at $turn $id $detail))))
         $n))

; ---- evidence --------------------------------------------------------------------

; mint: new evidence from this space; otherwise the caller's stamp, as given.
(= (mind-stamp $given)
   (if (== $given mint)
       (let* (($self (mind-self)) ($e (hive-next-evidence! &mind $self))) ($e))
       $given))

; ---- learning (Belief or Memory) ---------------------------------------------------

(= (mind-integrate! $class $id $tv $given $at $turn)
   (let* (($stamp (mind-stamp $given))
          ($before (collapse (match &mind (Current ($class $id) $t0 $s0) ($t0 $s0))))
          ($r (hive-integrate! &mind ($class $id) $tv $stamp))
          ($l (mind-log! (car-atom $r) $at $turn $id $r)))
         (integrated $before ($tv $stamp) $r)))

; $class: Belief (about the person) or Memory (an exchange or episode).
(= (mind-learn! $class $id $kind $text $fps $tv $given $at $turn)
   (if (not (mind-admit? $id $fps $at))
       (refused forgotten)
       (let $held (mind-class $id)
            (if (== $held none)
                (let* (($fp (mind-first $fps))
                       ($a1 (add-atom &mind (Said $id $kind $text $at)))
                       ($a2 (add-atom &mind (Words $id $fp)))
                       ($a3 (add-atom &mind (Promotion $id 0.0 $at)))
                       ($l (mind-log! learned $at $turn $id $kind)))
                      (mind-integrate! $class $id $tv $given $at $turn))
                (if (== $held $class)
                    (let $said (collapse (match &mind (Said $id $k $t $a) ($k $t)))
                         (if (== (car-atom $said) ($kind $text))
                             (mind-integrate! $class $id $tv $given $at $turn)
                             (refused id-conflict)))
                    (refused id-taken))))))

(= (mind-revise! $id $tv $given $at $turn)
   (let $class (mind-class $id)
        (if (== $class none)
            (refused unknown)
            (if (<= $at (mind-watermark))
                (refused forgotten)
                (mind-integrate! $class $id $tv $given $at $turn)))))

; ---- forgetting ------------------------------------------------------------------

(= (mind-held $id)
   (append (collapse (match &mind (Said $id $a $b $c) (Said $id $a $b $c)))
   (append (collapse (match &mind (Words $id $fp) (Words $id $fp)))
   (append (collapse (match &mind (Current ($k $id) $tv $s) (Current ($k $id) $tv $s)))
   (append (collapse (match &mind (Chosen ($k2 $id) $s1 $s2) (Chosen ($k2 $id) $s1 $s2)))
           (collapse (match &mind (Promotion $id $v $l) (Promotion $id $v $l))))))))

(= (mind-drop! $id) (mind-remove-all! (mind-held $id)))

(= (mind-forget! $id $at $turn)
   (let* (($fps (collapse (match &mind (Words $id $f) $f)))
          ($fp (mind-first $fps))
          ($n (mind-drop! $id))
          ($t (if (hive-exists? &mind (Forgotten $id $fp $at)) () (add-atom &mind (Forgotten $id $fp $at))))
          ($l (mind-log! forgotten $at $turn $id $n))
          ($others (mind-forget-words! $fp $at)))
         (forgot $id $n $others)))

; The same words held under other ids (stored fingerprints are all under the own salt), with
; evidence as old as the forget or older, go too.
(= (mind-forget-words! $fp $at)
   (if (== $fp none)
       ()
       (let $ids (unique-atom (collapse (match &mind (Words $j $fp)
                                               (match &mind (Said $j $k $t $a) (if (<= $a $at) $j (empty))))))
            (collapse (let $i (superpose $ids)
                           (let* (($n (mind-drop! $i)) ($l (mind-log! purged $at none $i $n))) $i))))))

(= (mind-set-watermark! $at)
   (let* (($w (max (mind-watermark) $at))
          ($old (collapse (match &mind (ForgetAll $x) (ForgetAll $x))))
          ($r (mind-remove-all! $old))
          ($a (add-atom &mind (ForgetAll $w))))
         $w))

; Everything held goes; tombstones, salts and evidence counters stay (so forgotten words
; stay refused, and evidence ids are never minted twice).
(= (mind-forget-all! $at $turn)
   (let* (($held (append (collapse (match &mind (Said $a $b $c $d) (Said $a $b $c $d)))
                 (append (collapse (match &mind (Words $i $f) (Words $i $f)))
                 (append (collapse (match &mind (Current $s $tv $st) (Current $s $tv $st)))
                 (append (collapse (match &mind (Chosen $s1 $k1 $o1) (Chosen $s1 $k1 $o1)))
                         (collapse (match &mind (Promotion $p $v $l) (Promotion $p $v $l))))))))
          ($n (mind-remove-all! $held))
          ($w (mind-set-watermark! $at))
          ($l (mind-log! forgot-all $at $turn none $w)))
         (forgot-all $w $n)))

; ---- attention (the minds' promotion, src/memory.metta get-promotion/promote) ----

(= (mind-promotion $id $now)
   (let $p (collapse (match &mind (Promotion $id $v $last) ($v $last)))
        (if (== $p ())
            0.0
            (let ($v $last) (car-atom $p)
                 (* $v (pow-math (+ 1.0 (/ (max 0.0 (- $now $last)) 86400.0)) (- 0.0 0.7)))))))

(= (mind-use! $id $at $turn)
   (let $p (collapse (match &mind (Promotion $id $v $l) (Promotion $id $v $l)))
        (if (== $p ())
            (refused unknown)
            (let* (($v (min 10.0 (+ 1.0 (mind-promotion $id $at))))
                   ($old (car-atom $p))
                   ($r (remove-atom &mind $old))
                   ($a (add-atom &mind (Promotion $id $v $at)))
                   ($l (mind-log! used $at $turn $id $v)))
                  (used $id $v)))))

; ---- recall ----------------------------------------------------------------------

; One candidate ($id $sim), $sim from the vector index. Held (Belief or Memory), confidence
; >= $minc; score = sim * (0.5 + 0.5 * Truth_Expectation) + 0.05 * promotion. Anything not
; held (forgotten, never held) gives nothing.
(= (mind-score ($id $sim) $now $minc)
   (let $b (collapse (match &mind (Current ($class $id) $tv $s) ($class $tv $s)))
        (if (== $b ())
            (empty)
            (let ($class $tv $s) (car-atom $b)
                 (if (< (tv-confidence $tv) $minc)
                     (empty)
                     (let* (($e (Truth_Expectation $tv))
                            ($p (mind-promotion $id $now))
                            ($score (+ (* $sim (+ 0.5 (* 0.5 $e))) (* 0.05 $p)))
                            ($saids (collapse (match &mind (Said $id $k $t $a) ($k $t))))
                            ($said (car-atom $saids)))
                           (cand (- 0.0 $score) $id $class $sim $p $tv $s $said)))))))

(= (mind-recall $cands $limit $now $minc)
   (let $sorted (sort (collapse (let $c (superpose $cands) (mind-score $c $now $minc))))
        (mind-take $limit $sorted)))

; ---- provenance --------------------------------------------------------------------

; The id's own events, and every other id touched in the same turns.
(= (mind-explain $id)
   (let* (($events (collapse (match &history (Event $n $op $at $turn $id $d) (Event $n $op $at $turn $id $d))))
          ($turns (unique-atom (collapse (match &history (Event $n2 $op2 $at2 $turn2 $id $d2) $turn2))))
          ($linked (unique-atom (collapse (let $t (superpose $turns)
                                     (if (== $t none)
                                         (empty)
                                         (match &history (Event $n3 $op3 $at3 $t $other $d3)
                                                (if (== $other $id) (empty) ($t $other)))))))))
         (explained $id $events $linked)))

; ---- inference (lib_pln) -------------------------------------------------------------

; Every conclusion lib_pln's |~pln draws from the two premises, in this order. An engine that
; leaves an unmatched call unreduced (MeTTaScript) yields it back; it is dropped here, so the
; result is what PeTTa gives.
(= (mind-infer $p1 $p2)
   (collapse (let $r (|~pln $p1 $p2)
                  (if (== (car-atom $r) |~pln) (empty) $r))))

(= (mind-priors $a $b $c) ((STV $a) (STV $b) (STV $c)))

; ---- merging another copy of this space (import) ---------------------------------------

; One item from the other copy, through the same law (hive-integrate!).
(= (mind-merge-item! $class $id $kind $text $fps $at $tv $stamp)
   (if (not (mind-admit? $id $fps $at))
       (skipped $id)
       (let $held (mind-class $id)
            (if (== $held none)
                (let* (($fp (mind-first $fps))
                       ($a1 (add-atom &mind (Said $id $kind $text $at)))
                       ($a2 (add-atom &mind (Words $id $fp)))
                       ($r (hive-integrate! &mind ($class $id) $tv $stamp)))
                      (merged $id $r))
                (if (== $held $class)
                    (let $said (collapse (match &mind (Said $id $k $t $a) ($k $t)))
                         (if (== (car-atom $said) ($kind $text))
                             (let $r (hive-integrate! &mind ($class $id) $tv $stamp) (merged $id $r))
                             (skipped $id)))
                    (skipped $id))))))

; Tombstones are a union: never dropped, whatever the other copy says.
(= (mind-merge-tomb! $id $fp $at)
   (if (hive-exists? &mind (Forgotten $id $fp $at)) known (let $a (add-atom &mind (Forgotten $id $fp $at)) added)))

(= (mind-merge-salt! $s)
   (if (hive-exists? &mind (Salt $s)) known (let $a (add-atom &mind (Salt $s)) added)))

; Evidence counters: the larger, so no evidence id is minted twice.
(= (mind-merge-counter-in! $space $agent $n)
   (let $known (collapse (match $space (EvCounter $agent $m) $m))
        (if (== $known ())
            (let $a (add-atom $space (EvCounter $agent $n)) added)
            (if (>= (car-atom $known) $n)
                known
                (let* (($old (car-atom $known))
                       ($r (remove-atom $space (EvCounter $agent $old)))
                       ($a (add-atom $space (EvCounter $agent $n))))
                      raised)))))

(= (mind-merge-counter! $agent $n) (mind-merge-counter-in! &mind $agent $n))
(= (history-merge-counter! $agent $n) (mind-merge-counter-in! &history $agent $n))

(= (mind-merge-promotion! $id $v $last)
   (let $p (collapse (match &mind (Promotion $id $v0 $l0) (Promotion $id $v0 $l0)))
        (if (== $p ())
            (if (== (mind-class $id) none)
                skipped
                (let $a (add-atom &mind (Promotion $id $v $last)) added))
            (let (Promotion $id $v0 $l0) (car-atom $p)
                 (if (> $last $l0)
                     (let* (($old (car-atom $p)) ($r (remove-atom &mind $old)) ($a (add-atom &mind (Promotion $id $v $last)))) raised)
                     known)))))

(= (mind-merge-chosen! $stmt $kept $other)
   (if (hive-exists? &mind (Chosen $stmt $kept $other)) known
       (if (hive-exists? &mind (Current $stmt $t $s)) (let $a (add-atom &mind (Chosen $stmt $kept $other)) added) skipped)))

(= (mind-merge-event! $n $op $at $turn $id $detail)
   (if (hive-exists? &history (Event $n $o $a $t $i $d)) known
       (let $a (add-atom &history (Event $n $op $at $turn $id $detail)) added)))

; After a merge, everything held is checked again against the merged tombstones and
; watermark: ((id fps at) ...), fps under every salt now in the space.
(= (mind-sweep! $items $at)
   (collapse (let ($id $fps $since) (superpose $items)
                  (if (mind-admit? $id $fps $since)
                      (empty)
                      (let* (($n (mind-drop! $id)) ($l (mind-log! purged $at none $id $n))) $id)))))

; ---- restoring this space's own record (trusted: no merge rules) ------------------------

(= (mind-put-all! $atoms) (let $added (map-atom $atoms $x (add-atom &mind $x)) (size-atom $atoms)))
(= (history-put-all! $atoms) (let $added (map-atom $atoms $x (add-atom &history $x)) (size-atom $atoms)))

; ---- reading -----------------------------------------------------------------------------

; ((id class text at) ...) for everything held.
(= (mind-texts)
   (collapse (match &mind (Current ($class $id) $tv $s)
                    (match &mind (Said $id $k $t $a) ($id $class $t $a)))))

(= (mind-dump) (collapse (match &mind $x $x)))
(= (history-dump) (collapse (match &history $x $x)))

(= (mind-stats)
   (let* (($b (collapse (match &mind (Current (Belief $i) $tv $st) $i)))
          ($m (collapse (match &mind (Current (Memory $j) $tv2 $st2) $j)))
          ($t (collapse (match &mind (Forgotten $k $fp $at) $k)))
          ($e (collapse (match &history (Event $n $op $at2 $turn $id $d) $n)))
          ($nb (size-atom $b)) ($nm (size-atom $m)) ($nt (size-atom $t)) ($ne (size-atom $e))
          ($w (mind-watermark)))
         (stats $nb $nm $nt $ne $w)))

; (item class id (kind text at) tv stamp), or none.
(= (mind-item $id)
   (let $c (collapse (match &mind (Current ($class $id) $tv $s)
                            (let* (($saids (collapse (match &mind (Said $id $k $t $a) ($k $t $a))))
                                   ($said (car-atom $saids)))
                                  (item $class $id $said $tv $s))))
        (mind-first $c)))
