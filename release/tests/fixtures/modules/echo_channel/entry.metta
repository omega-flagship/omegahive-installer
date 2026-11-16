; Fixture proving the module membrane can wrap an arbitrary implementation.
; This module has a different internal implementation from WhatsApp but exposes
; the same generic channel affordance.

(Module openclaw.channel.echo)
(ModuleKind openclaw.channel.echo channel)
(ModuleVersion openclaw.channel.echo "0.1.0")
(ModuleEntrypoint openclaw.channel.echo "entry.metta")
(ModuleOptional openclaw.channel.echo True)
(ModuleImplementation openclaw.channel.echo opaque-executable)

(Channel echo)
(Provides openclaw.channel.echo (Channel echo))
(Provides openclaw.channel.echo (Skill send-channel))

(ChannelCapability echo text-send)

(RuntimeDependency openclaw.channel.echo executable "any")

(TraceWrites openclaw.channel.echo ChannelMessageSent)
