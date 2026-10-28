; omegaclaw.channel.router module.
; MeTTa declares the cognitive surface; Python/JS only execute boundary actions.

(Module omegaclaw.channel.router)
(ModuleKind omegaclaw.channel.router channel-router)
(ModuleVersion omegaclaw.channel.router "0.1.0")
(ModuleEntrypoint omegaclaw.channel.router "entry.metta")
(ModuleOptional omegaclaw.channel.router True)
(ModuleDefaultEnabled omegaclaw.channel.router True)
(ModuleImplementation omegaclaw.channel.router symbolic-channel-dispatch-membrane)

(ChannelRoutePolicy channels symbolic-config-first)
(ChannelRoutePolicy channels no-private-defaults)

(ChannelRouter channels)
(Provides omegaclaw.channel.router (RuntimeOrgan channel-router))
(Provides omegaclaw.channel.router (Skill initChannels))
(Provides omegaclaw.channel.router (Skill receive))
(Provides omegaclaw.channel.router (Skill send))
(Provides omegaclaw.channel.router (Skill send-control))
(Provides omegaclaw.channel.router (Skill send-hive-to))
(Provides omegaclaw.channel.router (Skill send-control-base64))
(Provides omegaclaw.channel.router (Skill send-file))
(Provides omegaclaw.channel.router (Skill send-file-caption))
(Provides omegaclaw.channel.router (Skill list-inbox))

(OrganPrinciple omegaclaw.channel.router "The router dispatches among enabled channels; it does not decide cognition or message meaning.")
(OrganPrinciple omegaclaw.channel.router "Primary operator routing is configuration/state, not a hardcoded person.")
(OrganPrinciple omegaclaw.channel.router "All external dispatch should be traceable through the target channel membrane.")

(RuntimeDependency omegaclaw.channel.router python ">=3.10")

(TraceWrites omegaclaw.channel.router ChannelRouteObserved)
(TraceWrites omegaclaw.channel.router ChannelMessageDispatched)
(TraceWrites omegaclaw.channel.router ChannelDispatchError)

!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/channel_router/src/router.py))))
!(import! &self (library OmegaClaw-Core ./modules/channel_router/catalog.metta))
!(import! &self (library OmegaClaw-Core ./modules/channel_router/affordance.metta))
!(import! &self (library OmegaClaw-Core ./modules/channel_router/signatures.metta))
!(import! &self (library OmegaClaw-Core ./modules/channel_router/skills.metta))
