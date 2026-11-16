!(import! &self (library lib_import))
!(import_prolog_functions_from_file ./repos/OmegaClaw-Core/hive/runtime/register.pl (register-hive-core))
!(register-hive-core)
!(import! &self (library OmegaClaw-Core lib_omegaclaw))
!(import! &self (car-atom (collapse (library OmegaClaw-Core lib_omegaclaw_body))))

!(println! (eval (video-config-status)))
!(println! (eval (body-status)))
