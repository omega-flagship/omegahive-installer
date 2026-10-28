; omegaclaw.hive.studio module (J3 host R6.1).
; A Studio maker's three calls for an omega mind: read the step's context, publish its one proposal, finish the step.
; Loaded only while the hive's Studio sessions are on: the supervisor adds this module's import to the mind's run.metta
; and names it in OMEGACLAW_EXTRA_MODULES, so with Studio off the skill surface is exactly the default one.

(Module omegaclaw.hive.studio)
(ModuleKind omegaclaw.hive.studio swarm-organ)
(ModuleVersion omegaclaw.hive.studio "0.1.0")
(ModuleEntrypoint omegaclaw.hive.studio "entry.metta")
(ModuleOptional omegaclaw.hive.studio True)
(ModuleDefaultEnabled omegaclaw.hive.studio False)
(ModuleImplementation omegaclaw.hive.studio hive-api-membrane)

(Provides omegaclaw.hive.studio (Skill hive-studio-context))
(Provides omegaclaw.hive.studio (Skill hive-studio-publish))
(Provides omegaclaw.hive.studio (Skill hive-studio-done))

(OrganPrinciple omegaclaw.hive.studio "A Studio step is answered by its tools: read the context first, publish at most one proposal, then finish the step.")

(RuntimeDependency omegaclaw.hive.studio python ">=3.10")
(RuntimeConfig omegaclaw.hive.studio HIVE_API_URL "runtime-config")
(RuntimeConfig omegaclaw.hive.studio HIVE_WS_TOKEN "runtime-secret")

!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/hive_studio/src/hive_studio.py))))
!(import! &self (library OmegaClaw-Core ./modules/hive_studio/catalog.metta))
!(import! &self (library OmegaClaw-Core ./modules/hive_studio/affordance.metta))
!(import! &self (library OmegaClaw-Core ./modules/hive_studio/signatures.metta))
!(import! &self (library OmegaClaw-Core ./modules/hive_studio/skills.metta))
