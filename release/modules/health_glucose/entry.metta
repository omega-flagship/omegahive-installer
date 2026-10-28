; omegaclaw.health.glucose module.
; MeTTa declares the cognitive surface; Python/JS only execute boundary actions.

(Module omegaclaw.health.glucose)
(ModuleKind omegaclaw.health.glucose body-app)
(ModuleVersion omegaclaw.health.glucose "0.1.0")
(ModuleEntrypoint omegaclaw.health.glucose "entry.metta")
(ModuleOptional omegaclaw.health.glucose True)
(ModuleDefaultEnabled omegaclaw.health.glucose False)
(ModuleImplementation omegaclaw.health.glucose glucose-app-membrane)


(SenseOrgan health-glucose)
(Provides omegaclaw.health.glucose (App glucose))
(Provides omegaclaw.health.glucose (Sense glucose))
(Provides omegaclaw.health.glucose (Skill glucose-app-status))
(Provides omegaclaw.health.glucose (Skill observe-glucose))
(Provides omegaclaw.health.glucose (Skill glucose-history))
(Provides omegaclaw.health.glucose (Skill set-glucose-watch))
(Provides omegaclaw.health.glucose (Skill glucose-watch-status))
(Provides omegaclaw.health.glucose (Skill clear-glucose-watch))
(Provides omegaclaw.health.glucose (Skill glucose-rings))

(OrganPrinciple omegaclaw.health.glucose "Health Glucose exposes capability and trace; it does not decide cognition.")

(RuntimeDependency omegaclaw.health.glucose python ">=3.10")

(TraceWrites omegaclaw.health.glucose GlucoseObserved)
(TraceWrites omegaclaw.health.glucose GlucoseWatchSet)
(TraceWrites omegaclaw.health.glucose GlucoseRing)
(TraceWrites omegaclaw.health.glucose GlucoseHistoryObserved)

!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/health_glucose/src/glucose.py))))
!(import! &self (library OmegaClaw-Core ./modules/health_glucose/catalog.metta))
!(import! &self (library OmegaClaw-Core ./modules/health_glucose/affordance.metta))
!(import! &self (library OmegaClaw-Core ./modules/health_glucose/signatures.metta))
!(import! &self (library OmegaClaw-Core ./modules/health_glucose/skills.metta))
