!(import! &self (library lib_import))
!(git-import! "https://github.com/asi-alliance/OmegaClaw-Core.git")
!(import! &self (library OmegaClaw-Core modules/codex_code/entry.metta))

!(println! (eval (codex-code-status)))
!(println! (eval (codex-code-atoms)))
!(println! (eval (codex-code-containment-check)))
!(println! (match &self (Provides omegaclaw.coding.codex $thing) $thing))
!(println! (match &self (UsesModel codex-code $model) $model))
