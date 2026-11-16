(SkillSignature send-telegram (Arg rest-text message))
(SkillSignature send-telegram-base64 (Arg base64-utf8 payload))
(SkillSignature telegram-status)
(SignatureLowering send-telegram send-telegram-base64)
