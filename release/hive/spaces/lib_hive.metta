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
; variables, so match unifies it against the concrete statement.  A principal
; (members &commons_s) stands for every member of swarm s, whoever holds the
; publish grant into &commons_s, so a grant to it follows each mind that joins
; or leaves the swarm without being rewritten.
(= (hive-allowed? $acl $principal $space $stmt $right)
   (if (hive-exists? $acl (Grant $principal $space $stmt $right))
       True
       (hive-member-allowed? $acl $principal $space $stmt $right)))

(= (hive-member-allowed? $acl $principal $space $stmt $right)
   (not (== () (collapse (match $acl (Grant (members $commons) $space $stmt $right)
                                (if (hive-exists? $acl (Grant $principal $commons $any publish)) True (empty)))))))

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

; The rule, as a value: what a statement held as $t0 on evidence $s0 becomes
; once $tv on evidence $stamp joins it.  Disjoint evidence revises; evidence
; that overlaps is one source seen twice, so the more confident one is chosen
; and the other kept as it was.  (revised tv stamp), (chosen tv stamp) or
; (kept tv stamp), each naming what the statement then holds.
(= (hive-integrated $t0 $s0 $tv $stamp)
   (if (stamp-disjoint? $s0 $stamp)
       (let* (($tr (hive-truth-revision $t0 $tv))
              ($sr (stamp-merge $s0 $stamp)))
             (revised $tr $sr))
       (if (> (tv-confidence $tv) (tv-confidence $t0))
           (chosen $tv $stamp)
           (kept $t0 $s0))))

; Each statement has one (Current stmt tv stamp) in the commons.
(= (hive-integrate! $commons $stmt $tv $stamp)
   (let $cur (collapse (match $commons (Current $stmt $t0 $s0) (Current $stmt $t0 $s0)))
        (if (== $cur ())
            (let $added (add-atom $commons (Current $stmt $tv $stamp))
                 (adopted $tv $stamp))
            (let (Current $stmt $t0 $s0) (car-atom $cur)
                 (let $result (hive-integrated $t0 $s0 $tv $stamp)
                      (hive-integrated! $commons $stmt $t0 $s0 $stamp $result))))))

; Write one integration's result into the commons, with its choice noted.
(= (hive-integrated! $commons $stmt $t0 $s0 $stamp (revised $tr $sr))
   (let* (($removed (remove-atom $commons (Current $stmt $t0 $s0)))
          ($added (add-atom $commons (Current $stmt $tr $sr))))
         (revised $tr $sr)))
(= (hive-integrated! $commons $stmt $t0 $s0 $stamp (chosen $tv $s1))
   (let* (($removed (remove-atom $commons (Current $stmt $t0 $s0)))
          ($added (add-atom $commons (Current $stmt $tv $s1)))
          ($noted (add-atom $commons (Chosen $stmt $s1 $s0))))
         (chosen $tv $s1)))
(= (hive-integrated! $commons $stmt $t0 $s0 $stamp (kept $t1 $s1))
   (let $noted (add-atom $commons (Chosen $stmt $s1 $stamp))
        (kept $t1 $s1)))

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

; ---- linked belief spaces ------------------------------------------------------------

; A mind's beliefs reach the hive as a read-only space of (Held mind stmt tv stamp)
; atoms, loaded by the host from the mind's own last save and never copied into a
; commons.  A read grant on that space links it into the view of whoever the
; grant admits, for the statements the grant's pattern matches.

; The linked spaces some read grant admits $principal to, directly or as a member.
(= (hive-linked-spaces $acl $principal)
   (list_to_set (union-atom
     (collapse (match $acl (Grant $principal $space $pattern read) $space))
     (collapse (match $acl (Grant (members $commons) $space $pattern read)
                      (if (hive-exists? $acl (Grant $principal $commons $any publish)) $space (empty)))))))

; Every Held atom of those spaces whose statement a read grant admits $principal to.
; Time: one grant check per Held atom of each linked space.
(= (hive-held $acl $principal)
   (hive-held-in $acl $principal (hive-linked-spaces $acl $principal)))

; The same, from only those of $spaces the grants admit: a person reads a swarm's
; view through its members' grants, limited to the minds the hive lets them see.
(= (hive-held-among $acl $principal $spaces)
   (hive-held-in $acl $principal (intersection-atom (hive-linked-spaces $acl $principal) $spaces)))

(= (hive-held-in $acl $principal $spaces)
   (if (== $spaces ())
       ()
       (let* (($space (car-atom $spaces))
              ($here (collapse (match $space (Held $m $s $t $st)
                                      (if (hive-allowed? $acl $principal $space $s read) (Held $m $s $t $st) (empty))))))
             (append $here (hive-held-in $acl $principal (cdr-atom $spaces))))))

; ---- the reader's view of a swarm's beliefs ------------------------------------------

; One (Current stmt tv stamp) per statement that the commons or an admitted linked
; belief holds: the integration rule folded over the statement's sources.  A belief
; a mind holds after reading another's carries the stamp it read, so it never
; raises confidence; beliefs on disjoint evidence revise.  The fold takes evidence
; before what was formed from it: sources with fewer evidence ids first, since a
; stamp that includes another's was read from it (an echo of a revised belief holds
; the merged stamp), then the commons' Current before the minds', then by mind,
; so the order and the result are the same at every read.
; Time: n log n comparisons to sort the n sources, then n integrations.
(= (hive-currents $commons $held)
   (hive-fold-sources (collapse (match $commons (Current $s $t $st) (hive-source $s commons 0 $t $st))) $held))

; The same for one statement.
(= (hive-statement-current $commons $held $stmt)
   (hive-fold-sources (collapse (match $commons (Current $stmt $t $st) (hive-source $stmt commons 0 $t $st)))
                      (collapse (let (Held $m $s $t $st) (superpose $held)
                                     (if (== $s $stmt) (Held $m $s $t $st) (empty))))))

; A source as the fold sorts it: statement, evidence count, commons or mind, who.
(= (hive-source $s $who $order $t $st)
   (let $count (length $st) ($s $count $order $who $t $st)))

(= (hive-fold-sources $own $held)
   (let* (($linked (collapse (let (Held $m $s $t $st) (superpose $held) (hive-source $s $m 1 $t $st))))
          ($sources (sort (append $own $linked))))
         (hive-fold-currents $sources () () ())))

; $sources sorted by statement; $s the statement being folded, $acc its (tv stamp)
; so far, $out the Currents already finished.
(= (hive-fold-currents $sources $s $acc $out)
   (if (== $sources ())
       (hive-current-out $s $acc $out)
       (let* ((($s1 $count $order $who $t $st) (car-atom $sources))
              ($rest (cdr-atom $sources)))
             (if (== $s1 $s)
                 (hive-fold-currents $rest $s (hive-integrate-value $acc $t $st) $out)
                 (hive-fold-currents $rest $s1 ($t $st) (hive-current-out $s $acc $out))))))

(= (hive-current-out $s $acc $out)
   (if (== $acc ())
       $out
       (let ($t $st) $acc (cons-atom (Current $s $t $st) $out))))

(= (hive-integrate-value $acc $tv $stamp)
   (let* ((($t0 $s0) $acc)
          (($outcome $t1 $s1) (hive-integrated $t0 $s0 $tv $stamp)))
         ($t1 $s1)))

; Who the view's belief in $stmt rests on: the minds whose assertion in the commons
; or held belief shares the evidence $stamp the view holds it on.
(= (hive-view-sources $commons $held $stmt $stamp)
   (list_to_set (append
     (collapse (match $commons (Asserted $agent $stmt $tv $s2)
                      (if (stamp-disjoint? $s2 $stamp) (empty) $agent)))
     (collapse (let (Held $m $s $t $s3) (superpose $held)
                    (if (== $s $stmt) (if (stamp-disjoint? $s3 $stamp) (empty) $m) (empty)))))))

; The view's beliefs as rows (stmt tv stamp sources).
; Time: the Currents', then one pass over the commons and $held per statement.
(= (hive-view-rows $commons $held)
   (let $currents (hive-currents $commons $held)   ; bound first: PeTTa's superpose doesn't evaluate a call
        (collapse (let (Current $s $t $st) (superpose $currents)
                       ($s $t $st (hive-view-sources $commons $held $s $st))))))

(= (hive-current? $atom)
   (if (== (get-metatype $atom) Expression)
       (if (== $atom ()) False (== (car-atom $atom) Current))
       False))

; Match $pattern over the reader's one view of commons $commons: the view's
; Currents, the admitted Held atoms naming the mind that holds each, and the
; commons' other atoms (Asserted, Chosen, Quarantined) as they are.
(= (hive-belief-view $commons $acl $principal $pattern)
   (let* (($held (hive-held $acl $principal))
          ($others (collapse (match $commons $atom (if (hive-current? $atom) (empty) $atom))))
          ($atoms (append (hive-currents $commons $held) (append $held $others))))
         (collapse (let $pattern (superpose $atoms) $pattern))))
