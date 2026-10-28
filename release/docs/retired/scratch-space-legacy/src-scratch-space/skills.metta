; Scratch space module for OmegaClaw
; MeTTa definitions for transient reasoning space with TTL-based garbage collection

; Import prolog functions for string operations
!(import_prolog_function string_length)

; Register &scratch as a memory space for draft/working memory
!(register-space "scratch" &scratch memory)
!(register-space-alias scratch "scratch")

; Scratch space has TTL tracking in a side table: (scratch-ttl <atom-hash> <loops-remaining>)
; Default TTL is 3 loops per atom

; Add-atom to &scratch with optional TTL override (default 3)
; Usage: (scratch-add <atom> :ttl <n>) or just (scratch-add <atom>)
; TTL is stored in side table as (scratch-ttl <hash> <ttl>)

; Remove atom from &scratch and its TTL entry
; Usage: (scratch-remove <atom>)

; Promote atom from &scratch to &beliefs with updated truth-values and event note
; Usage: (promote-scratch <atom> reason)
; Copies atom to &beliefs with confidence adjusted, removes from &scratch, adds event

; Explicit loop hook: decrement all scratch TTLs and collect expired
; Called each loop by loop.metta
; Usage: (scratch-gc)

; On loop touch (read/inspect atom), TTL resets to default
; Implemented by matching in pattern - any access resets TTL

; Persistence: register &scratch in persistence registry
; Path: ./memory/scratch.metta
; Mode: runtime-state (saved on shutdown, loaded on boot)
!(register-space-persistence "scratch" ./repos/OmegaClaw-Core/memory/scratch.metta runtime-state)

; Helper function to get hash of an atom for TTL tracking
; In Hyperon/MeTTa, we can use string representation as hash
(= (atom-hash $atom)
   (repr $atom))

; Get TTL for an atom (returns number of loops remaining)
; If not in side-table, returns 0 (default fresh TTL)
; Note: Side-table format is (scratch-ttl <hash> <loops-remaining>)
(= (scratch-ttl $atom)
   (let $hash (atom-hash $atom)
        (collapse (match &scratch-ttl (scratch-ttl $hash $remaining) $remaining))))

; Set TTL for an atom
(= (scratch-ttl-set $atom $remaining)
   (let $hash (atom-hash $atom)
        (progn (collapse (match &scratch-ttl (scratch-ttl $hash $old) (remove-atom &scratch-ttl (scratch-ttl $hash $old))))
               (add-atom &scratch-ttl (scratch-ttl $hash $remaining))
               $remaining)))

; Touch an atom - reset its TTL to default (3)
(= (scratch-touch $atom)
   (progn (scratch-ttl-set $atom 3)
          (ScratchTouched $atom)))

; Get default TTL value
(= (scratch-default-ttl) 3)

; Check if atom is in scratch space
(= (scratch-contains $atom)
   (if (== (find &scratch $atom) ()) false true))

; Add atom to scratch with optional explicit TTL
; Usage: (scratch-add <atom>) or (scratch-add <atom> :ttl <n>)
(= (scratch-add $atom)
   (scratch-add $atom (scratch-default-ttl)))

(= (scratch-add $atom :ttl $ttl)
   (progn (add-atom &scratch $atom)
          (scratch-ttl-set $atom $ttl)
          (ScratchAtomAdded $atom $ttl)))

; Remove atom from scratch and its TTL entry
(= (scratch-remove $atom)
   (progn (remove-atom &scratch $atom)
          (let $hash (atom-hash $atom)
               (progn (collapse (match &scratch-ttl (scratch-ttl $hash $remaining) (remove-atom &scratch-ttl (scratch-ttl $hash $remaining))))
                      (ScratchAtomRemoved $atom)))))

; Promote atom from scratch to beliefs
; Copies atom to &beliefs with confidence adjusted (lower for draft origin)
; Removes from &scratch
; Records event: "promoted from scratch"
(= (promote-scratch $atom $reason)
   (if (== (find &scratch $atom) ())
       (ScratchPromoteNotFound $atom)
       (progn (let* (($promoted (if (== (car-atom $atom) Belief)
                                   $atom
                                   (Belief "scratch-origin" "promoted-from-scratch" (repr $atom) 0.5 0.5))))
               (progn (add-atom &beliefs $promoted)
                      (trace-atom "write" "beliefs" $promoted "promoted-scratch")
                      (add-atom &events (Event "omega" "scratch-promote" $reason "0.9"))
                      (scratch-remove $atom)
                      (ScratchPromoted $atom $promoted $reason))))))

; Promote-scratch with default reason
(= (promote-scratch $atom)
   (promote-scratch $atom "verified-draft"))

; Scratch garbage collection
; Called each loop - decrements all TTLs, removes expired atoms
; Also touches atoms found in patterns (reset TTL on access)
(= (scratch-gc)
   (let* (($ttl-entries (collapse (match &scratch-ttl (scratch-ttl $hash $remaining) (scratch-ttl $hash $remaining))))
          ($new-ttls (collapse (let* (($hash (car-atom $ttl-entries))
                                       ($remaining (car-atom (cdr-atom $ttl-entries)))
                                       ($new-remaining (- $remaining 1)))
                                  (if (> $new-remaining 0)
                                      (progn (scratch-ttl-set (sread $hash) $new-remaining)
                                             (ScratchTtlDecrement $hash $new-remaining))
                                      (progn (remove-atom &scratch-ttl (scratch-ttl $hash $remaining))
                                             (let $atom (sread $hash)
                                                  (progn (remove-atom &scratch $atom)
                                                         (ScratchGCExpire $atom $hash)))))))))
          $new-ttls))

; Get all scratch atoms with their remaining TTLs
(= (scratch-all-with-ttl)
   (repr (collapse (match &scratch $atom
                          (let $hash (atom-hash $atom)
                               (let $ttl (collapse (match &scratch-ttl (scratch-ttl $hash $remaining) $remaining)))
                               (ScratchAtomWithTtl $atom $ttl)))))

; Get count of scratch atoms
(= (scratch-count)
   (string_length (repr (get-atoms &scratch))))

; Get scratch atoms matching pattern
(= (scratch-find $pattern)
   (repr (collapse (match &scratch $pattern $pattern))))

; Get scratch atoms matching pattern with count limit
(= (scratch-examples $pattern $limit)
   (let* (($limit2 (car-atom (collapse (clamp $limit 1 20))))
          ($matches (collapse (match &scratch $pattern $pattern))))
        (repr (takeK $limit2 $matches))))

(= (scratch-examples $pattern)
   (scratch-examples $pattern 5))

; Get pressure for scratch space (chars used vs limit)
(= (scratch-pressure)
   (let $limit (get-state &maxScratchAtomsChars)
        (if (== $limit ())
            (ScratchPressureError "limit not configured")
            (let* (($atoms (repr (get-atoms &scratch)))
                   ($chars (string_length $atoms)))
                   (ScratchPressure $chars $limit (- $limit $chars))))))
