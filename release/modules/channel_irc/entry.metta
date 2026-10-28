; omegaclaw.channel.irc module.
; MeTTa declares the cognitive surface; Python/JS only execute boundary actions.

(Module omegaclaw.channel.irc)
(ModuleKind omegaclaw.channel.irc channel)
(ModuleVersion omegaclaw.channel.irc "0.1.0")
(ModuleEntrypoint omegaclaw.channel.irc "entry.metta")
(ModuleOptional omegaclaw.channel.irc True)
(ModuleDefaultEnabled omegaclaw.channel.irc False)
(ModuleImplementation omegaclaw.channel.irc irc-channel-membrane)


(Channel irc)
(Provides omegaclaw.channel.irc (Channel irc))
(ChannelCapability irc text-send)

(OrganPrinciple omegaclaw.channel.irc "Irc is a channel membrane only.")

(RuntimeDependency omegaclaw.channel.irc python ">=3.10")

(TraceWrites omegaclaw.channel.irc IrcMessageReceived)
(TraceWrites omegaclaw.channel.irc IrcMessageSent)

!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/channel_irc/src/irc.py))))
!(import! &self (library OmegaClaw-Core ./modules/channel_irc/catalog.metta))
!(import! &self (library OmegaClaw-Core ./modules/channel_irc/affordance.metta))
!(import! &self (library OmegaClaw-Core ./modules/channel_irc/signatures.metta))
!(import! &self (library OmegaClaw-Core ./modules/channel_irc/skills.metta))
