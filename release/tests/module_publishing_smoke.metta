!(import! &self (library lib_import))
!(import_prolog_functions_from_file ./repos/OmegaClaw-Core/hive/runtime/register.pl (register-hive-core))
!(register-hive-core)
!(import! &self (library OmegaClaw-Core modules/publishing/entry.metta))

!(println! (eval (webhost-status)))
!(println! (eval (public-web-url demo)))
!(println! (match &self (Provides omegaclaw.skill.publishing $skill) $skill))
