; Minimal fixture for the OmegaClaw module contract.
; It deliberately declares symbolic affordances only; no live WhatsApp bridge is
; imported or started by this test fixture.

(Module omegaclaw.channel.whatsapp)
(ModuleKind omegaclaw.channel.whatsapp channel)
(ModuleVersion omegaclaw.channel.whatsapp "0.1.0")
(ModuleEntrypoint omegaclaw.channel.whatsapp "entry.metta")
(ModuleOptional omegaclaw.channel.whatsapp True)
(ModuleImplementation omegaclaw.channel.whatsapp node-bridge)

(Channel whatsapp)
(Provides omegaclaw.channel.whatsapp (Channel whatsapp))
(Provides omegaclaw.channel.whatsapp (Skill send-channel))
(Provides omegaclaw.channel.whatsapp (Skill read-channel))
(Provides omegaclaw.channel.whatsapp (Skill list-channel-inbox))
(Provides omegaclaw.channel.whatsapp (Skill send-whatsapp-mention-to))

(ChannelCapability whatsapp text-send)
(ChannelCapability whatsapp file-send)
(ChannelCapability whatsapp read-state)
(ChannelCapability whatsapp mentions)

(RuntimeDependency omegaclaw.channel.whatsapp python ">=3.10")
(RuntimeDependency omegaclaw.channel.whatsapp node ">=20")
(RuntimeState omegaclaw.channel.whatsapp OMEGACLAW_WA_AUTH_DIR ignored)

(TraceWrites omegaclaw.channel.whatsapp ChannelMessageReceived)
(TraceWrites omegaclaw.channel.whatsapp ChannelMessageSent)
(TraceWrites omegaclaw.channel.whatsapp ChannelReadStateChanged)
