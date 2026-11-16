!(import! &self (library lib_import))
!(import_prolog_functions_from_file ./repos/OmegaClaw-Core/hive/runtime/register.pl (register-hive-core))
!(register-hive-core)
!(import! &self (car-atom (collapse (library OmegaClaw-Core lib_omegaclaw))))

!(omegaclaw)
