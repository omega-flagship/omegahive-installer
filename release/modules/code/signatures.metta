; Purpose: the argument shapes of the Code module's skills (proposals, tests and code minds).
(SkillSignature code-proposal-context (Arg text workspace))
(SkillSignature code-helper-instruction)
(SkillSignature code-review-packet)
(SkillSignature code-proposal-read (Arg text workspace) (Arg text path))
(SkillSignature code-propose (Arg text workspace) (Arg text operation) (Arg multiline hunks-json))

(SkillSignature code-test-prepare (Arg text request) (Arg text operation) (Arg multiline preparation-json))
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
