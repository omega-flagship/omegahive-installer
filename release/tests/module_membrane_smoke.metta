; Isolated smoke for implementation-independent module membranes.
; WhatsApp is declared as a node bridge, echo as an opaque executable. the agent sees
; the same generic send-channel affordance through MeTTa either way.

!(import! &self ./repos/OmegaClaw-Core/tests/fixtures/modules/whatsapp_channel/entry.metta)
!(import! &self ./repos/OmegaClaw-Core/tests/fixtures/modules/echo_channel/entry.metta)

!(println! MODULE-MEMBRANE-SEND-PROVIDERS)
!(println! (collapse (match &self (Provides $module (Skill send-channel)) $module)))

!(println! MODULE-MEMBRANE-TEXT-CHANNELS)
!(println! (collapse (match &self (ChannelCapability $channel text-send) $channel)))

!(println! MODULE-MEMBRANE-INTERNALS)
!(println! (collapse (match &self (ModuleImplementation $module $implementation)
                           (Implementation $module $implementation))))

!(println! MODULE-MEMBRANE-TRACE)
!(println! (collapse (match &self (TraceWrites $module ChannelMessageSent) $module)))
