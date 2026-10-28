; omegaclaw.sense.webcam module.
; MeTTa declares the cognitive surface; Python/JS only execute boundary actions.

(Module omegaclaw.sense.webcam)
(ModuleKind omegaclaw.sense.webcam sense)
(ModuleVersion omegaclaw.sense.webcam "0.1.0")
(ModuleEntrypoint omegaclaw.sense.webcam "entry.metta")
(ModuleOptional omegaclaw.sense.webcam True)
(ModuleDefaultEnabled omegaclaw.sense.webcam True)
(ModuleImplementation omegaclaw.sense.webcam webcam-capture-membrane)


(SenseOrgan sense-webcam)
(Provides omegaclaw.sense.webcam (Sense webcam))
(Provides omegaclaw.sense.webcam (Skill webcam-status))
(Provides omegaclaw.sense.webcam (Skill capture-webcam))
(Provides omegaclaw.sense.webcam (Skill inspect-webcam))
(Provides omegaclaw.sense.webcam (Skill webcam-observation-log))

(OrganPrinciple omegaclaw.sense.webcam "Sense Webcam exposes capability and trace; it does not decide cognition.")

(RuntimeDependency omegaclaw.sense.webcam python ">=3.10")

(TraceWrites omegaclaw.sense.webcam WebcamCapture)
(TraceWrites omegaclaw.sense.webcam WebcamInspection)
(TraceWrites omegaclaw.sense.webcam WebcamObservation)

!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/sense_webcam/src/webcam.py))))
!(import! &self (library OmegaClaw-Core ./modules/sense_webcam/catalog.metta))
!(import! &self (library OmegaClaw-Core ./modules/sense_webcam/affordance.metta))
!(import! &self (library OmegaClaw-Core ./modules/sense_webcam/signatures.metta))
!(import! &self (library OmegaClaw-Core ./modules/sense_webcam/skills.metta))
