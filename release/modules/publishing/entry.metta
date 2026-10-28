; Publishing skill module.
;
; This module exposes the agent's symbolic publishing affordance. The current
; implementation delegates to an optional local webhost backend, but the agent sees
; the stable MeTTa skill surface.

(Module omegaclaw.skill.publishing)
(ModuleKind omegaclaw.skill.publishing skill-pack)
(ModuleVersion omegaclaw.skill.publishing "0.1.0")
(ModuleEntrypoint omegaclaw.skill.publishing "entry.metta")
(ModuleOptional omegaclaw.skill.publishing True)
(ModuleDefaultEnabled omegaclaw.skill.publishing True)
(ModuleImplementation omegaclaw.skill.publishing python-membrane)

(PublishingSurface publishing)
(Provides omegaclaw.skill.publishing (Skill write-web-page))
(Provides omegaclaw.skill.publishing (Skill list-web-pages))
(Provides omegaclaw.skill.publishing (Skill public-web-url))
(Provides omegaclaw.skill.publishing (Skill webhost-status))
(Provides omegaclaw.skill.publishing (Skill artifact-id))
(Provides omegaclaw.skill.publishing (Skill publish-artifact))
(Provides omegaclaw.skill.publishing (Skill unpublish-artifact))
(Provides omegaclaw.skill.publishing (Skill list-published-artifacts))

(PublishingCapability publishing web-page-write)
(PublishingCapability publishing artifact-publish)
(PublishingCapability publishing artifact-unpublish)
(PublishingCapability publishing public-url)

(RuntimeDependency omegaclaw.skill.publishing python ">=3.10")

(TraceWrites omegaclaw.skill.publishing WebPageWritten)
(TraceWrites omegaclaw.skill.publishing ArtifactPublished)
(TraceWrites omegaclaw.skill.publishing ArtifactUnpublished)

!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/publishing/src/publishing.py))))
!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/publishing/catalog.metta))))
!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/publishing/affordance.metta))))
!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/publishing/signatures.metta))))
!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/publishing/skills.metta))))
