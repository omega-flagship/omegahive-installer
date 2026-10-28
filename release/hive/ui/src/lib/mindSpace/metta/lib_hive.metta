; lib_hive: shared-space semantics for OmegaDots Hive swarms and federations.
;
; Spaces are PeTTa names, so a swarm commons, its vocabulary and the access
; list are passed in as plain handles (&commons_x, &vocab_x, &hive_acl).
;
; Beliefs carry evidential stamps: sorted lists of globally unique evidence ids
; such as (ev omega-a 1).  Two beliefs are revised only when their stamps are
; disjoint; otherwise the higher-confidence one is kept (choice).  This keeps
; agents that echo each other from inflating confidence.
;
; add-atom stores its argument unevaluated, so every stored value is computed
; with let/let* first.
;
; PeTTa resolves import! paths against the main file's directory, not the
; importing file's, so this library imports nothing and is safe to load from
; anywhere.

; ---- truth values ------------------------------------------------------------

; Same rule as Truth_Revision in lib_nal.metta; tests/hive_lib_smoke.metta
; checks the two agree.
(= (hive-c2w $c) (/ $c (- 1 $c)))
(= (hive-w2c $w) (/ $w (+ $w 1)))

(= (hive-truth-revision (stv $f1 $c1) (stv $f2 $c2))
   (let* (($w1 (hive-c2w $c1))
          ($w2 (hive-c2w $c2))
          ($w (+ $w1 $w2))
          ($f (/ (+ (* $w1 $f1) (* $w2 $f2)) $w))
          ($c (hive-w2c $w)))
         (stv (min 1.00 $f) (min 0.99 (max (max $c $c1) $c2)))))

; ---- small helpers -----------------------------------------------------------

(= (hive-exists? $space $pattern)
   (not (== () (collapse (match $space $pattern True)))))

(= (stamp-disjoint? $a $b)
   (== () (intersection-atom $a $b)))

(= (stamp-merge $a $b)
   (sort (list_to_set (union-atom $a $b))))

(= (tv-confidence (stv $f $c)) $c)

; ---- evidence ids ------------------------------------------------------------

; Mint the next evidence id for an agent, kept as (EvCounter agent n) in $space.
(= (hive-next-evidence! $space $agent)
   (let $known (collapse (match $space (EvCounter $agent $n) $n))
        (if (== $known ())
            (let $added (add-atom $space (EvCounter $agent 1)) (ev $agent 1))
            (let* (($n (car-atom $known))
                   ($next (+ $n 1))
                   ($removed (remove-atom $space (EvCounter $agent $n)))
                   ($added (add-atom $space (EvCounter $agent $next))))
                  (ev $agent $next)))))

; ---- access control ------------------------------------------------------------

; Grants are (Grant principal space pattern right).  The stored pattern may hold
; variables, so match unifies it against the concrete statement.
(= (hive-allowed? $acl $principal $space $stmt $right)
   (hive-exists? $acl (Grant $principal $space $stmt $right)))

; ---- shared vocabulary -----------------------------------------------------------

(= (hive-structural? $sym)
   (is-member $sym (--> <-> ==> <=> && || -- stv)))

(= (stmt-symbols $x)
   (if (== (get-metatype $x) Expression)
       (if (== $x ())
           ()
           (union-atom (stmt-symbols (car-atom $x)) (stmt-symbols (cdr-atom $x))))
       (if (== (get-metatype $x) Symbol) ($x) ())))

(= (hive-unmapped-in $vocab $syms)
   (if (== $syms ())
       ()
       (let* (($s (car-atom $syms))
              ($rest (hive-unmapped-in $vocab (cdr-atom $syms))))
             (if (or (hive-structural? $s) (hive-exists? $vocab (Term $s)))
                 $rest
                 (cons-atom $s $rest)))))

; Symbols in $stmt that are neither structural nor terms of the vocabulary.
(= (hive-unmapped $vocab $stmt)
   (list_to_set (hive-unmapped-in $vocab (stmt-symbols $stmt))))

(= (hive-vocab-add! $vocab $sym $agent)
   (if (hive-exists? $vocab (Term $sym))
       (known $sym)
       (let $added (add-atom $vocab (Term $sym)) (added $sym))))

; ---- integrating a belief into a commons -----------------------------------------

; Each statement has one (Current stmt tv stamp) in the commons.
(= (hive-integrate! $commons $stmt $tv $stamp)
   (let $cur (collapse (match $commons (Current $stmt $t0 $s0) (Current $stmt $t0 $s0)))
        (if (== $cur ())
            (let $added (add-atom $commons (Current $stmt $tv $stamp))
                 (adopted $tv $stamp))
            (let (Current $stmt $t0 $s0) (car-atom $cur)
                 (if (stamp-disjoint? $s0 $stamp)
                     (let* (($tr (hive-truth-revision $t0 $tv))
                            ($sr (stamp-merge $s0 $stamp))
                            ($removed (remove-atom $commons (Current $stmt $t0 $s0)))
                            ($added (add-atom $commons (Current $stmt $tr $sr))))
                           (revised $tr $sr))
                     (if (> (tv-confidence $tv) (tv-confidence $t0))
                         (let* (($removed (remove-atom $commons (Current $stmt $t0 $s0)))
                                ($added (add-atom $commons (Current $stmt $tv $stamp)))
                                ($noted (add-atom $commons (Chosen $stmt $stamp $s0))))
                               (chosen $tv $stamp))
                         (let $noted (add-atom $commons (Chosen $stmt $s0 $stamp))
                              (kept $t0 $s0))))))))

; ---- publishing ------------------------------------------------------------------

; Publish one belief from $agent into a swarm or federation commons.
; Returns (denied ...), (quarantined ...), duplicate, or the integrate result.
(= (hive-publish! $commons $vocab $acl $agent $stmt $tv $stamp)
   (if (not (hive-allowed? $acl $agent $commons $stmt publish))
       (denied $agent $stmt)
       (let $unmapped (hive-unmapped $vocab $stmt)
            (if (not (== $unmapped ()))
                (let $noted (add-atom $commons (Quarantined $agent $stmt $unmapped))
                     (quarantined $unmapped))
                (if (hive-exists? $commons (Asserted $agent $stmt $tv $stamp))
                    duplicate
                    (let $added (add-atom $commons (Asserted $agent $stmt $tv $stamp))
                         (hive-integrate! $commons $stmt $tv $stamp)))))))

; Sources behind the current belief: agents whose assertions share its evidence.
(= (hive-sources $commons $stmt)
   (let $cur (collapse (match $commons (Current $stmt $t $s) $s))
        (if (== $cur ())
            ()
            (let $stamp (car-atom $cur)
                 (list_to_set
                   (collapse (match $commons (Asserted $agent $stmt $tv $s2)
                                    (if (stamp-disjoint? $s2 $stamp) (empty) $agent))))))))

; ---- union view --------------------------------------------------------------------

; Query several spaces as one view: private + swarm + federation.
(= (hive-view $spaces $pattern)
   (if (== $spaces ())
       ()
       (union-atom (collapse (match (car-atom $spaces) $pattern $pattern))
                   (hive-view (cdr-atom $spaces) $pattern))))
