; omegaclaw.media.videogen module.
; MeTTa declares the cognitive surface; Python/JS only execute boundary actions.

(Module omegaclaw.media.videogen)
(ModuleKind omegaclaw.media.videogen media-organ)
(ModuleVersion omegaclaw.media.videogen "0.1.0")
(ModuleEntrypoint omegaclaw.media.videogen "entry.metta")
(ModuleOptional omegaclaw.media.videogen True)
(ModuleDefaultEnabled omegaclaw.media.videogen True)
(ModuleImplementation omegaclaw.media.videogen video-generation-membrane)


(Provides omegaclaw.media.videogen (Skill generate-video))
(Provides omegaclaw.media.videogen (Skill video-config-status))

(OrganPrinciple omegaclaw.media.videogen "Media Videogen exposes capability and trace; it does not decide cognition.")

(RuntimeDependency omegaclaw.media.videogen python ">=3.10")

(TraceWrites omegaclaw.media.videogen VideoGenerated)
(TraceWrites omegaclaw.media.videogen VideoConfigObserved)

!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/media_videogen/src/videogen.py))))
!(import! &self (library OmegaClaw-Core ./modules/media_videogen/catalog.metta))
!(import! &self (library OmegaClaw-Core ./modules/media_videogen/affordance.metta))
!(import! &self (library OmegaClaw-Core ./modules/media_videogen/signatures.metta))
!(import! &self (library OmegaClaw-Core ./modules/media_videogen/skills.metta))
