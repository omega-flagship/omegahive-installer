; Fixture for a large operating-surface module.
; The UI runtime could be browser, desktop, VR, Spline, R3F, or anything else.
; the agent sees the symbolic organ surface.

(Module omegaclaw.os.omega-surface)
(ModuleKind omegaclaw.os.omega-surface operating-surface)
(ModuleVersion omegaclaw.os.omega-surface "0.1.0")
(ModuleEntrypoint omegaclaw.os.omega-surface "entry.metta")
(ModuleOptional omegaclaw.os.omega-surface True)
(ModuleImplementation omegaclaw.os.omega-surface spatial-browser-runtime)

(Surface omega-os)
(Provides omegaclaw.os.omega-surface (Surface omega-os))
(Provides omegaclaw.os.omega-surface (Skill open-window))
(Provides omegaclaw.os.omega-surface (Skill show-artifact))
(Provides omegaclaw.os.omega-surface (Skill move-window))
(Provides omegaclaw.os.omega-surface (Skill focus-surface))

(SurfaceCapability omega-os spatial-ui)
(SurfaceCapability omega-os chat-surface)
(SurfaceCapability omega-os artifact-gallery)
(SurfaceCapability omega-os live-mind-map)

(RuntimeDependency omegaclaw.os.omega-surface browser "any")
(RuntimeDependency omegaclaw.os.omega-surface websocket "any")

(TraceWrites omegaclaw.os.omega-surface UIEvent)
(TraceWrites omegaclaw.os.omega-surface UserInteraction)
(TraceWrites omegaclaw.os.omega-surface SurfaceStateChanged)
