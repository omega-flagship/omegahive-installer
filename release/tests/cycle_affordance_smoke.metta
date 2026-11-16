!(import! &self (library lib_import))
!(import_prolog_functions_from_file ./repos/OmegaClaw-Core/hive/runtime/register.pl (register-hive-core))
!(register-hive-core)
!(import! &self (library OmegaClaw-Core lib_omegaclaw))

!(initLoop)
!(println! (cycle-status))
!(start-cycle-practice "smoke")
!(println! (cycle-status))
