!(import_prolog_function string_length)

; export! and bound-space! live here, before the runtime-space functions that
; call them: PeTTa compiles calls at import time, so a definition imported later
; leaves the call as an inert literal and nothing is saved or bounded.
; Saves go to a temp file that is renamed over the old one only once it is
; complete, so a failure part-way leaves the previous save on disk.
(= (export! $space $file)
   (let $tmp (py-call (helper.save_begin $file))
        (progn (collapse (let $x (get-atoms $space)
                              (append-file $tmp (repr $x))))
               (py-call (helper.save_commit $tmp $file)))))

; Over the limit, atoms are dropped in get-atoms order, except protected ones
; (identity, pins, goals, commitments).  Every drop is written to
; memory/evicted.metta so nothing disappears without a record.
(= (bound-space! $space $limit)
   (progn (change-state! &exportchars 0)
          (collapse (let* (($x (get-atoms $space))
                           ($y (repr $x))
                           ($l (string_length $y))
                           ($_ (change-state! &exportchars (+ (get-state &exportchars) $l))))
                          (if (> (get-state &exportchars) $limit)
                              (if (== (py-call (helper.protected_atom $y)) True)
                                  _
                                  (progn (py-call (helper.evict_receipt $y))
                                         (remove-atom $space $x)))
                              _)))))

(= (register-space $name $handle $role)
   (progn (collapse (match &self (SpaceRegistry $name $oldhandle $oldrole)
                           (remove-atom &self (SpaceRegistry $name $oldhandle $oldrole))))
          (add-atom &self (SpaceRegistry $name $handle $role))
          (SpaceRegistered $name $role)))

(= (register-space-alias $alias $canonical)
   (progn (collapse (match &self (SpaceAlias $alias $oldcanonical)
                           (remove-atom &self (SpaceAlias $alias $oldcanonical))))
          (add-atom &self (SpaceAlias $alias $canonical))
          (SpaceAliasRegistered $alias $canonical)))

(= (register-space-limit $name $state)
   (progn (collapse (match &self (SpaceLimit $name $oldstate)
                           (remove-atom &self (SpaceLimit $name $oldstate))))
          (add-atom &self (SpaceLimit $name $state))
          (SpaceLimitRegistered $name $state)))

(= (register-space-persistence $name $path $mode)
   (progn (collapse (match &self (SpacePersistence $name $oldpath $oldmode)
                           (remove-atom &self (SpacePersistence $name $oldpath $oldmode))))
          (add-atom &self (SpacePersistence $name $path $mode))
          (SpacePersistenceRegistered $name $path $mode)))

(= (runtime-space-loaded? $name)
   (let $canonical (space-canonical-name $name)
        (if (== (collapse (match &self (RuntimeSpaceLoadedFlag $canonical) True)) ()) false true)))

(= (mark-runtime-space-loaded $name)
   (let $canonical (space-canonical-name $name)
        (progn (collapse (match &self (RuntimeSpaceLoadedFlag $canonical)
                                (remove-atom &self (RuntimeSpaceLoadedFlag $canonical))))
               (add-atom &self (RuntimeSpaceLoadedFlag $canonical))
               (RuntimeSpaceLoadMarked $canonical))))

; Runtime spaces are declared as atoms so modules can add spaces without
; editing the loop. Quoted names are canonical because command parsing supplies
; space arguments as strings; aliases preserve the older symbol form.
; Registration is an explicit init step, not an import side effect, so the
; membrane works in real boot composition where spaces are bound after imports.
(= (register-default-runtime-spaces)
   (progn (register-space "persistent" &persistent memory)
          (register-space "agenda" &agenda memory)
          (register-space "beliefs" &beliefs memory)
          (register-space "world" &world memory)
          (register-space "events" &events memory)
          (register-space "activity" &activity memory)
          (register-space "cleanup" &cleanup memory)
          (register-space-alias persistent "persistent")
          (register-space-alias agenda "agenda")
          (register-space-alias beliefs "beliefs")
          (register-space-alias world "world")
          (register-space-alias events "events")
          (register-space-alias activity "activity")
          (register-space-alias cleanup "cleanup")
          (register-space-limit "persistent" &maxPersistentAtomsChars)
          (register-space-limit "agenda" &maxAgendaAtomsChars)
          (register-space-limit "beliefs" &maxBeliefAtomsChars)
          (register-space-limit "world" &maxWorldAtomsChars)
          (register-space-limit "events" &maxEventAtomsChars)
          (register-space-limit "activity" &maxActivityAtomsChars)
          (register-space-persistence "persistent" (memory-file "persistent.metta") runtime-state)
          (register-space-persistence "agenda" (memory-file "agenda.metta") runtime-state)
          (register-space-persistence "beliefs" (memory-file "beliefs.metta") runtime-state)
          (register-space-persistence "world" (memory-file "world.metta") runtime-state)
          (register-space-persistence "events" (memory-file "events.metta") runtime-state)
          (register-space-persistence "activity" (memory-file "activity.metta") runtime-state)
          (register-space-persistence "cleanup" (memory-file "cleanup.metta") runtime-state)
          DefaultRuntimeSpacesRegistered))

(= (space-canonical-name $name)
   (let $aliases (collapse (match &self (SpaceAlias $name $canonical) $canonical))
        (if (== $aliases ()) $name (car-atom $aliases))))

(= (space-registry-entry $name)
   (let $canonical (space-canonical-name $name)
        (collapse (match &self (SpaceRegistry $canonical $handle $role)
                         (SpaceEntry $canonical $handle $role)))))

(= (space-known $name)
   (if (== (space-registry-entry $name) ()) false true))

(= (space-handle $name)
   (let $entry (space-registry-entry $name)
        (if (== $entry ())
            (SpaceError "unknown space" $name)
            (let* (($first (car-atom $entry))
                   ($rest1 (cdr-atom $first)))
                  (car-atom (cdr-atom $rest1))))))

(= (space-limit $name)
   (let* (($canonical (space-canonical-name $name))
          ($limits (collapse (match &self (SpaceLimit $canonical $state) $state))))
         (if (== $limits ())
             unbounded
             (let $value (catch (get-state (car-atom $limits)))
                  (case $value
                        (((Error $a $b) unconfigured)
                         ($else $value)))))))

(= (space-registry)
   (collapse (match &self (SpaceRegistry $name $handle $role)
                    (SpaceRegistry $name $handle $role))))

(= (space-persistence-entry $name)
   (let $canonical (space-canonical-name $name)
        (collapse (match &self (SpacePersistence $canonical $path $mode)
                         (SpacePersistenceEntry $canonical $path $mode)))))

(= (space-persistence-path $name)
   (let $entry (space-persistence-entry $name)
        (if (== $entry ())
            (SpacePersistenceError "no persistence" $name)
            (let* (($first (car-atom $entry))
                   ($rest1 (cdr-atom $first)))
                  (car-atom (cdr-atom $rest1))))))

(= (space-persistence)
   (collapse (match &self (SpacePersistence $name $path $mode)
                    (SpacePersistence $name $path $mode))))

(= (load-runtime-space $name)
   (let $canonical (space-canonical-name $name)
        (if (space-known $canonical)
            (if (== (space-persistence-entry $canonical) ())
                (SpacePersistenceError "no persistence" $canonical)
                (let* (($handle (space-handle $canonical))
                       ($path (space-persistence-path $canonical)))
                      (if (runtime-space-loaded? $canonical)
                          (RuntimeSpaceAlreadyLoaded $canonical $path)
                          (progn (let $temp (cut) (py-call (helper.ensure_runtime_memory_files $canonical)))
                                 (let $temp (cut) (import! $handle $path))
                                 (mark-runtime-space-loaded $canonical)
                                 (RuntimeSpaceLoaded $canonical $path)))))
            (SpacePersistenceError "unknown space" $canonical))))

(= (load-runtime-spaces-by-role $role)
   (collapse (match &self (SpaceRegistry $name $handle $role)
                    (load-runtime-space $name))))

(= (save-runtime-space $name)
   (let $canonical (space-canonical-name $name)
        (if (space-known $canonical)
            (if (== (space-persistence-entry $canonical) ())
                (SpacePersistenceError "no persistence" $canonical)
                (let* (($handle (space-handle $canonical))
                       ($path (space-persistence-path $canonical)))
                      (progn (let $temp (cut) (export! $handle $path))
                             (RuntimeSpaceSaved $canonical $path))))
            (SpacePersistenceError "unknown space" $canonical))))

(= (save-runtime-spaces-by-role $role)
   (collapse (match &self (SpaceRegistry $name $handle $role)
                    (save-runtime-space $name))))

(= (bound-runtime-space $name)
   (let* (($canonical (space-canonical-name $name))
          ($limit (space-limit $canonical)))
         (if (or (== $limit unbounded) (== $limit unconfigured))
             (RuntimeSpaceBoundSkipped $canonical $limit)
             (let $handle (space-handle $canonical)
                  (progn (let $temp (collapse (bound-space! $handle $limit)) $temp)
                         (RuntimeSpaceBound $canonical $limit))))))

(= (bound-runtime-spaces-by-role $role)
   (collapse (match &self (SpaceRegistry $name $handle $role)
                    (bound-runtime-space $name))))

(= (space-atoms $name)
   (if (space-known $name)
       (repr (collapse (match (space-handle $name) $atom $atom)))
       (SpaceError "unknown space" $name)))

(= (space-count $name $patternstr)
   (if (space-known $name)
       (let $pattern (catch (sread $patternstr))
            (if (== (car-atom $pattern) Error)
                (SpaceError "bad pattern expression" $pattern)
                (match-count (space-handle $name) $pattern)))
       (SpaceError "unknown space" $name)))

(= (space-find $name $patternstr)
   (if (space-known $name)
       (let $pattern (catch (sread $patternstr))
            (if (== (car-atom $pattern) Error)
                (SpaceError "bad pattern expression" $pattern)
                (find (space-handle $name) $pattern)))
       (SpaceError "unknown space" $name)))

(= (space-examples $name $patternstr $limit)
   (if (space-known $name)
       (let* (($pattern (catch (sread $patternstr)))
              ($limit2 (car-atom (collapse (clamp $limit 1 50)))))
             (if (== (car-atom $pattern) Error)
                 (SpaceError "bad pattern expression" $pattern)
                 (repr (takeK $limit2 (collapse (match (space-handle $name) $pattern $pattern))))))
       (SpaceError "unknown space" $name)))

(= (space-examples $name $patternstr)
   (space-examples $name $patternstr 5))

(= (space-examples-default $name)
   (space-examples $name "$atom" 5))

(= (space-pressure)
   (repr (collapse (match &self (SpaceRegistry $name $handle $role)
                    (SpacePressure $name
                                   (string_length (repr (collapse (get-atoms $handle))))
                                   (space-limit $name)
                                   $role)))))

(= (persistent-review)
   (py-str ("PERSISTENT-REVIEW notes="
            (repr (collapse (match &persistent (PersistentNote $topic $note $confidence)
                                   (PersistentNote $topic $note $confidence))))
            " facts="
            (repr (collapse (match &persistent (PersistentFact $subject $relation $object $confidence)
                                   (PersistentFact $subject $relation $object $confidence))))
            " rules="
            (repr (collapse (match &persistent (PersistentRule $premise $relation $conclusion $confidence)
                                   (PersistentRule $premise $relation $conclusion $confidence))))
            " observations="
            (repr (collapse (match &persistent (PersistentObservation $source $trace $topic $note $confidence)
                                   (PersistentObservation $source $trace $topic $note $confidence)))))))
