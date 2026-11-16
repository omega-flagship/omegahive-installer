; omegaclaw.channel.mock module.
; MeTTa declares the cognitive surface; Python/JS only execute boundary actions.

(Module omegaclaw.channel.mock)
(ModuleKind omegaclaw.channel.mock channel)
(ModuleVersion omegaclaw.channel.mock "0.1.0")
(ModuleEntrypoint omegaclaw.channel.mock "entry.metta")
(ModuleOptional omegaclaw.channel.mock True)
(ModuleDefaultEnabled omegaclaw.channel.mock False)
(ModuleImplementation omegaclaw.channel.mock mock-channel-membrane)


(Channel mock)
(Provides omegaclaw.channel.mock (Channel mock))
(ChannelCapability mock text-send)

(OrganPrinciple omegaclaw.channel.mock "Mock is a channel membrane only.")

(RuntimeDependency omegaclaw.channel.mock python ">=3.10")

(TraceWrites omegaclaw.channel.mock MockMessageReceived)
(TraceWrites omegaclaw.channel.mock MockMessageSent)

!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/channel_mock/src/mock.py))))
!(import! &self (library OmegaClaw-Core ./modules/channel_mock/catalog.metta))
!(import! &self (library OmegaClaw-Core ./modules/channel_mock/affordance.metta))
!(import! &self (library OmegaClaw-Core ./modules/channel_mock/signatures.metta))
!(import! &self (library OmegaClaw-Core ./modules/channel_mock/skills.metta))
