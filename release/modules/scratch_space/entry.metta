; Scratch working-memory organ.
;
; &scratch is the agent's transient AtomSpace for provisional thought: drafts,
; half-formed hypotheses, temporary syntax experiments, and candidate plans.
; It is not long-term memory. Durable conclusions must be deliberately moved
; into &beliefs, &world, &events, or &persistent through the normal memory organs.

(Module omegaclaw.memory.scratch-space)
(ModuleKind omegaclaw.memory.scratch-space memory-organ)
(ModuleVersion omegaclaw.memory.scratch-space "0.1.0")
(ModuleEntrypoint omegaclaw.memory.scratch-space "entry.metta")
(ModuleOptional omegaclaw.memory.scratch-space False)
(ModuleDefaultEnabled omegaclaw.memory.scratch-space True)
(ModuleImplementation omegaclaw.memory.scratch-space metta-atomspace)

(Space scratch)
(Space scratch-ttl)
(MemoryOrgan scratch-space)
(RuntimeOrgan "scratch-space" (initScratchOrgan))
(TrustedRuntimeOrgan "scratch-space")
;; Decay runs after each thinking step (a model call), not every loop tick: idle ticks while a mind waits must not
;; age its notes, so "keep it 60 steps" means 60 thinking steps (OmegaHive, 4 October 2026, found by OmegaTruth).
(RuntimeHook response scratch-space (scratch-gc))
(TrustedRuntimeHook response scratch-space)

(Provides omegaclaw.memory.scratch-space (Space scratch))
(Provides omegaclaw.memory.scratch-space (Space scratch-ttl))
(Provides omegaclaw.memory.scratch-space (RuntimeOrgan scratch-space))
(Provides omegaclaw.memory.scratch-space (Skill scratch-status))
(Provides omegaclaw.memory.scratch-space (Skill scratch-add))
(Provides omegaclaw.memory.scratch-space (Skill scratch-remove))
(Provides omegaclaw.memory.scratch-space (Skill scratch-touch))
(Provides omegaclaw.memory.scratch-space (Skill scratch-find))
(Provides omegaclaw.memory.scratch-space (Skill scratch-examples))
(Provides omegaclaw.memory.scratch-space (Skill scratch-all-with-ttl))
(Provides omegaclaw.memory.scratch-space (Skill scratch-count))
(Provides omegaclaw.memory.scratch-space (Skill scratch-pressure))
(Provides omegaclaw.memory.scratch-space (Skill scratch-gc))
(Provides omegaclaw.memory.scratch-space (Skill scratch-promote))
(Provides omegaclaw.memory.scratch-space (Skill promote-scratch))

(ScratchCapability scratch transient-working-memory)
(ScratchCapability scratch ttl-decay)
(ScratchCapability scratch explicit-promotion)
(ScratchCapability scratch trace-on-write)
(ScratchCapability scratch no-automatic-truth-commitment)

(OrganPrinciple scratch-space "Scratch is a short-lived working space. It may hold provisional atoms, but the agent must choose when something deserves durable memory.")
(OrganPrinciple scratch-space "Scratch decay is a temporary TTL approximation until ECAN/attention can govern working-memory survival.")

(RuntimeDependency omegaclaw.memory.scratch-space python ">=3.10")
(RuntimeState omegaclaw.memory.scratch-space OMEGACLAW_MEMORY_DIR ignored)

(TraceWrites omegaclaw.memory.scratch-space ScratchAtomAdded)
(TraceWrites omegaclaw.memory.scratch-space ScratchAtomRemoved)
(TraceWrites omegaclaw.memory.scratch-space ScratchAtomTouched)
(TraceWrites omegaclaw.memory.scratch-space ScratchAtomExpired)
(TraceWrites omegaclaw.memory.scratch-space ScratchAtomPromoted)

!(bind! &scratch (new-space))
!(bind! &scratch-ttl (new-space))

!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/scratch_space/catalog.metta))))
!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/scratch_space/affordance.metta))))
!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/scratch_space/signatures.metta))))
!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/scratch_space/skills.metta))))
