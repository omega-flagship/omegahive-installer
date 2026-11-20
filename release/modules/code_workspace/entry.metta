; omegahive.code.workspace module.
; Lets an Omega mind work on code through OmegaCode, as itself: on a goal it holds, in an isolated
; workspace, with every change approved exactly and redeemed once.  The membrane remembers which
; version of each file the mind last read and edits against that, so a person's edit in between is
; never silently overwritten: the mind's edit is refused as stale and it reads again.
; Every skill here but code-repos calls OmegaCode through its native client (modules/code/src/omega_code.py), and
; code-repos lists what code-open opens, so the module requires that client (service:omegacode) and a mind without
; it loads none of them.

(Module omegahive.code.workspace)
(ModuleKind omegahive.code.workspace coding-organ)
(ModuleVersion omegahive.code.workspace "0.3.0")
(ModuleEntrypoint omegahive.code.workspace "entry.metta")
(ModuleOptional omegahive.code.workspace True)
(ModuleDefaultEnabled omegahive.code.workspace True)
(ModuleImplementation omegahive.code.workspace omegacode-native-membrane)

(Provides omegahive.code.workspace (Skill code-repos))
(Provides omegahive.code.workspace (Skill code-open))
(Provides omegahive.code.workspace (Skill code-tools))
(Provides omegahive.code.workspace (Skill code-read))
(Provides omegahive.code.workspace (Skill code-search))
(Provides omegahive.code.workspace (Skill code-replace))
(Provides omegahive.code.workspace (Skill code-exec))
(Provides omegahive.code.workspace (Skill code-status))
(Provides omegahive.code.workspace (Skill code-changes))
(Provides omegahive.code.workspace (Skill code-check))

(Provides omegahive.code.workspace (Skill code-runs))
(Provides omegahive.code.workspace (Skill code-verifications))
(Provides omegahive.code.workspace (Skill code-output))
(Provides omegahive.code.workspace (Skill code-diagnostics))

(Provides omegahive.code.workspace (Skill code-create))
(Provides omegahive.code.workspace (Skill code-move))
(Provides omegahive.code.workspace (Skill code-remove))

(Provides omegahive.code.workspace (Skill code-git))
(Provides omegahive.code.workspace (Skill code-review))
(Provides omegahive.code.workspace (Skill code-hunks))
(Provides omegahive.code.workspace (Skill code-hunk-bytes))
(Provides omegahive.code.workspace (Skill code-select))
(Provides omegahive.code.workspace (Skill code-git-export))
(Provides omegahive.code.workspace (Skill code-git-export-state))
(Provides omegahive.code.workspace (Skill code-git-patch))
(Provides omegahive.code.workspace (Skill code-merge-preview))
(Provides omegahive.code.workspace (Skill code-merge-files))
(Provides omegahive.code.workspace (Skill code-merge-bytes))
(Provides omegahive.code.workspace (Skill code-merge-apply))

(Provides omegahive.code.workspace (Skill code-git-original-export))

(Provides omegahive.code.workspace (Skill code-retrieve))

(Provides omegahive.code.workspace (Skill code-proof-result))

(Provides omegahive.code.workspace (Skill code-proof-check))

(OrganPrinciple omegahive.code.workspace "Code is changed in an isolated workspace on a goal the mind holds; every change is approved exactly; the running code is untouched until a person applies it.")

(RuntimeDependency omegahive.code.workspace python ">=3.10")
(RuntimeDependency omegahive.code.workspace service "omegacode")
(RuntimeConfig omegahive.code.workspace HIVE_API_URL "runtime-config")
(RuntimeConfig omegahive.code.workspace HIVE_WS_TOKEN "runtime-secret")
(RuntimeConfig omegahive.code.workspace OMEGACODE_SRC "runtime-config")

!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/code/src/omega_code.py))))
!(import! &self (library OmegaClaw-Core ./modules/code_workspace/catalog.metta))
!(import! &self (library OmegaClaw-Core ./modules/code_workspace/affordance.metta))
!(import! &self (library OmegaClaw-Core ./modules/code_workspace/signatures.metta))
!(import! &self (library OmegaClaw-Core ./modules/code_workspace/skills.metta))
