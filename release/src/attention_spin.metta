; MeTTa-owned quiet-loop proprioception for the attention space.
;
; The loop only reports response shape. This organ turns repeated pure wait
; responses into one current-state atom Omega can reason over.

(= (spin-counter-purpose)
   "0 means no spin pressure. N is the number of consecutive cycles where your only action was wait. If N rises while you have active loop budget, you are spending attention/cost on waiting; choose useful self-directed work, handle an agenda item, or lower your operating mode.")

(= (attention-spin-init)
   (set-spin-counter 0))

(= (wait-command? $cmd)
   (== (car-atom $cmd) wait))

; One clause, so the empty list does not also match the general case.
(= (all-wait-commands? $items)
   (if (== $items ())
       true
       (if (wait-command? (car-atom $items))
           (all-wait-commands? (cdr-atom $items))
           false)))

(= (pure-wait-response? $items)
   (if (== $items ()) false (all-wait-commands? $items)))

(= (set-spin-counter $n)
   (let $purpose (spin-counter-purpose)
        (progn (collapse (match &attention (SpinCounter quiet-wait $old $desc)
                                (remove-atom &attention (SpinCounter quiet-wait $old $desc))))
               (change-state! &spinCounter $n)
               (add-atom &attention (SpinCounter quiet-wait $n $purpose))
               (SpinCounter quiet-wait $n $purpose))))

(= (attention-observe-response $msgnew $sexpr)
   (if $msgnew
       (set-spin-counter 0)
       (if (pure-wait-response? $sexpr)
           (set-spin-counter (+ 1 (get-state &spinCounter)))
           (set-spin-counter 0))))

(= (spin-counter-context)
   (repr (collapse (match &attention (SpinCounter quiet-wait $n $desc)
                          (SpinCounter quiet-wait $n $desc)))))
