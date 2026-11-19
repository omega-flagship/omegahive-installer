; Publishing/web affordance cards.

(SkillTopic "write-web-page" "web")
(SkillTopic "list-web-pages" "web")
(SkillTopic "public-web-url" "web")
(SkillTopic "webhost-status" "web")
(SkillTopic "artifact-id" "web")
(SkillTopic "publish-artifact" "web")
(SkillTopic "unpublish-artifact" "web")
(SkillTopic "list-published-artifacts" "web")

(SkillCardLine "write-web-page" "write-web-page slug html - publish an HTML page")
(SkillContextView "write-web-page" "compact-payload")
(SkillContextPolicy "write-web-page" "compact-threshold" 900)
(SkillCardLine "publish-artifact" "publish-artifact artifact shelf title - publish a file into a family shelf")
(SkillCardLine "list-published-artifacts" "list-published-artifacts - inspect published artifacts")

; "website" and "page" bring hive-create's card instead (modules/hive/affordance.metta): a web page a person asks for
; is software, which Create builds ("Building software goes to Create, with no exceptions", Jon on #395, 17 Nov), so
; publishing's HTML writer is found by its topic, never pushed by those words.
(SkillTrigger "publish-artifact" "mentions-word:publish" 0.72 "publish wording may need artifact publishing")
(SkillTrigger "list-published-artifacts" "mentions-word:artifact" 0.62 "artifact wording may need published artifact inspection")

(Risk "write-web-page" "public-web-write")
(Risk "publish-artifact" "public-web-publish")
(Effect "public-web-url" "public-link")
