; Isolated smoke for the OmegaClaw module contract.
; The contract must be visible as MeTTa atoms, not only as package metadata.

!(import! &self ./repos/OmegaClaw-Core/tests/fixtures/modules/whatsapp_channel/entry.metta)
!(import! &self ./repos/OmegaClaw-Core/tests/fixtures/modules/whatsapp_channel/catalog.metta)
!(import! &self ./repos/OmegaClaw-Core/tests/fixtures/modules/whatsapp_channel/signatures.metta)

!(println! MODULE-CONTRACT-MODULES)
!(println! (collapse (match &self (Module $module) $module)))

!(println! MODULE-CONTRACT-PROVIDES)
!(println! (collapse (match &self (Provides omegaclaw.channel.whatsapp $thing) $thing)))

!(println! MODULE-CONTRACT-FILE-CHANNELS)
!(println! (collapse (match &self (ChannelCapability $channel file-send) $channel)))

!(println! MODULE-CONTRACT-TRACE)
!(println! (collapse (match &self (TraceWrites omegaclaw.channel.whatsapp $event) $event)))

!(println! MODULE-CONTRACT-SIGNATURES)
!(println! (collapse (match &self (SkillSignature send-channel $channel $chat $message)
                           (SendChannelSignature $channel $chat $message))))
