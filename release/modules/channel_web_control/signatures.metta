(SkillSignature send-web-control (Arg rest-text message))
(SkillSignature send-web-control-base64 (Arg base64-utf8 payload))
(SignatureLowering send-web-control send-web-control-base64)
