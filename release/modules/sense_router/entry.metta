; omegaclaw.sense.router module.
; MeTTa declares the cognitive surface; Python/JS only execute boundary actions.

(Module omegaclaw.sense.router)
(ModuleKind omegaclaw.sense.router sense-router)
(ModuleVersion omegaclaw.sense.router "0.1.0")
(ModuleEntrypoint omegaclaw.sense.router "entry.metta")
(ModuleOptional omegaclaw.sense.router True)
(ModuleDefaultEnabled omegaclaw.sense.router True)
(ModuleImplementation omegaclaw.sense.router symbolic-observation-router-membrane)


(RuntimeOrgan sense-router)
(Provides omegaclaw.sense.router (RuntimeOrgan sense-router))
(Provides omegaclaw.sense.router (Skill observe))
(ObservationPolicy sense-router no-guessing)

(OrganPrinciple omegaclaw.sense.router "Observation routing maps a chosen target to a sense/app; it does not decide what matters.")

(RuntimeDependency omegaclaw.sense.router python ">=3.10")

(TraceWrites omegaclaw.sense.router ObservationRequested)
(TraceWrites omegaclaw.sense.router ObservationResult)
(TraceWrites omegaclaw.sense.router ObservationUnknownTarget)

!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/sense_router/src/observation.py))))
!(import! &self (library OmegaClaw-Core ./modules/sense_router/catalog.metta))
!(import! &self (library OmegaClaw-Core ./modules/sense_router/affordance.metta))
!(import! &self (library OmegaClaw-Core ./modules/sense_router/signatures.metta))
!(import! &self (library OmegaClaw-Core ./modules/sense_router/skills.metta))
