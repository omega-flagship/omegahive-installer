; omegaclaw.channel.telegram module.
; MeTTa declares the cognitive surface; Python/JS only execute boundary actions.

(Module omegaclaw.channel.telegram)
(ModuleKind omegaclaw.channel.telegram channel)
(ModuleVersion omegaclaw.channel.telegram "0.1.0")
(ModuleEntrypoint omegaclaw.channel.telegram "entry.metta")
(ModuleOptional omegaclaw.channel.telegram True)
(ModuleDefaultEnabled omegaclaw.channel.telegram False)
(ModuleImplementation omegaclaw.channel.telegram telegram-bot-api-membrane)


(Channel telegram)
(Provides omegaclaw.channel.telegram (Channel telegram))
(Provides omegaclaw.channel.telegram (Skill send-telegram))
(Provides omegaclaw.channel.telegram (Skill send-telegram-base64))
(Provides omegaclaw.channel.telegram (Skill telegram-status))
(ChannelCapability telegram text-send)
(ChannelCapability telegram file-send)
(ChannelCapability telegram inbox)

(OrganPrinciple omegaclaw.channel.telegram "Telegram is a communication channel, not a reasoning layer.")

(RuntimeDependency omegaclaw.channel.telegram python ">=3.10")
(RuntimeConfig omegaclaw.channel.telegram TG_BOT_TOKEN "runtime-secret")
(RuntimeConfig omegaclaw.channel.telegram TG_CHAT_ID "deployment-local")
(RuntimeConfig omegaclaw.channel.telegram TG_POLL_TIMEOUT "20")

(TraceWrites omegaclaw.channel.telegram TelegramMessageReceived)
(TraceWrites omegaclaw.channel.telegram TelegramMessageSent)
(TraceWrites omegaclaw.channel.telegram TelegramFileSent)

!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/channel_telegram/src/telegram.py))))
!(import! &self (library OmegaClaw-Core ./modules/channel_telegram/catalog.metta))
!(import! &self (library OmegaClaw-Core ./modules/channel_telegram/affordance.metta))
!(import! &self (library OmegaClaw-Core ./modules/channel_telegram/signatures.metta))
!(import! &self (library OmegaClaw-Core ./modules/channel_telegram/skills.metta))
