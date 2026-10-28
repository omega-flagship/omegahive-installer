; Garbage collection for scratch space
; Loop step that checks scratch-ttl table and removes expired atoms

; Decrement TTL for all scratch atoms
; Usage: (gc-scratch-decrement)
; Decrements each TTL by 1, removes expired (TTL <= 0) atoms
(= (gc-scratch-decrement)
   (let* (($entries (collapse (match &scratch-ttl (ScratchTTL $hash $ttl) (ScratchTTL $hash $ttl))))
          ($count (if (== $entries ()) 0 (match-count &scratch-ttl $_))))
        (progn
          (gc-scratch-decrement-iter $entries)
          (py-str (SCRATCH-GC-DECREMENTED: count: $count)))))

; Iterative helper for decrementing TTL
(= (gc-scratch-decrement-iter $entries)
   (if (== $entries ())
       ()
       (let* (($entry (car-atom $entries))
              ($rest (cdr-atom $entries))
              ($hash (if (== $entry ()) ()
                        (let* (($first (car-atom $entry))
                               ($rest1 (cdr-atom $first)))
                               (car-atom $rest1))))
              ($ttl (if (== $entry ()) ()
                        (let* (($first (car-atom $entry))
                               ($rest1 (cdr-atom $first)))
                               (car-atom (cdr-atom $rest1))))))
              (progn
                ; Decrement TTL
                (if (<= $ttl 1)
                    ; TTL expired, remove atom and TTL entry
                    (progn
                      (collapse (match &scratch-ttl (ScratchTTL $hash $_)
                                                 (remove-atom &scratch-ttl (ScratchTTL $hash))))
                      (let* (($atom (find-atom-by-hash $hash)))
                           (if (== $atom ())
                               ()
                               (progn
                                 (collapse (match &scratch $atom (remove-atom &scratch $atom)))
                                 (trace-atom "remove" "scratch" $atom "gc-scratch-expired")
                                 (py-str (SCRATCH-ATOM-EXPIRED: atom-hash: $hash ttl: $ttl))))))
                    ; TTL still active, update with decremented value
                    (progn
                      (collapse (match &scratch-ttl (ScratchTTL $hash $_)
                                                 (remove-atom &scratch-ttl (ScratchTTL $hash))))
                      (add-atom &scratch-ttl (ScratchTTL $hash (- $ttl 1)))))
                (gc-scratch-decrement-iter $rest)))))

; Find atom by hash (helper function)
; This requires looking up the atom that corresponds to the hash
(= (find-atom-by-hash $hash)
   (let* (($all-atoms (collapse (match &scratch $atom $atom)))
          ($found (find-atom-by-hash-iter $all-atoms $hash)))
        $found))

(= (find-atom-by-hash-iter $atoms $hash)
   (if (== $atoms ())
       ()
       (let* (($atom (car-atom $atoms))
              ($rest (cdr-atom $atoms))
              ($atom-hash (py-str (helper.metta_atom_hash (repr $atom)))))
              (if (== $atom-hash $hash)
                  $atom
                  (find-atom-by-hash-iter $rest $hash)))))

; GC loop step - called each cycle
; Usage: (gc-scratch-loop-step)
; Main entry point for garbage collection
(= (gc-scratch-loop-step)
   (progn
     (gc-scratch-decrement)
     (gc-scratch-summary)))

; GC summary for monitoring
; Usage: (gc-scratch-summary)
(= (gc-scratch-summary)
   (let* (($scratch-count (match-count &scratch $_))
          ($ttl-count (match-count &scratch-ttl $_)))
        (py-str (SCRATCH-GC-SUMMARY: atoms: $scratch-count ttl-entries: $ttl-count))))
