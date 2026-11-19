!(import_prolog_functions_from_file (library OmegaClaw-Core ./hive/runtime/extensions/shell_policy.pl) (hive_shell shell_confirm))







(= (write-file-base64 $file $payload)
   (py-call (hive_helpers.write_file_base64 $file $payload)))

(= (append-file-base64 $file $payload)
   (py-call (hive_helpers.append_file_base64 $file $payload)))

(= (shell-confirm $cmd)
   (shell_confirm $cmd))

(= (current-swipl-pid)
   (py-call (hive_helpers.current_swipl_pid)))

(= (body-status)
   (py-str ("BODY-STATUS swipl_pid=" (current-swipl-pid))))

(= (context-organ-status)
   (py-str "CONTEXT-ORGAN-STATUS input-recall=enabled skill-recall=symbolic-card-guidance getSkills=bootstrap-hints getFullSkills=manual-catalog"))

(= (prepare-reboot $reason)
   (let $trace (py-call (hive_helpers.prepare_reboot $reason))
        (progn (remember $trace)
               $trace)))

(= (complete-reboot-check)
   (py-call (hive_helpers.complete_reboot_check)))

(= (complete-reboot-check $reason)
   (complete-reboot-check))

(= (restart-omega $reason)
   (py-call (hive_helpers.restart_omega $reason)))

(= (restart-self $reason)
   (py-call (hive_helpers.restart_self $reason)))

(= (reboot-self $reason)
   (py-call (hive_helpers.reboot_self $reason)))

; &lastResponseKind is this reply's kind (hive-run-response sets it before the reply's commands run): only a wait the
; mind wrote itself (normal) can be refused, never the runtime's own format or provider retry wait.
(= (wait $reason)
   (py-call (hive_helpers.wait_result $reason (get-state &lastResponseKind))))

; A message the mind wrote after another command in the same reply, held until that command's result comes back
; (hive_helpers.hold_messages_after_commands): it sends nothing and says why, and the mind sends after reading results.
(= (held-message $skill)
   (py-call (hive_helpers.held_message_note $skill)))

(= (held-message $skill $a)
   (py-call (hive_helpers.held_message_note $skill)))

(= (held-message $skill $a $b)
   (py-call (hive_helpers.held_message_note $skill)))





(= (episodes-at $time)
   (py-call (hive_helpers.episodes_at $time (maxEpisodeRecallLines) (maxEpisodeResultChars))))

(= (test-metta $expr)
   (py-call (hive_helpers.test_metta_expression $expr)))

(= (run-metta-file $file)
   (py-call (hive_helpers.run_metta_file $file)))

(= (trace-atom $action $space $atom $reason)
   (add-atom &activity (AtomTouch (get-state &cycle) $action $space $atom $reason (get_time_as_string))))

(= (trace-space $action $space $reason)
   (add-atom &activity (SpaceTouch (get-state &cycle) $action $space $reason (get_time_as_string))))

(= (trace-merge $source $target $result $reason)
   (add-atom &activity (AtomMerge (get-state &cycle) $source $target $result $reason (get_time_as_string))))

(= (activity-traces)
   (repr (get-atoms &activity)))
