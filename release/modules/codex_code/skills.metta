(= (codex-code-status)
   (py-call (codex_code.codex_code_status)))

(= (codex-code-atoms)
   (py-call (codex_code.codex_code_atoms)))

(= (codex-code-containment-check)
   (py-call (codex_code.codex_code_containment_check)))

(= (codex-code $task)
   (py-call (codex_code.codex_code $task)))

(= (codex-code-readonly $task)
   (py-call (codex_code.codex_code_readonly $task)))

(= (codex-code-start $task)
   (py-call (codex_code.codex_code_start $task)))

(= (codex-code-readonly-start $task)
   (py-call (codex_code.codex_code_readonly_start $task)))

(= (codex-code-jobs)
   (py-call (codex_code.codex_code_jobs)))

(= (codex-code-job-status $job-id)
   (py-call (codex_code.codex_code_job_status $job-id)))

(= (codex-code-result $job-id)
   (py-call (codex_code.codex_code_result $job-id)))

(= (codex-code-cancel $job-id)
   (py-call (codex_code.codex_code_cancel $job-id)))

(= (codex-code-events)
   (py-call (codex_code.codex_code_events)))

(= (codex-code-last-trace)
   (py-call (codex_code.codex_code_last_trace)))
