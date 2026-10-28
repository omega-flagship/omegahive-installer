; omegaclaw.channel.web-control module.
; MeTTa declares the cognitive surface; Python/JS only execute boundary actions.

(Module omegaclaw.channel.web-control)
(ModuleKind omegaclaw.channel.web-control channel)
(ModuleVersion omegaclaw.channel.web-control "0.1.0")
(ModuleEntrypoint omegaclaw.channel.web-control "entry.metta")
(ModuleOptional omegaclaw.channel.web-control True)
(ModuleDefaultEnabled omegaclaw.channel.web-control True)
(ModuleImplementation omegaclaw.channel.web-control web-control-membrane)


(Channel web-control)
(Provides omegaclaw.channel.web-control (Channel web-control))
(Provides omegaclaw.channel.web-control (Skill send-web-control))
(Provides omegaclaw.channel.web-control (Skill send-web-control-base64))
(ChannelCapability web-control text-send)

(OrganPrinciple omegaclaw.channel.web-control "Web control is a channel membrane, not cognition.")

(RuntimeDependency omegaclaw.channel.web-control python ">=3.10")

(TraceWrites omegaclaw.channel.web-control WebControlMessageReceived)
(TraceWrites omegaclaw.channel.web-control WebControlMessageSent)

!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/channel_web_control/src/web_control.py))))
!(import! &self (library OmegaClaw-Core ./modules/channel_web_control/catalog.metta))
!(import! &self (library OmegaClaw-Core ./modules/channel_web_control/affordance.metta))
!(import! &self (library OmegaClaw-Core ./modules/channel_web_control/signatures.metta))
!(import! &self (library OmegaClaw-Core ./modules/channel_web_control/skills.metta))
