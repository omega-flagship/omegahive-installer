!(import! &self (library lib_import))
!(git-import! "https://github.com/asi-alliance/OmegaClaw-Core.git")
!(import! &self (library OmegaClaw-Core modules/gameboy/entry.metta))

!(println! (eval (gb-status)))
!(println! (match &self (Provides omegaclaw.simulation.gameboy $thing) $thing))
!(println! (match &self (SimulationCapability gameboy $capability) $capability))
