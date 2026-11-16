!(import! &self (library lib_import))
!(import_prolog_functions_from_file ./repos/OmegaClaw-Core/hive/runtime/register.pl (register-hive-core))
!(register-hive-core)
!(import! &self (library OmegaClaw-Core ./hive/runtime/extensions/hive_helpers.py))
!(import! &self (library OmegaClaw-Core ./hive/runtime/extensions/skills_runtime_spaces.metta))
!(import! &self (library OmegaClaw-Core ./modules/assume/entry.metta))

!(println! ASSUME-MODULE-META)
!(println! (match &self (Module omegaclaw.reasoning.assume) (Module omegaclaw.reasoning.assume)))
!(println! (match &self (Provides omegaclaw.reasoning.assume $thing) $thing))
!(println! (match &self (AssumeCapability assume $capability) $capability))

!(println! ASSUME-EMPTY-STATUS)
!(println! (eval (assume-situation-status smoke-domain smoke-situation)))

!(println! ASSUME-SMOKE-PASS)
