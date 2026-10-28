; omegaclaw.media.imagegen module.
; MeTTa declares the cognitive surface; Python/JS only execute boundary actions.

(Module omegaclaw.media.imagegen)
(ModuleKind omegaclaw.media.imagegen media-organ)
(ModuleVersion omegaclaw.media.imagegen "0.1.0")
(ModuleEntrypoint omegaclaw.media.imagegen "entry.metta")
(ModuleOptional omegaclaw.media.imagegen True)
(ModuleDefaultEnabled omegaclaw.media.imagegen True)
(ModuleImplementation omegaclaw.media.imagegen image-generation-membrane)


(Provides omegaclaw.media.imagegen (Skill generate-image))
(Provides omegaclaw.media.imagegen (Skill generate-image-quality))

(OrganPrinciple omegaclaw.media.imagegen "Media Imagegen exposes capability and trace; it does not decide cognition.")

(RuntimeDependency omegaclaw.media.imagegen python ">=3.10")

(TraceWrites omegaclaw.media.imagegen ImageGenerated)

!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/media_imagegen/src/imagegen.py))))
!(import! &self (library OmegaClaw-Core ./modules/media_imagegen/catalog.metta))
!(import! &self (library OmegaClaw-Core ./modules/media_imagegen/affordance.metta))
!(import! &self (library OmegaClaw-Core ./modules/media_imagegen/signatures.metta))
!(import! &self (library OmegaClaw-Core ./modules/media_imagegen/skills.metta))
