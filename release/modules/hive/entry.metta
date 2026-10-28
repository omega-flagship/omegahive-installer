; omegaclaw.hive.commons module.
; Lets an agent share beliefs with its swarm's commons in an OmegaDots Hive and
; read them back.  The hive validates statements, mints evidence ids and merges
; independent evidence by revision.

(Module omegaclaw.hive.commons)
(ModuleKind omegaclaw.hive.commons swarm-organ)
(ModuleVersion omegaclaw.hive.commons "0.1.0")
(ModuleEntrypoint omegaclaw.hive.commons "entry.metta")
(ModuleOptional omegaclaw.hive.commons True)
(ModuleDefaultEnabled omegaclaw.hive.commons True)
(ModuleImplementation omegaclaw.hive.commons hive-api-membrane)

(Provides omegaclaw.hive.commons (Skill hive-publish))
(Provides omegaclaw.hive.commons (Skill hive-query))
(Provides omegaclaw.hive.commons (Skill hive-belief))
(Provides omegaclaw.hive.commons (Skill hive-goals))
(Provides omegaclaw.hive.commons (Skill hive-goal-claim))
(Provides omegaclaw.hive.commons (Skill hive-goal-done))
(Provides omegaclaw.hive.commons (Skill hive-goal-fail))
(Provides omegaclaw.hive.commons (Skill hive-goal-create))
(Provides omegaclaw.hive.commons (Skill hive-goal-get))
(Provides omegaclaw.hive.commons (Skill hive-goal-propose))
(Provides omegaclaw.hive.commons (Skill hive-goal-cancel-ack))
(Provides omegaclaw.hive.commons (Skill hive-goal-heartbeat))
(Provides omegaclaw.hive.commons (Skill hive-shares))
(Provides omegaclaw.hive.commons (Skill hive-share-request))
(Provides omegaclaw.hive.commons (Skill hive-share-grant))
(Provides omegaclaw.hive.commons (Skill hive-share-deny))
(Provides omegaclaw.hive.commons (Skill hive-share-offer))
(Provides omegaclaw.hive.commons (Skill hive-shared))
(Provides omegaclaw.hive.commons (Skill hive-shared-page))
(Provides omegaclaw.hive.commons (Skill hive-shared-body))
(Provides omegaclaw.hive.commons (Skill hive-health))
(Provides omegaclaw.hive.commons (Skill hive-review-complete))
(Provides omegaclaw.hive.commons (Skill hive-rooms))
(Provides omegaclaw.hive.commons (Skill hive-goal-review))
(Provides omegaclaw.hive.commons (Skill hive-review-receipts))
(Provides omegaclaw.hive.commons (Skill hive-asset-put))
(Provides omegaclaw.hive.commons (Skill hive-asset-get))
(Provides omegaclaw.hive.commons (Skill hive-room-post))
(Provides omegaclaw.hive.commons (Skill hive-coffee-note))
(Provides omegaclaw.hive.commons (Skill hive-finding))
(Provides omegaclaw.hive.commons (Skill hive-revision-read))
(Provides omegaclaw.hive.commons (Skill hive-revision))
(Provides omegaclaw.hive.commons (Skill hive-revision-part))
(Provides omegaclaw.hive.commons (Skill hive-artifact-create))
(Provides omegaclaw.hive.commons (Skill hive-request))
(Provides omegaclaw.hive.commons (Skill hive-lifecycle-start))
(Provides omegaclaw.hive.commons (Skill hive-lifecycle-stop))
(Provides omegaclaw.hive.commons (Skill hive-lifecycle-status))
(Provides omegaclaw.hive.commons (Skill hive-exhibit))
(Provides omegaclaw.hive.commons (Skill hive-exhibit-space))

(OrganPrinciple omegaclaw.hive.commons "The commons is shared memory between minds. Private memory leaves this agent only when it publishes, or grants another mind of its swarm a timed share.")

(RuntimeDependency omegaclaw.hive.commons python ">=3.10")
(RuntimeConfig omegaclaw.hive.commons HIVE_API_URL "runtime-config")
(RuntimeConfig omegaclaw.hive.commons HIVE_WS_TOKEN "runtime-secret")

(TraceWrites omegaclaw.hive.commons HiveBeliefPublished)

; Report each model iteration to the hive timeline, and apply memory operations
; the operator queued (retire an atom, reset).  Both are no-ops off the hive.
(RuntimeHook response hive-trace (hive-report-trace))
(TrustedRuntimeHook response hive-trace)
(RuntimeHook cycle hive-control (hive-run-control))
(TrustedRuntimeHook cycle hive-control)
;; S4 boot receipt (function in skills.metta): once after the loader has run, tell the hive which modules and skill
;; heads this process registered.  A skill is "callable" only because this receipt says so; off the hive it is a no-op.
(RuntimeOrgan "hive-inventory" (hive-inventory-boot))
(TrustedRuntimeOrgan "hive-inventory")

!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/hive/src/hive_commons.py))))
!(import! &self (library OmegaClaw-Core ./modules/hive/catalog.metta))
!(import! &self (library OmegaClaw-Core ./modules/hive/affordance.metta))
!(import! &self (library OmegaClaw-Core ./modules/hive/signatures.metta))
!(import! &self (library OmegaClaw-Core ./modules/hive/skills.metta))

(Provides omegaclaw.hive.commons (Skill hive-plan-return))

(Provides omegaclaw.hive.commons (Skill hive-findings-read))

(Provides omegaclaw.hive.commons (Skill hive-plan-review-context))

(Provides omegaclaw.hive.commons (Skill hive-finding-response))

(Provides omegaclaw.hive.commons (Skill hive-finding-disposition))

(Provides omegaclaw.hive.commons (Skill hive-flows))

(Provides omegaclaw.hive.commons (Skill hive-flow-draft))

(Provides omegaclaw.hive.commons (Skill hive-flow-drafts))

(Provides omegaclaw.hive.commons (Skill hive-flow-revise))

(Provides omegaclaw.hive.commons (Skill hive-flow-read))

(Provides omegaclaw.hive.commons (Skill hive-flow-publish))

(Provides omegaclaw.hive.commons (Skill hive-flow-run))

(Provides omegaclaw.hive.commons (Skill hive-flow-run-get))

(Provides omegaclaw.hive.commons (Skill hive-flow-retire))

(Provides omegaclaw.hive.commons (Skill hive-flow-cancel))

(Provides omegaclaw.hive.commons (Skill repo-query))
(Provides omegaclaw.hive.commons (Skill calendar-read))
