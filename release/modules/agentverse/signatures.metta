; Agentverse remote-agent command syntax declarations.

(SignatureSpace agentverse)

(SkillSignature agentverse-status)
(SkillSignature agentverse-listener-status)
(SkillSignature agentverse-listener-start)
(SkillSignature agentverse-listener-stop)
(SkillSignature agentverse-discover (Arg text query) (Arg optional-number limit 5))
(SkillSignature agentverse-remote-agents)
(SkillSignature agentverse-register-agent (Arg text name) (Arg text address) (Arg text schema) (Arg rest-text capability))
(SkillSignature agentverse-call (Arg text name) (Arg rest-text payload))
(SkillSignature agentverse-ask (Arg text destination) (Arg text schema) (Arg rest-text payload))
(SkillSignature agentverse-trace)
(SkillSignature agentverse-inbox)
