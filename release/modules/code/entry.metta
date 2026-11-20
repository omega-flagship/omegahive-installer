; omegahive.code module.
; Lets an Omega mind take part in a person's Code request through the hive: a request helper reads the person's
; scope and retains proposals the person reviews and applies (code-proposal-*, code-propose, code-test-*), and
; Create · Code's controller starts and steers the code minds that do the work (code-mind-*). All of it goes
; through the hive's relay, so none of it needs the OmegaCode client; the skills that work in an OmegaCode
; workspace with that client are modules/code_workspace.

(Module omegahive.code)
(ModuleKind omegahive.code coding-organ)
(ModuleVersion omegahive.code "0.3.0")
(ModuleEntrypoint omegahive.code "entry.metta")
(ModuleOptional omegahive.code True)
(ModuleDefaultEnabled omegahive.code True)
(ModuleImplementation omegahive.code hive-relay-membrane)

(OrganPrinciple omegahive.code "A request's changes come back as retained proposals a person reviews and applies; code minds start only for a request the host holds, under its lease and budget.")

(RuntimeDependency omegahive.code python ">=3.10")
(RuntimeConfig omegahive.code HIVE_API_URL "runtime-config")
(RuntimeConfig omegahive.code HIVE_WS_TOKEN "runtime-secret")

!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/code/src/omega_code.py))))
!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/code/src/code_proposal.py))))
!(import! &self (library OmegaClaw-Core ./modules/code/catalog.metta))
!(import! &self (library OmegaClaw-Core ./modules/code/affordance.metta))
!(import! &self (library OmegaClaw-Core ./modules/code/signatures.metta))
!(import! &self (library OmegaClaw-Core ./modules/code/skills.metta))

; Request children retain proposals only; the person uses the existing Code decision route.
(Provides omegahive.code (Skill code-proposal-context))
(Provides omegahive.code (Skill code-helper-instruction))
(Provides omegahive.code (Skill code-review-packet))
(Provides omegahive.code (Skill code-proposal-read))
(Provides omegahive.code (Skill code-propose))

(Provides omegahive.code (Skill code-test-prepare))
(Provides omegahive.code (Skill code-test-run))
(Provides omegahive.code (Skill code-test-result))

(Provides omegahive.code (Skill code-mind-templates))

(Provides omegahive.code (Skill code-mind-spawn))

(Provides omegahive.code (Skill code-mind-prompt))

(Provides omegahive.code (Skill code-mind-control))

(Provides omegahive.code (Skill code-mind-status))

(Provides omegahive.code (Skill code-mind-scan))

(Provides omegahive.code (Skill code-mind-request))

(Provides omegahive.code (Skill code-mind-retry))

(Provides omegahive.code (Skill code-mind-work))
