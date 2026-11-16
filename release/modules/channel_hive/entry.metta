; omegaclaw.channel.hive module.
; Connects this agent to an OmegaDots Hive agent hub over WebSocket.
; Select it with commchannel=hive plus HIVE_WS_URL and HIVE_WS_TOKEN.

(Module omegaclaw.channel.hive)
(ModuleKind omegaclaw.channel.hive channel)
(ModuleVersion omegaclaw.channel.hive "0.1.0")
(ModuleEntrypoint omegaclaw.channel.hive "entry.metta")
(ModuleOptional omegaclaw.channel.hive True)
(ModuleDefaultEnabled omegaclaw.channel.hive True)
(ModuleImplementation omegaclaw.channel.hive hive-websocket-membrane)

(Channel hive)
(Provides omegaclaw.channel.hive (Channel hive))
(ChannelCapability hive text-send)
(ChannelCapability hive resume-after-reconnect)

(OrganPrinciple omegaclaw.channel.hive "The hive channel is a membrane to the agent hub, not cognition.")

(RuntimeDependency omegaclaw.channel.hive python ">=3.10")
(RuntimeDependency omegaclaw.channel.hive websockets ">=12")

(TraceWrites omegaclaw.channel.hive HiveMessageReceived)
(TraceWrites omegaclaw.channel.hive HiveMessageSent)

!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/channel_hive/src/hive_channel.py))))
