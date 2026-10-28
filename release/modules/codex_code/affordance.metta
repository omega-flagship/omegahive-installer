; Codex coding organ affordance cards.

(SkillTopic "codex-code-status" "codex-code")
(SkillTopic "codex-code-readonly" "codex-code")
(SkillTopic "codex-code" "codex-code")
(SkillTopic "codex-code-readonly-start" "codex-code")
(SkillTopic "codex-code-start" "codex-code")
(SkillTopic "codex-code-jobs" "codex-code")
(SkillTopic "codex-code-job-status" "codex-code")
(SkillTopic "codex-code-result" "codex-code")
(SkillTopic "codex-code-cancel" "codex-code")
(SkillTopic "codex-code-events" "codex-code")

(SkillCardLine "codex-code-readonly" "codex-code-readonly task - inspect/review code without writing")
(SkillCardLine "codex-code" "codex-code task - ask the coding organ to edit the repo with traces")
(SkillCardLine "codex-code-start" "codex-code-start task - start an async edit job so the loop can continue")
(SkillCardLine "codex-code-result" "codex-code-result job-id - read a completed async coding job")

(SkillTrigger "codex-code-readonly" "mentions-word:code" 0.70 "code wording may need the coding organ")
(SkillTrigger "codex-code-readonly" "mentions-word:repo" 0.68 "repo wording may need the coding organ")
(SkillTrigger "codex-code-readonly" "mentions-word:github" 0.64 "GitHub wording may need the coding organ")
(SkillTrigger "codex-code-readonly" "mentions-word:patch" 0.64 "patch wording may need the coding organ")
(SkillTrigger "codex-code-readonly" "has-file-reference" 0.58 "file references may need code inspection")

(Risk "codex-code" "repo-write")
(Risk "codex-code-start" "repo-write")
(Effect "codex-code-readonly" "code-review")
(Effect "codex-code-start" "async-job")
