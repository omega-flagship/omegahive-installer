; Game Boy simulation module.
;
; This exposes a Game Boy emulator as a symbolic simulation affordance. ROM
; files live in ignored runtime storage and are not part of the source tree.

(Module omegaclaw.simulation.gameboy)
(ModuleKind omegaclaw.simulation.gameboy simulation)
(ModuleVersion omegaclaw.simulation.gameboy "0.1.0")
(ModuleEntrypoint omegaclaw.simulation.gameboy "entry.metta")
(ModuleOptional omegaclaw.simulation.gameboy True)
(ModuleDefaultEnabled omegaclaw.simulation.gameboy False)
(ModuleImplementation omegaclaw.simulation.gameboy pyboy-membrane)

(Simulation gameboy)
(Game gameboy)
(Provides omegaclaw.simulation.gameboy (Simulation gameboy))
(Provides omegaclaw.simulation.gameboy (Skill gb-status))
(Provides omegaclaw.simulation.gameboy (Skill gb-load))
(Provides omegaclaw.simulation.gameboy (Skill gb-observe))
(Provides omegaclaw.simulation.gameboy (Skill gb-step))
(Provides omegaclaw.simulation.gameboy (Skill gb-screenshot))
(Provides omegaclaw.simulation.gameboy (Skill gb-save-state))
(Provides omegaclaw.simulation.gameboy (Skill gb-stop))
(Provides omegaclaw.simulation.gameboy (Skill gb-load-state))
(Provides omegaclaw.simulation.gameboy (Skill gb-last-trace))

(SimulationCapability gameboy state-observable)
(SimulationCapability gameboy action-feedback)
(SimulationCapability gameboy screenshot-observable)
(SimulationCapability gameboy save-state)
(SimulationCapability gameboy private-rom-runtime)

(RuntimeDependency omegaclaw.simulation.gameboy python ">=3.10")
(RuntimeDependency omegaclaw.simulation.gameboy pyboy ">=2")
(RuntimeDependency omegaclaw.simulation.gameboy pillow ">=10")
(RuntimeState omegaclaw.simulation.gameboy OMEGACLAW_GAMEBOY_ROM_DIR ignored)

(TraceWrites omegaclaw.simulation.gameboy GameBoyLoaded)
(TraceWrites omegaclaw.simulation.gameboy GameBoyObserved)
(TraceWrites omegaclaw.simulation.gameboy GameBoyActionTaken)
(TraceWrites omegaclaw.simulation.gameboy GameBoyScreenshotSaved)
(TraceWrites omegaclaw.simulation.gameboy GameBoyStateSaved)
(TraceWrites omegaclaw.simulation.gameboy GameBoyStateLoaded)
(TraceWrites omegaclaw.simulation.gameboy GameBoyStopped)

!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/gameboy/src/gameboy.py))))
!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/gameboy/catalog.metta))))
!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/gameboy/affordance.metta))))
!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/gameboy/signatures.metta))))
!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/gameboy/skills.metta))))
