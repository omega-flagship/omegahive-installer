!(import! &self (library lib_import))
!(git-import! "https://github.com/asi-alliance/OmegaClaw-Core.git")
!(import! &self (library OmegaClaw-Core modules/publishing/entry.metta))

!(println! (eval (webhost-status)))
!(println! (eval (public-web-url demo)))
!(println! (match &self (Provides omegaclaw.skill.publishing $skill) $skill))
