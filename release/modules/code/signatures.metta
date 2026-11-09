(SkillSignature code-repos)
(SkillSignature code-open (Arg text goal) (Arg text repository))
(SkillSignature code-tools)
(SkillSignature code-read (Arg text path))
(SkillSignature code-search (Arg rest-text query))
(SkillSignature code-replace (Arg text path) (Arg rest-text change))
(SkillSignature code-exec (Arg rest-text command))
(SkillSignature code-status)
(SkillSignature code-changes)
(SkillSignature code-check)
(SkillSignature code-runs (Arg text cursor))
(SkillSignature code-verifications (Arg text cursor))
(SkillSignature code-output (Arg text run) (Arg text after))
(SkillSignature code-diagnostics (Arg text path))
(SkillSignature code-create (Arg text path) (Arg rest-text content))
(SkillSignature code-move (Arg text source) (Arg text target))
(SkillSignature code-remove (Arg text path))
(SkillSignature code-git)
(SkillSignature code-review (Arg text target))
(SkillSignature code-hunks (Arg text review) (Arg text after))
(SkillSignature code-hunk-bytes (Arg text review) (Arg text hunk) (Arg text side) (Arg text after))
(SkillSignature code-select (Arg text review) (Arg rest-text hunks))
(SkillSignature code-git-export (Arg text branch) (Arg rest-text message))
(SkillSignature code-git-export-state (Arg text export))
(SkillSignature code-git-patch (Arg text export) (Arg text after))
(SkillSignature code-merge-preview (Arg text base) (Arg text incoming))
(SkillSignature code-merge-files (Arg text preview) (Arg text after))
(SkillSignature code-merge-bytes (Arg text preview) (Arg text path) (Arg text side) (Arg text after))
(SkillSignature code-merge-apply (Arg text preview) (Arg rest-text choices))

(SkillSignature code-git-original-export (Arg text branch) (Arg rest-text message))

(SkillSignature code-retrieve (Arg rest-text query))

(SkillSignature code-proof-result (Arg text run))

(SkillSignature code-proof-check (Arg text runtime) (Arg text path))

(SkillSignature code-proposal-context (Arg text workspace))
(SkillSignature code-helper-instruction)
(SkillSignature code-proposal-read (Arg text workspace) (Arg text path))
(SkillSignature code-propose (Arg text workspace) (Arg text operation) (Arg rest-text hunks-json))

(SkillSignature code-test-prepare (Arg text request) (Arg text operation) (Arg rest-text preparation-json))
(SkillSignature code-test-run (Arg text test) (Arg text launch) (Arg rest-text command-json))
(SkillSignature code-test-result (Arg text test) (Arg rest-text query-json))

(SkillSignature code-mind-templates (Arg text team))

(SkillSignature code-mind-spawn (Arg text payload))

(SkillSignature code-mind-prompt (Arg text child) (Arg text payload))

(SkillSignature code-mind-control (Arg text child) (Arg text operation) (Arg text action))

(SkillSignature code-mind-status (Arg text child) (Arg text team) (Arg text controller))

(SkillSignature code-mind-scan (Arg text team) (Arg text controller) (Arg text pages))

(SkillSignature code-mind-request (Arg text operation))

(SkillSignature code-mind-retry (Arg text operation))

(SkillSignature code-mind-work (Arg text request) (Arg text team))
