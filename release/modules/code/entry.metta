; omegahive.code module.
; Lets an Omega mind work on code through OmegaCode, as itself: on a goal it holds, in an isolated
; workspace, with every change approved exactly and redeemed once.  The membrane remembers which
; version of each file the mind last read and edits against that, so a person's edit in between is
; never silently overwritten: the mind's edit is refused as stale and it reads again.

(Module omegahive.code)
(ModuleKind omegahive.code coding-organ)
(ModuleVersion omegahive.code "0.1.0")
(ModuleEntrypoint omegahive.code "entry.metta")
(ModuleOptional omegahive.code True)
(ModuleDefaultEnabled omegahive.code True)
(ModuleImplementation omegahive.code omegacode-native-membrane)

(Provides omegahive.code (Skill code-repos))
(Provides omegahive.code (Skill code-open))
(Provides omegahive.code (Skill code-tools))
(Provides omegahive.code (Skill code-read))
(Provides omegahive.code (Skill code-search))
(Provides omegahive.code (Skill code-replace))
(Provides omegahive.code (Skill code-exec))
(Provides omegahive.code (Skill code-status))
(Provides omegahive.code (Skill code-changes))
(Provides omegahive.code (Skill code-check))

(Provides omegahive.code (Skill code-runs))
(Provides omegahive.code (Skill code-verifications))
(Provides omegahive.code (Skill code-output))
(Provides omegahive.code (Skill code-diagnostics))

(Provides omegahive.code (Skill code-create))
(Provides omegahive.code (Skill code-move))
(Provides omegahive.code (Skill code-remove))

(Provides omegahive.code (Skill code-git))
(Provides omegahive.code (Skill code-review))
(Provides omegahive.code (Skill code-hunks))
(Provides omegahive.code (Skill code-hunk-bytes))
(Provides omegahive.code (Skill code-select))

(OrganPrinciple omegahive.code "Code is changed in an isolated workspace on a goal the mind holds; every change is approved exactly; the running code is untouched until a person applies it.")

(RuntimeDependency omegahive.code python ">=3.10")
(RuntimeDependency omegahive.code service "omegacode")
(RuntimeConfig omegahive.code HIVE_API_URL "runtime-config")
(RuntimeConfig omegahive.code HIVE_WS_TOKEN "runtime-secret")
(RuntimeConfig omegahive.code OMEGACODE_SRC "runtime-config")

!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/code/src/omega_code.py))))
!(import! &self (library OmegaClaw-Core ./modules/code/catalog.metta))
!(import! &self (library OmegaClaw-Core ./modules/code/affordance.metta))
!(import! &self (library OmegaClaw-Core ./modules/code/signatures.metta))
!(import! &self (library OmegaClaw-Core ./modules/code/skills.metta))
(Provides omegahive.code (Skill code-git-export))
(Provides omegahive.code (Skill code-git-export-state))
(Provides omegahive.code (Skill code-git-patch))
(Provides omegahive.code (Skill code-merge-preview))
(Provides omegahive.code (Skill code-merge-files))
(Provides omegahive.code (Skill code-merge-bytes))
(Provides omegahive.code (Skill code-merge-apply))

(Provides omegahive.code (Skill code-git-original-export))

(Provides omegahive.code (Skill code-retrieve))

(Provides omegahive.code (Skill code-proof-result))

(Provides omegahive.code (Skill code-proof-check))
