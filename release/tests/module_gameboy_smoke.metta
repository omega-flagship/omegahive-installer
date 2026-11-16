!(import! &self (library lib_import))
!(import_prolog_functions_from_file ./repos/OmegaClaw-Core/hive/runtime/register.pl (register-hive-core))
!(register-hive-core)
!(import! &self (library OmegaClaw-Core modules/gameboy/entry.metta))

!(println! (eval (gb-status)))
!(println! (match &self (Provides omegaclaw.simulation.gameboy $thing) $thing))
!(println! (match &self (SimulationCapability gameboy $capability) $capability))
