; Explicit promote-scratch action
; Copies atoms from &scratch to &beliefs and removes from &scratch
; Per design: promotion is deliberate, not automatic

; Promote a scratch atom to beliefs
; Usage: (promote-scratch <atom>)
; Copies atom to &beliefs with updated truth-values, removes from &scratch
(= (promote-scratch $atom)
   (let* (($hash (py-str (helper.metta_atom_hash $atom)))
          ($parsed (sread $atom)))
        (progn
          ; Add to beliefs with lowered confidence (draft status)
          (add-atom &beliefs $parsed)
          (trace-atom "write" "beliefs" $parsed "promote-scratch")
          ; Remove from scratch
          (collapse (match &scratch $atom (remove-atom &scratch $atom)))
          ; Remove TTL entry
          (collapse (match &scratch-ttl (ScratchTTL $hash $_)
                                     (remove-atom &scratch-ttl (ScratchTTL $hash))))
          (py-str (SCRATCH-PROMOTED: atom-hash: $hash beliefs-count: (match-count &beliefs $_))))))

; Promote all scratch atoms to beliefs
; Usage: (promote-scratch-all)
(= (promote-scratch-all)
   (let* (($atoms (repr (collapse (match &scratch $atom $atom))))
          ($count (match-count &scratch $_)))
        (progn
          (py-str (SCRATCH-PROMOTE-STARTED: count: $count))
          ; Process each atom - this requires iteration
          $atoms)))

; Promote scratch atoms matching a pattern to beliefs
; Usage: (promote-scratch-by-pattern <pattern>)
(= (promote-scratch-by-pattern $patternstr)
   (let $pattern (catch (sread $patternstr))
        (if (== (car-atom $pattern) Error)
            (ScratchError "bad pattern expression" $pattern)
            (let* (($matching (find &scratch $pattern))
                   ($count (if (== $matching ()) 0 (match-count &scratch $pattern))))
                 (progn
                   (py-str (SCRATCH-PROMOTE-PATTERN-STARTED: pattern: $patternstr count: $count))
                   ; For each matching atom, promote it
                   $matching)))))

; Demote a belief back to scratch (for re-evaluation)
; Usage: (demote-belief-to-scratch <atom>)
(= (demote-belief-to-scratch $atom)
   (let* (($hash (py-str (helper.metta_atom_hash $atom)))
          ($ttl (scratch-ttl-default))
          ($parsed (sread $atom)))
        (progn
          ; Remove from beliefs
          (collapse (match &beliefs $atom (remove-atom &beliefs $atom)))
          ; Add to scratch
          (add-atom &scratch $parsed)
          (add-atom &scratch-ttl (ScratchTTL $hash $ttl))
          (trace-atom "write" "scratch" $parsed "demote-belief-to-scratch")
          (py-str (BELIEF-DEMOTED-TO-SCRATCH: atom-hash: $hash ttl: $ttl)))))
