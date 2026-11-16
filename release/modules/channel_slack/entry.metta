; omegaclaw.channel.slack module.
; MeTTa declares the cognitive surface; Python/JS only execute boundary actions.

(Module omegaclaw.channel.slack)
(ModuleKind omegaclaw.channel.slack channel)
(ModuleVersion omegaclaw.channel.slack "0.1.0")
(ModuleEntrypoint omegaclaw.channel.slack "entry.metta")
(ModuleOptional omegaclaw.channel.slack True)
(ModuleDefaultEnabled omegaclaw.channel.slack False)
(ModuleImplementation omegaclaw.channel.slack slack-channel-membrane)


(Channel slack)
(Provides omegaclaw.channel.slack (Channel slack))
(ChannelCapability slack text-send)

(OrganPrinciple omegaclaw.channel.slack "Slack is a channel membrane only.")

(RuntimeDependency omegaclaw.channel.slack python ">=3.10")

(TraceWrites omegaclaw.channel.slack SlackMessageReceived)
(TraceWrites omegaclaw.channel.slack SlackMessageSent)

!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/channel_slack/src/slack.py))))
!(import! &self (library OmegaClaw-Core ./modules/channel_slack/catalog.metta))
!(import! &self (library OmegaClaw-Core ./modules/channel_slack/affordance.metta))
!(import! &self (library OmegaClaw-Core ./modules/channel_slack/signatures.metta))
!(import! &self (library OmegaClaw-Core ./modules/channel_slack/skills.metta))
