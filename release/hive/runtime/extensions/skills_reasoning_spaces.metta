(= (nars-query $kbstr $termstr)
   (let* (($kb (sread $kbstr))
          ($term (sread $termstr)))
         (py-str ("NARS-QUERY " (repr (NARS.Query $kb $term))))))

(= (nars-derive $tasksstr $beliefsstr)
   (let* (($tasks (sread $tasksstr))
          ($beliefs (sread $beliefsstr)))
         (py-str ("NARS-DERIVE " (repr (NARS.Derive $tasks $beliefs))))))

(= (nal-step $premise1str $premise2str)
   (let* (($premise1 (sread $premise1str))
          ($premise2 (sread $premise2str)))
         (py-str ("NAL-STEP " (repr (|- $premise1 $premise2))))))

(= (pln-step $premise1str $premise2str)
   (let* (($premise1 (sread $premise1str))
          ($premise2 (sread $premise2str)))
         (py-str ("PLN-STEP " (repr (|~ $premise1 $premise2))))))

(= (truth-expectation $frequency $confidence)
   (Truth_Expectation (stv $frequency $confidence)))

(= (register-runtime-hook $phase $name $call)
   (progn (collapse (match &self (RuntimeHook $phase $name $oldcall)
                           (remove-atom &self (RuntimeHook $phase $name $oldcall))))
          (add-atom &self (RuntimeHook $phase $name $call))
          (RuntimeHookRegistered $phase $name)))

(= (trust-runtime-organ $name)
   (progn (collapse (match &self (TrustedRuntimeOrgan $name)
                           (remove-atom &self (TrustedRuntimeOrgan $name))))
          (add-atom &self (TrustedRuntimeOrgan $name))
          (RuntimeOrganTrusted $name)))

(= (trust-runtime-hook $phase $name)
   (progn (collapse (match &self (TrustedRuntimeHook $phase $name)
                           (remove-atom &self (TrustedRuntimeHook $phase $name))))
          (add-atom &self (TrustedRuntimeHook $phase $name))
          (RuntimeHookTrusted $phase $name)))

(= (runtime-hooks)
   (collapse (match &self (RuntimeHook $phase $name $call)
                    (RuntimeHook $phase $name $call))))

(= (runtime-organ-trusted $name)
   (if (== (collapse (match &self (TrustedRuntimeOrgan $name) true)) ())
       false
       true))

(= (runtime-hook-trusted $phase $name)
   (if (== (collapse (match &self (TrustedRuntimeHook $phase $name) true)) ())
       false
       true))

(= (run-runtime-hooks $phase)
   (let $results (collapse (match &self (RuntimeHook $phase $name $call)
                                  (if (runtime-hook-trusted $phase $name)
                                      (RuntimeHookResult $phase $name (eval $call))
                                      (RuntimeHookRejected $phase $name untrusted))))
        (if (== $results ()) RuntimeHooksNone $results)))
