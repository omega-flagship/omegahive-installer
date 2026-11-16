; the agent-owned tiny Linux VM module.
;
; The MeTTa atoms are the cognitive contract. The VM itself is an external
; workspace-device membrane, not the agent's mind.

(Module omegaclaw.device.omega-vm)
(ModuleKind omegaclaw.device.omega-vm workspace-device)
(ModuleVersion omegaclaw.device.omega-vm "0.1.0")
(ModuleEntrypoint omegaclaw.device.omega-vm "entry.metta")
(ModuleOptional omegaclaw.device.omega-vm True)
(ModuleDefaultEnabled omegaclaw.device.omega-vm False)
(ModuleImplementation omegaclaw.device.omega-vm qemu-membrane)

(WorkspaceDevice omega-vm)
(Simulation omega-vm)
(Provides omegaclaw.device.omega-vm (Skill vm-status))
(Provides omegaclaw.device.omega-vm (Skill vm-boot))
(Provides omegaclaw.device.omega-vm (Skill vm-shell))
(Provides omegaclaw.device.omega-vm (Skill vm-last-trace))

(WorkspaceDeviceCapability omega-vm tiny-linux-boot)
(WorkspaceDeviceCapability omega-vm shell-command)
(WorkspaceDeviceCapability omega-vm no-network-default)
(WorkspaceDeviceCapability omega-vm ephemeral-initramfs)

(RuntimeDependency omegaclaw.device.omega-vm python ">=3.10")
(RuntimeDependency omegaclaw.device.omega-vm qemu-system-aarch64 ">=8")
(RuntimeDependency omegaclaw.device.omega-vm busybox ">=1")

(TraceWrites omegaclaw.device.omega-vm OmegaVMBooted)
(TraceWrites omegaclaw.device.omega-vm OmegaVMCommandRan)

!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/omega_vm/src/omega_vm.py))))
!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/omega_vm/catalog.metta))))
!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/omega_vm/affordance.metta))))
!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/omega_vm/signatures.metta))))
!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/omega_vm/skills.metta))))
