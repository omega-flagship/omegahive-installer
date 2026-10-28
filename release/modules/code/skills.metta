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
