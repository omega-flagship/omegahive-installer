!(import! &self (library lib_import))
!(import_prolog_functions_from_file ./repos/OmegaClaw-Core/hive/runtime/register.pl (register-hive-core))
!(register-hive-core)
!(import! &self (library OmegaClaw-Core modules/omega_vm/entry.metta))

!(println! (eval (vm-status)))
!(println! (match &self (Provides omegaclaw.device.omega-vm $skill) $skill))
!(println! (match &self (WorkspaceDeviceCapability omega-vm $capability) $capability))
