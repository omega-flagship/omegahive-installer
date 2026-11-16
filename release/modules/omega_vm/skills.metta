(= (vm-status)
   (py-call (omega_vm.vm_status)))

(= (vm-boot)
   (py-call (omega_vm.vm_boot)))

(= (vm-shell $command)
   (py-call (omega_vm.vm_shell $command)))

(= (vm-last-trace)
   (py-call (omega_vm.vm_last_trace)))
