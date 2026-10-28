; omegaclaw.sense.vision module.
; MeTTa declares the cognitive surface; Python/JS only execute boundary actions.

(Module omegaclaw.sense.vision)
(ModuleKind omegaclaw.sense.vision sense)
(ModuleVersion omegaclaw.sense.vision "0.1.0")
(ModuleEntrypoint omegaclaw.sense.vision "entry.metta")
(ModuleOptional omegaclaw.sense.vision True)
(ModuleDefaultEnabled omegaclaw.sense.vision True)
(ModuleImplementation omegaclaw.sense.vision vision-openrouter-membrane)


(SenseOrgan sense-vision)
(Provides omegaclaw.sense.vision (Sense image))
(Provides omegaclaw.sense.vision (Skill observe-image))
(Provides omegaclaw.sense.vision (Skill inspect-image))
(Provides omegaclaw.sense.vision (Skill media-observation-log))

(OrganPrinciple omegaclaw.sense.vision "Sense Vision exposes capability and trace; it does not decide cognition.")

(RuntimeDependency omegaclaw.sense.vision python ">=3.10")

(TraceWrites omegaclaw.sense.vision ImageObserved)
(TraceWrites omegaclaw.sense.vision ImageInspection)
(TraceWrites omegaclaw.sense.vision MediaObservation)

!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/sense_vision/src/vision.py))))
!(import! &self (library OmegaClaw-Core ./modules/sense_vision/catalog.metta))
!(import! &self (library OmegaClaw-Core ./modules/sense_vision/affordance.metta))
!(import! &self (library OmegaClaw-Core ./modules/sense_vision/signatures.metta))
!(import! &self (library OmegaClaw-Core ./modules/sense_vision/skills.metta))
