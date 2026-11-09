(= (code-repos)
   (py-call (omega_code.repos)))

(= (code-open $goal $repository)
   (py-call (omega_code.open_workspace $goal $repository)))

(= (code-tools)
   (py-call (omega_code.tools)))

(= (code-read $path)
   (py-call (omega_code.read $path)))

(= (code-search $query)
   (py-call (omega_code.search $query)))

(= (code-replace $path $change)
   (py-call (omega_code.replace $path $change)))

(= (code-exec $command)
   (py-call (omega_code.run $command)))

(= (code-status)
   (py-call (omega_code.status)))

(= (code-changes)
   (py-call (omega_code.changes)))

(= (code-check)
   (py-call (omega_code.verify)))

(= (code-runs $cursor)
   (py-call (omega_code.runs $cursor)))

(= (code-verifications $cursor)
   (py-call (omega_code.verifications $cursor)))

(= (code-output $run $after)
   (py-call (omega_code.output $run $after)))

(= (code-diagnostics $path)
   (py-call (omega_code.diagnostics $path)))

(= (code-create $path $content)
   (py-call (omega_code.create $path $content)))

(= (code-move $source $target)
   (py-call (omega_code.move $source $target)))

(= (code-remove $path)
   (py-call (omega_code.remove $path)))

(= (code-git)
   (py-call (omega_code.git_context)))

(= (code-review $target)
   (py-call (omega_code.review_create $target)))

(= (code-hunks $review $after)
   (py-call (omega_code.review_hunks $review $after)))

(= (code-hunk-bytes $review $hunk $side $after)
   (py-call (omega_code.review_content $review $hunk $side $after)))

(= (code-select $review $hunks)
   (py-call (omega_code.review_apply $review $hunks)))

(= (code-git-export $branch $message)
   (py-call (omega_code.git_export $branch $message)))

(= (code-git-export-state $export)
   (py-call (omega_code.git_export_state $export)))

(= (code-git-patch $export $after)
   (py-call (omega_code.git_export_patch $export $after)))
(= (code-merge-preview $base $incoming) (py-call (omega_code.merge_create $base $incoming)))
(= (code-merge-files $preview $after) (py-call (omega_code.merge_files $preview $after)))
(= (code-merge-bytes $preview $path $side $after) (py-call (omega_code.merge_bytes $preview $path $side $after)))
(= (code-merge-apply $preview $choices) (py-call (omega_code.merge_apply $preview $choices)))

(= (code-git-original-export $branch $message)
   (py-call (omega_code.git_original_export $branch $message)))

(= (code-retrieve $query) (py-call (omega_code.retrieve $query)))

(= (code-proof-result $run) (py-call (omega_code.proof_result $run)))

(= (code-proof-check $runtime $path) (py-call (omega_code.proof_check $runtime $path)))

(= (code-proposal-context $workspace) (py-call (code_proposal.proposal_context $workspace)))
(= (code-helper-instruction) (py-call (code_proposal.helper_instruction)))
(= (code-proposal-read $workspace $path) (py-call (code_proposal.proposal_read $workspace $path)))
(= (code-propose $workspace $operation $hunks) (py-call (code_proposal.propose $workspace $operation $hunks)))

(= (code-test-prepare $request $operation $preparation) (py-call (code_proposal.proposal_test_prepare $request $operation $preparation)))
(= (code-test-run $test $launch $command) (py-call (code_proposal.proposal_test_run $test $launch $command)))
(= (code-test-run $test $launch) (py-call (code_proposal.proposal_test_run $test $launch "")))
(= (code-test-result $test $query) (py-call (code_proposal.proposal_test_result $test $query)))

(= (code-mind-templates $team) (py-call (omega_code.mind_templates $team)))

(= (code-mind-spawn $payload) (py-call (omega_code.mind_spawn $payload)))

(= (code-mind-prompt $child $payload) (py-call (omega_code.mind_prompt $child $payload)))

(= (code-mind-control $child $operation $action) (py-call (omega_code.mind_control $child $operation $action)))

(= (code-mind-status $child $team $controller) (py-call (omega_code.mind_status $child $team $controller)))

(= (code-mind-scan $team $controller $pages) (py-call (omega_code.mind_scan $team $controller $pages)))

(= (code-mind-request $operation) (py-call (omega_code.mind_request $operation)))

(= (code-mind-retry $operation) (py-call (omega_code.mind_retry $operation)))

(= (code-mind-work $request $team) (py-call (omega_code.mind_work $request $team)))
