; Body-container affordance cards.

(SkillTopic "body-container-status" "body")
(SkillTopic "body-container-self" "body")
(SkillTopic "body-container-launcher" "body")
(SkillTopic "body-container-last-trace" "body")

(SkillCardLine "body-container-status" "body-container-status - observe the VM body the agent is running inside")
(SkillCardLine "body-container-self" "body-container-self - return body-container atoms for self/body reasoning")

(SkillTrigger "body-container-status" "mentions-word:body" 0.62 "body wording may need body-container status")
(SkillTrigger "body-container-status" "mentions-word:resource" 0.58 "resource wording may need body-container status")
(SkillTrigger "body-container-status" "mentions-word:process" 0.56 "process wording may need body-container status")

(Effect "body-container-self" "body-self-atoms")
