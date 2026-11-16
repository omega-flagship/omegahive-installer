; omegaclaw.sense.audio module.
; MeTTa declares the cognitive surface; Python/JS only execute boundary actions.

(Module omegaclaw.sense.audio)
(ModuleKind omegaclaw.sense.audio sense)
(ModuleVersion omegaclaw.sense.audio "0.1.0")
(ModuleEntrypoint omegaclaw.sense.audio "entry.metta")
(ModuleOptional omegaclaw.sense.audio True)
(ModuleDefaultEnabled omegaclaw.sense.audio True)
(ModuleImplementation omegaclaw.sense.audio audio-transcription-membrane)


(SenseOrgan sense-audio)
(Provides omegaclaw.sense.audio (Sense audio))
(Provides omegaclaw.sense.audio (Skill observe-audio))
(Provides omegaclaw.sense.audio (Skill inspect-audio))
(Provides omegaclaw.sense.audio (Skill audio-observation-log))

(OrganPrinciple omegaclaw.sense.audio "Sense Audio exposes capability and trace; it does not decide cognition.")

(RuntimeDependency omegaclaw.sense.audio python ">=3.10")

(TraceWrites omegaclaw.sense.audio AudioObserved)
(TraceWrites omegaclaw.sense.audio AudioInspection)

!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/sense_audio/src/audio.py))))
!(import! &self (library OmegaClaw-Core ./modules/sense_audio/catalog.metta))
!(import! &self (library OmegaClaw-Core ./modules/sense_audio/affordance.metta))
!(import! &self (library OmegaClaw-Core ./modules/sense_audio/signatures.metta))
!(import! &self (library OmegaClaw-Core ./modules/sense_audio/skills.metta))
