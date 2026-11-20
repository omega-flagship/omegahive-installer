; Purpose: the Code module's skills: proposals and proposal tests over the hive's relay, and code minds.
(= (code-proposal-context $workspace) (py-call (code_proposal.proposal_context $workspace)))
(= (code-helper-instruction) (py-call (code_proposal.helper_instruction)))
(= (code-review-packet) (py-call (code_proposal.review_packet)))
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
