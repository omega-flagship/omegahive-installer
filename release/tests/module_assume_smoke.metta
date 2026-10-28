!(import! &self (library lib_import))
!(git-import! "https://github.com/asi-alliance/OmegaClaw-Core.git")
!(import! &self (library OmegaClaw-Core ./src/helper.py))
!(import! &self (library OmegaClaw-Core ./src/skills_runtime_spaces.metta))
!(import! &self (library OmegaClaw-Core ./modules/assume/entry.metta))

!(println! ASSUME-MODULE-META)
!(println! (match &self (Module omegaclaw.reasoning.assume) (Module omegaclaw.reasoning.assume)))
!(println! (match &self (Provides omegaclaw.reasoning.assume $thing) $thing))
!(println! (match &self (AssumeCapability assume $capability) $capability))

!(println! ASSUME-EMPTY-STATUS)
!(println! (eval (assume-situation-status smoke-domain smoke-situation)))

!(println! ASSUME-SMOKE-PASS)
