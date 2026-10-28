; Holarchy smoke: Omega memory spaces nested inside swarm spaces nested inside
; a federation space, with beliefs published upward and revised across swarms.
;
; Levels:
;   L0  each Omega's private memory space   (&omega_a, &omega_b, &omega_x)
;   L1  each swarm space: members + commons  (&swarm_mine, &swarm_theirs)
;   L2  the federation space: swarms + commons (&federation)
;
; In PeTTa a space is a name, so a space handle stored as an atom in another
; space is a nested space: match the outer space, then match inside the handle.
; Each level only sees what was published into the commons below it.

!(import! &self ../lib_nal)

; ---- L0: private Omega memory -------------------------------------------------

!(bind! &omega_a (new-space))
!(bind! &omega_b (new-space))
!(bind! &omega_x (new-space))

!(add-atom &omega_a (Belief (--> sky blue) (stv 0.9 0.8)))
!(add-atom &omega_a (Private diary "omega-a private note"))
!(add-atom &omega_a (Belief (--> owner tired) (stv 0.7 0.5)))
!(add-atom &omega_b (Belief (--> sky blue) (stv 0.8 0.5)))
!(add-atom &omega_x (Belief (--> sky blue) (stv 0.1 0.6)))
!(add-atom &omega_x (Private diary "omega-x private note"))

; ---- L1: swarms ---------------------------------------------------------------

!(bind! &commons_mine (new-space))
!(bind! &commons_theirs (new-space))
!(bind! &swarm_mine (new-space))
!(bind! &swarm_theirs (new-space))

!(add-atom &swarm_mine (Member omega-a &omega_a))
!(add-atom &swarm_mine (Member omega-b &omega_b))
!(add-atom &swarm_mine (Commons &commons_mine))
!(add-atom &swarm_theirs (Member omega-x &omega_x))
!(add-atom &swarm_theirs (Commons &commons_theirs))

; ---- L2: federation -----------------------------------------------------------

!(bind! &federation_commons (new-space))
!(bind! &federation (new-space))

!(add-atom &federation (Swarm mine &swarm_mine))
!(add-atom &federation (Swarm theirs &swarm_theirs))
!(add-atom &federation (Commons &federation_commons))

; ---- Publishing: copy one chosen belief upward with provenance ------------------

; Publishing the same statement twice from the same Omega must not count its
; evidence twice, so an existing assertion from that source is left as is.
(= (publish! $who $private $commons $stmt)
   (match $private (Belief $stmt $tv)
          (if (== () (collapse (match $commons (Asserted $who $stmt $_) True)))
              (add-atom $commons (Asserted $who $stmt $tv))
              already-published)))

!(publish! omega-a &omega_a &commons_mine (--> sky blue))
!(publish! omega-a &omega_a &commons_mine (--> sky blue))
!(publish! omega-b &omega_b &commons_mine (--> sky blue))
!(publish! omega-x &omega_x &commons_theirs (--> sky blue))

; ---- Federation queries: reach through every level via commons only ---------------

(= (federated-assertion $stmt)
   (match &federation (Swarm $swarm $swarmspace)
          (match $swarmspace (Commons $commons)
                 (match $commons (Asserted $who $stmt $tv)
                        (From $swarm $who $tv)))))

(= (federated-sources $stmt)
   (collapse (let (From $swarm $who $tv) (federated-assertion $stmt) ($swarm $who))))

(= (federated-tvs $stmt)
   (collapse (let (From $swarm $who $tv) (federated-assertion $stmt) $tv)))

(= (revise-list $tv $rest)
   (if (== $rest ())
       $tv
       (revise-list (Truth_Revision $tv (car-atom $rest)) (cdr-atom $rest))))

(= (revise-all $tvs)
   (revise-list (car-atom $tvs) (cdr-atom $tvs)))

(= (reverse-list $xs $acc)
   (if (== $xs ()) $acc (reverse-list (cdr-atom $xs) (cons-atom (car-atom $xs) $acc))))

(= (approx $a $b)
   (and (< (- $a $b) 0.0001) (< (- $b $a) 0.0001)))

; Everything the federation can see, at any depth below it, through commons.
(= (federation-visible $pattern)
   (collapse (match &federation (Swarm $swarm $swarmspace)
                    (match $swarmspace (Commons $commons)
                           (match $commons $pattern $pattern)))))

; ---- Checks -----------------------------------------------------------------------

!(if (== (size-atom (federated-sources (--> sky blue))) 3)
     (println! HOLARCHY-THREE-SOURCES-ACROSS-TWO-SWARMS-OK)
     (println! (FAILED-HOLARCHY-THREE-SOURCES (federated-sources (--> sky blue)))))

!(if (== (size-atom (collapse (match &commons_mine (Asserted omega-a (--> sky blue) $tv) $tv))) 1)
     (println! HOLARCHY-DUPLICATE-PUBLISH-NOT-DOUBLE-COUNTED-OK)
     (println! FAILED-HOLARCHY-DUPLICATE-PUBLISH))

!(if (== (federation-visible (Private $k $v)) ())
     (println! HOLARCHY-PRIVATE-ATOMS-NOT-VISIBLE-OK)
     (println! (FAILED-HOLARCHY-PRIVATE-LEAK (federation-visible (Private $k $v)))))

!(if (== (federation-visible (Asserted $w (--> owner tired) $tv)) ())
     (println! HOLARCHY-UNPUBLISHED-BELIEF-NOT-VISIBLE-OK)
     (println! FAILED-HOLARCHY-UNPUBLISHED-BELIEF-LEAK))

; Expected by hand: weights 4 + 1 + 1.5 = 6.5, f = 4.55 / 6.5 = 0.7, c = 6.5 / 7.5 = 0.86667
!(let (stv $f $c) (revise-all (federated-tvs (--> sky blue)))
      (if (and (approx $f 0.7) (approx $c 0.866667))
          (println! HOLARCHY-CROSS-SWARM-REVISION-OK)
          (println! (FAILED-HOLARCHY-CROSS-SWARM-REVISION (stv $f $c)))))

!(let* (($tvs (federated-tvs (--> sky blue)))
        ((stv $f1 $c1) (revise-all $tvs))
        ((stv $f2 $c2) (revise-all (reverse-list $tvs ()))))
       (if (and (approx $f1 $f2) (approx $c1 $c2))
           (println! HOLARCHY-REVISION-ORDER-INDEPENDENT-OK)
           (println! (FAILED-HOLARCHY-REVISION-ORDER (stv $f1 $c1) (stv $f2 $c2)))))

; The revised belief lands in the federation commons with its sources kept.
; add-atom stores its argument unevaluated, so compute the parts first.
!(let* (($tv (revise-all (federated-tvs (--> sky blue))))
        ($sources (federated-sources (--> sky blue))))
       (add-atom &federation_commons (Revised (--> sky blue) $tv $sources)))

!(if (== (collapse (match &federation (Commons $c)
                           (match $c (Revised (--> sky blue) (stv $f $cf) $sources)
                                  (size-atom $sources))))
         (3))
     (println! HOLARCHY-REVISED-BELIEF-IN-FEDERATION-COMMONS-OK)
     (println! FAILED-HOLARCHY-REVISED-BELIEF-IN-FEDERATION-COMMONS))

; Private memory is untouched by publishing and revision.
!(if (== (collapse (match &omega_x (Belief (--> sky blue) $tv) $tv)) ((stv 0.1 0.6)))
     (println! HOLARCHY-PRIVATE-MEMORY-UNCHANGED-OK)
     (println! FAILED-HOLARCHY-PRIVATE-MEMORY-CHANGED))
