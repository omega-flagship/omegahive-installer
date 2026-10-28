!(import_prolog_functions_from_file (library OmegaClaw-Core ./src/skills.pl) (shell shell_confirm first_char gc read_file_tail))

(= (read-file $file)
   (progn (translatePredicate (exists_file $file))
          (translatePredicate (read_file_to_string $file $content ()))
          $content))

(= (write-file $file $str)
   (progn (translatePredicate (open $file write $Out))
          (translatePredicate (write $Out $str))
          (translatePredicate (close $Out))
          WRITE-FILE-SUCCESS))

(= (append-file $file $str)
   (progn (translatePredicate (exists_file $file))
          (translatePredicate (open $file append $Out))
          (translatePredicate (write $Out $str))
          (translatePredicate (nl $Out)),
          (translatePredicate (close $Out))
          APPEND-FILE-SUCCESS))

(= (write-file-base64 $file $payload)
   (py-call (helper.write_file_base64 $file $payload)))

(= (append-file-base64 $file $payload)
   (py-call (helper.append_file_base64 $file $payload)))

(= (shell-confirm $cmd)
   (shell_confirm $cmd))

(= (current-swipl-pid)
   (py-call (helper.current_swipl_pid)))

(= (body-status)
   (py-str ("BODY-STATUS swipl_pid=" (current-swipl-pid))))

(= (context-organ-status)
   (py-str "CONTEXT-ORGAN-STATUS input-recall=enabled skill-recall=symbolic-card-guidance getSkills=bootstrap-hints getFullSkills=manual-catalog"))

(= (prepare-reboot $reason)
   (let $trace (py-call (helper.prepare_reboot $reason))
        (progn (remember $trace)
               $trace)))

(= (complete-reboot-check)
   (py-call (helper.complete_reboot_check)))

(= (complete-reboot-check $reason)
   (complete-reboot-check))

(= (restart-omega $reason)
   (py-call (helper.restart_omega $reason)))

(= (restart-self $reason)
   (py-call (helper.restart_self $reason)))

(= (reboot-self $reason)
   (py-call (helper.reboot_self $reason)))

(= (wait $reason)
   (py-str (WAITING: $reason)))

(= (metta $str)
   (let $code (sread $str)
        (repr (swrite (eval $code)))))

(= (pin $x)
   PIN-SUCCESS)

(= (episodes-at $time)
   (py-call (helper.episodes_at $time (maxEpisodeRecallLines) (maxEpisodeResultChars))))

(= (test-metta $expr)
   (py-call (helper.test_metta_expression $expr)))

(= (run-metta-file $file)
   (py-call (helper.run_metta_file $file)))

(= (trace-atom $action $space $atom $reason)
   (add-atom &activity (AtomTouch (get-state &cycle) $action $space $atom $reason (get_time_as_string))))

(= (trace-space $action $space $reason)
   (add-atom &activity (SpaceTouch (get-state &cycle) $action $space $reason (get_time_as_string))))

(= (trace-merge $source $target $result $reason)
   (add-atom &activity (AtomMerge (get-state &cycle) $source $target $result $reason (get_time_as_string))))

(= (activity-traces)
   (repr (get-atoms &activity)))
