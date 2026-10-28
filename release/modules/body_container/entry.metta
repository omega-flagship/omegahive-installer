; Grounded body-container organ for the VM the agent is currently embodied in.
;
; This is not the agent self. It is the symbolic handle for the host VM body
; launched by a platform runner such as platform-runner.app. The runner is intentionally
; dumb: it starts the body; the agent does the cognition once awake.

(Module omegaclaw.body.container)
(ModuleKind omegaclaw.body.container runtime-organ)
(ModuleVersion omegaclaw.body.container "0.1.0")
(ModuleEntrypoint omegaclaw.body.container "entry.metta")
(ModuleOptional omegaclaw.body.container True)
(ModuleDefaultEnabled omegaclaw.body.container False)
(ModuleImplementation omegaclaw.body.container host-launcher-membrane)

(RuntimeOrgan "body-container" (initBodyContainerOrgan))
(TrustedRuntimeOrgan "body-container")

(BodyContainer omega-body-vm)
(Embodies omega-body-vm agent-self)
(ContainerType omega-body-vm utm-qemu-linux-vm)
(GroundedBy omega-body-vm "utm:A3147D34-14D8-49EB-990E-8A50FAF75A3D")
(LaunchedBy omega-body-vm "platform-runner.app")
(Contains omega-body-vm omega-loop)
(Contains omega-body-vm whatsapp-bridge)
(Contains omega-body-vm webhost)
(Contains omega-body-vm assume-daemon)
(Contains omega-body-vm home-assistant)

(Provides omegaclaw.body.container (RuntimeOrgan body-container))
(Provides omegaclaw.body.container (Skill body-container-status))
(Provides omegaclaw.body.container (Skill body-container-self))
(Provides omegaclaw.body.container (Skill body-container-launcher))
(Provides omegaclaw.body.container (Skill body-container-last-trace))

(BodyContainerCapability omega-body-vm observe-host-grounding)
(BodyContainerCapability omega-body-vm observe-local-processes)
(BodyContainerCapability omega-body-vm observe-resource-pressure)
(BodyContainerCapability omega-body-vm single-cognition-process)

(RuntimeDependency omegaclaw.body.container python ">=3.10")
(RuntimeDependency omegaclaw.body.container host-launcher "platform-runner.app")
(RuntimeState omegaclaw.body.container OMEGACLAW_BODY_CONTAINER_CONFIG ignored)

(TraceWrites omegaclaw.body.container BodyContainerObserved)
(TraceWrites omegaclaw.body.container BodyContainerLauncherSeen)

!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/body_container/src/body_container.py))))
!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/body_container/catalog.metta))))
!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/body_container/affordance.metta))))
!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/body_container/signatures.metta))))
!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/body_container/skills.metta))))
