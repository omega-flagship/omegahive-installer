!(import! &self (library lib_import))
!(git-import! "https://github.com/asi-alliance/OmegaClaw-Core.git")
!(import! &self (library OmegaClaw-Core modules/omega_vm/entry.metta))

!(println! (eval (vm-status)))
!(println! (match &self (Provides omegaclaw.device.omega-vm $skill) $skill))
!(println! (match &self (WorkspaceDeviceCapability omega-vm $capability) $capability))
