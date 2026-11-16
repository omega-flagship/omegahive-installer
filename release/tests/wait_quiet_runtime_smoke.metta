; Boots the whole runtime with commchannel=hive and runs the real loop. Driven by tests/test_wait_quiet_runtime.py,
; which serves a fake agent hub and a fake model that only ever answers "wait <seconds>" and counts its calls.

!(import! &self (library lib_import))
!(import_prolog_functions_from_file ./repos/OmegaClaw-Core/hive/runtime/register.pl (register-hive-core))
!(register-hive-core)
!(import! &self (library OmegaClaw-Core lib_omegaclaw))
!(omegaclaw)
