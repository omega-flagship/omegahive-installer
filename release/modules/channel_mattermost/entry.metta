; omegaclaw.channel.mattermost module.
; MeTTa declares the cognitive surface; Python/JS only execute boundary actions.

(Module omegaclaw.channel.mattermost)
(ModuleKind omegaclaw.channel.mattermost channel)
(ModuleVersion omegaclaw.channel.mattermost "0.1.0")
(ModuleEntrypoint omegaclaw.channel.mattermost "entry.metta")
(ModuleOptional omegaclaw.channel.mattermost True)
(ModuleDefaultEnabled omegaclaw.channel.mattermost False)
(ModuleImplementation omegaclaw.channel.mattermost mattermost-channel-membrane)


(Channel mattermost)
(Provides omegaclaw.channel.mattermost (Channel mattermost))
(ChannelCapability mattermost text-send)

(OrganPrinciple omegaclaw.channel.mattermost "Mattermost is a channel membrane only.")

(RuntimeDependency omegaclaw.channel.mattermost python ">=3.10")

(TraceWrites omegaclaw.channel.mattermost MattermostMessageReceived)
(TraceWrites omegaclaw.channel.mattermost MattermostMessageSent)

!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/channel_mattermost/src/mattermost.py))))
!(import! &self (library OmegaClaw-Core ./modules/channel_mattermost/catalog.metta))
!(import! &self (library OmegaClaw-Core ./modules/channel_mattermost/affordance.metta))
!(import! &self (library OmegaClaw-Core ./modules/channel_mattermost/signatures.metta))
!(import! &self (library OmegaClaw-Core ./modules/channel_mattermost/skills.metta))
