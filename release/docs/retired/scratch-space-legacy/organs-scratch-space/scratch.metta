; &scratch transient reasoning space implementation
; MeTTa/AtomSpace based on design decisions in an earlier scratch-space design dialogue (internal note)
;
; Design principles:
; (1) Space-as-type convention: &scratch = draft. Spatial separation, not truth-value flags.
; (2) Side-table scratch-ttl: Loop-count TTL default 3, decrement per loop, touch resets
; (3) Persist-on-shutdown: Save atoms with TTL, decrement TTL by 1 on load (natural decay)
; (4) Explicit promote-scratch: Copies to &beliefs, removes from &scratch
; (5) Garbage collection: Loop step checks scratch-ttl, removes expired atoms

!(import_prolog_function string_length)

; Scratch space registration
; Spatial separation: &scratch = draft, &beliefs = committed, &persistent = sacred
(bind! &scratch (new-space))

; Scratch TTL side-table: (scratch-ttl <atom-hash> <remaining-loops>)
; TTL is tracked per-atom using a hash key for lookup
; Default TTL is 3 loops as per design decision
(bind! &scratch-ttl (new-space))

; Register scratch space in the space registry
(= (register-scratch-space)
   (progn
     (collapse (match &self (SpaceRegistry "scratch" $oldhandle $oldrole)
                            (remove-atom &self (SpaceRegistry "scratch" $oldhandle $oldrole))))
     (add-atom &self (SpaceRegistry "scratch" &scratch memory))
     (SpaceRegistered "scratch" "memory")))

; Register scratch TTL table
(= (register-scratch-ttl)
   (progn
     (add-atom &self (ScratchTTLSpace &scratch-ttl))
     (ScratchTTLSpaceRegistered)))

; Register scratch space and TTL table
!(register-scratch-space)
!(register-scratch-ttl)

; Scratch TTL default value
(= (scratch-ttl-default) 3)

; Add an atom to &scratch with TTL
; Usage: (scratch-add <atom> [ttl])
; Default TTL is 3 if not specified
(= (scratch-add $atom)
   (scratch-add $atom (scratch-ttl-default)))

(= (scratch-add $atom $ttl)
   (let* (($hash (py-str (helper.metta_atom_hash $atom)))
          ($parsed (sread $atom)))
        (progn
          (add-atom &scratch $parsed)
          (add-atom &scratch-ttl (ScratchTTL $hash $ttl))
          (trace-atom "write" "scratch" $parsed "scratch-add")
          (py-str (SCRATCH-ATOM-ADDED: atom-hash: $hash ttl: $ttl)))))

; Touch a scratch atom to reset its TTL
; Usage: (scratch-touch <atom>)
; Resets TTL to default value
(= (scratch-touch $atom)
   (let* (($hash (py-str (helper.metta_atom_hash $atom)))
          ($ttl (scratch-ttl-default)))
        (progn
          (collapse (match &scratch-ttl (ScratchTTL $hash $oldttl)
                                     (remove-atom &scratch-ttl (ScratchTTL $hash $oldttl))))
          (add-atom &scratch-ttl (ScratchTTL $hash $ttl))
          (py-str (SCRATCH-TTL-TOUCHED: atom-hash: $hash new-ttl: $ttl)))))

; Get TTL for a scratch atom
; Usage: (scratch-get-ttl <atom>)
(= (scratch-get-ttl $atom)
   (let* (($hash (py-str (helper.metta_atom_hash $atom))))
        (repr (collapse (match &scratch-ttl (ScratchTTL $hash $remaining) $remaining)))))

; Get all scratch atoms
; Usage: (scratch-atoms)
(= (scratch-atoms)
   (repr (collapse (match &scratch $atom $atom))))

; Get all scratch TTL entries
; Usage: (scratch-ttl-all)
(= (scratch-ttl-all)
   (repr (collapse (match &scratch-ttl (ScratchTTL $hash $ttl) (ScratchTTL $hash $ttl)))))

; Count scratch atoms matching a pattern
; Usage: (scratch-count <pattern>)
(= (scratch-count $patternstr)
   (let $pattern (catch (sread $patternstr))
        (if (== (car-atom $pattern) Error)
            (ScratchError "bad pattern expression" $pattern)
            (match-count &scratch $pattern))))

; Find scratch atoms matching a pattern
; Usage: (scratch-find <pattern>)
(= (scratch-find $patternstr)
   (let $pattern (catch (sread $patternstr))
        (if (== (car-atom $pattern) Error)
            (ScratchError "bad pattern expression" $pattern)
            (find &scratch $pattern))))

; Get examples from scratch
; Usage: (scratch-examples <pattern> [limit])
(= (scratch-examples $patternstr $limit)
   (let* (($pattern (catch (sread $patternstr)))
          ($limit2 (car-atom (collapse (clamp $limit 1 50)))))
        (if (== (car-atom $pattern) Error)
            (ScratchError "bad pattern expression" $pattern)
            (repr (takeK $limit2 (collapse (match &scratch $pattern $pattern)))))))

(= (scratch-examples $patternstr)
   (scratch-examples $patternstr 5))

; Check if atom is in scratch
; Usage: (scratch-contains? <atom>)
(= (scratch-contains? $atom)
   (let* (($hash (py-str (helper.metta_atom_hash $atom))))
        (if (== (collapse (match &scratch-ttl (ScratchTTL $hash $_) $_)) ())
            false
            true)))
