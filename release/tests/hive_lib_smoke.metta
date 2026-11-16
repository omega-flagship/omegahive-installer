; Smoke test for hive/spaces/lib_hive.metta: access control, vocabulary
; quarantine, evidential stamps, echo protection and revision.

!(import! &self ../hive/spaces/lib_hive)
!(import! &self ../lib_nal)

(= (approx $a $b)
   (and (< (- $a $b) 0.0001) (< (- $b $a) 0.0001)))

(= (current-tv $commons $stmt)
   (car-atom (collapse (match $commons (Current $stmt $tv $s) $tv))))

(= (current-stamp $commons $stmt)
   (car-atom (collapse (match $commons (Current $stmt $tv $s) $s))))

; omega-a and omega-b may publish anything; omega-x only statements about the sky;
; omega-z has no grant at all.
!(add-atom &hive_acl (Grant omega-a &commons_s $stmt publish))
!(add-atom &hive_acl (Grant omega-b &commons_s $stmt publish))
!(add-atom &hive_acl (Grant omega-x &commons_s (--> sky $what) publish))

!(hive-vocab-add! &vocab_s sky omega-a)
!(hive-vocab-add! &vocab_s blue omega-a)
!(hive-vocab-add! &vocab_s green omega-a)

!(if (== (hive-vocab-add! &vocab_s sky omega-b) (known sky))
     (println! HIVE-VOCAB-ADD-IDEMPOTENT-OK)
     (println! FAILED-HIVE-VOCAB-ADD-IDEMPOTENT))

!(let* (((stv $f1 $c1) (hive-truth-revision (stv 0.9 0.8) (stv 0.1 0.6)))
        ((stv $f2 $c2) (Truth_Revision (stv 0.9 0.8) (stv 0.1 0.6))))
       (if (and (approx $f1 $f2) (approx $c1 $c2))
           (println! HIVE-REVISION-MATCHES-LIB-NAL-OK)
           (println! (FAILED-HIVE-REVISION-DIFFERS-FROM-LIB-NAL (stv $f1 $c1) (stv $f2 $c2)))))

; ---- evidence ids --------------------------------------------------------------

!(let* (($e1 (hive-next-evidence! &hive_counters omega-a))
        ($e2 (hive-next-evidence! &hive_counters omega-a))
        ($e3 (hive-next-evidence! &hive_counters omega-x)))
       (if (and (== ($e1 $e2 $e3) ((ev omega-a 1) (ev omega-a 2) (ev omega-x 1))) True)
           (println! HIVE-EVIDENCE-IDS-OK)
           (println! (FAILED-HIVE-EVIDENCE-IDS $e1 $e2 $e3))))

; ---- access control and vocabulary ---------------------------------------------

!(if (== (hive-publish! &commons_s &vocab_s &hive_acl omega-z (--> sky blue) (stv 1.0 0.9) ((ev omega-z 1)))
         (denied omega-z (--> sky blue)))
     (println! HIVE-UNGRANTED-AGENT-DENIED-OK)
     (println! FAILED-HIVE-UNGRANTED-AGENT-DENIED))

!(if (== (hive-publish! &commons_s &vocab_s &hive_acl omega-x (--> grass green) (stv 1.0 0.9) ((ev omega-x 9)))
         (denied omega-x (--> grass green)))
     (println! HIVE-PATTERN-SCOPED-GRANT-OK)
     (println! FAILED-HIVE-PATTERN-SCOPED-GRANT))

!(if (== (hive-publish! &commons_s &vocab_s &hive_acl omega-a (--> sky glorp) (stv 1.0 0.9) ((ev omega-a 9)))
         (quarantined (glorp)))
     (println! HIVE-UNMAPPED-SYMBOL-QUARANTINED-OK)
     (println! FAILED-HIVE-UNMAPPED-SYMBOL-QUARANTINED))

!(if (hive-exists? &commons_s (Current (--> sky glorp) $tv $s))
     (println! FAILED-HIVE-QUARANTINED-BELIEF-INTEGRATED)
     (println! HIVE-QUARANTINED-BELIEF-NOT-INTEGRATED-OK))

; ---- adopt, duplicate, echo, revise ---------------------------------------------

!(if (== (hive-publish! &commons_s &vocab_s &hive_acl omega-a (--> sky blue) (stv 0.9 0.8) ((ev omega-a 1)))
         (adopted (stv 0.9 0.8) ((ev omega-a 1))))
     (println! HIVE-FIRST-BELIEF-ADOPTED-OK)
     (println! FAILED-HIVE-FIRST-BELIEF-ADOPTED))

!(if (== (hive-publish! &commons_s &vocab_s &hive_acl omega-a (--> sky blue) (stv 0.9 0.8) ((ev omega-a 1)))
         duplicate)
     (println! HIVE-DUPLICATE-PUBLISH-OK)
     (println! FAILED-HIVE-DUPLICATE-PUBLISH))

; omega-b learned the belief from omega-a and republishes it with omega-a's
; evidence.  Overlapping stamps: no revision, confidence must not rise.
!(hive-publish! &commons_s &vocab_s &hive_acl omega-b (--> sky blue) (stv 0.9 0.8) ((ev omega-a 1)))

!(let (stv $f $c) (current-tv &commons_s (--> sky blue))
      (if (approx $c 0.8)
          (println! HIVE-ECHO-DOES-NOT-INFLATE-OK)
          (println! (FAILED-HIVE-ECHO-INFLATED (stv $f $c)))))

; omega-x has independent evidence that disagrees: revise.
; Weights 4 + 1.5 = 5.5, f = (3.6 + 0.15) / 5.5 = 0.68182, c = 5.5 / 6.5 = 0.84615
!(let (revised (stv $f $c) $stamp)
      (hive-publish! &commons_s &vocab_s &hive_acl omega-x (--> sky blue) (stv 0.1 0.6) ((ev omega-x 1)))
      (if (and (approx $f 0.681818) (and (approx $c 0.846154) (== $stamp ((ev omega-a 1) (ev omega-x 1)))))
          (println! HIVE-INDEPENDENT-EVIDENCE-REVISED-OK)
          (println! (FAILED-HIVE-INDEPENDENT-EVIDENCE-REVISED (stv $f $c) $stamp))))

; omega-b echoes the revised belief back with its merged stamp: still no inflation.
!(hive-publish! &commons_s &vocab_s &hive_acl omega-b (--> sky blue) (stv 0.681818 0.846154)
                ((ev omega-a 1) (ev omega-x 1)))

!(let (stv $f $c) (current-tv &commons_s (--> sky blue))
      (if (approx $c 0.846154)
          (println! HIVE-ECHO-OF-REVISION-DOES-NOT-INFLATE-OK)
          (println! (FAILED-HIVE-ECHO-OF-REVISION-INFLATED (stv $f $c)))))

; A stronger belief resting on overlapping evidence replaces the current one by
; choice instead of being revised with it.
!(if (== (hive-publish! &commons_s &vocab_s &hive_acl omega-a (--> sky blue) (stv 0.95 0.9)
                        ((ev omega-a 1) (ev omega-a 2)))
         (chosen (stv 0.95 0.9) ((ev omega-a 1) (ev omega-a 2))))
     (println! HIVE-OVERLAPPING-STRONGER-BELIEF-CHOSEN-OK)
     (println! FAILED-HIVE-OVERLAPPING-STRONGER-BELIEF-CHOSEN))

!(if (== (sort (hive-sources &commons_s (--> sky blue))) (omega-a omega-b))
     (println! HIVE-SOURCES-FOLLOW-EVIDENCE-OK)
     (println! (FAILED-HIVE-SOURCES (hive-sources &commons_s (--> sky blue)))))

; ---- union view ----------------------------------------------------------------------

!(add-atom &private_a (Belief (--> owner tired) (stv 0.7 0.5)))

!(if (== (size-atom (hive-view (&private_a &commons_s) (Belief $s $t))) 1)
     (println! HIVE-VIEW-PRIVATE-PART-OK)
     (println! FAILED-HIVE-VIEW-PRIVATE-PART))

!(if (== (size-atom (hive-view (&private_a &commons_s) (Current $s $t $st))) 1)
     (println! HIVE-VIEW-SHARED-PART-OK)
     (println! FAILED-HIVE-VIEW-SHARED-PART))
