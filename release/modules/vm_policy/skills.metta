(= (initVMPolicyOrgan)
   (VMPolicyOrganReady (vm-policy-status)))

(= (vm-policy-status)
   (py-call (vm_policy.vm_policy_status)))

(= (vm-policy-exits)
   (py-call (vm_policy.vm_policy_exits)))

(= (vm-policy-atoms)
   (py-call (vm_policy.vm_policy_atoms)))

(= (vm-policy-connections)
   (py-call (vm_policy.vm_policy_connections)))

(= (vm-policy-metrics)
   (py-call (vm_policy.vm_policy_metrics)))

(= (vm-policy-audit)
   (py-call (vm_policy.vm_policy_audit)))

(= (vm-policy-enforcement-plan)
   (py-call (vm_policy.vm_policy_enforcement_plan)))

(= (vm-policy-maintenance-window $service $reason_and_duration)
   (py-call (vm_policy.vm_policy_maintenance_window $service $reason_and_duration)))

(= (vm-policy-record-exit $service $decision_and_reason)
   (py-call (vm_policy.vm_policy_record_exit $service $decision_and_reason)))

(= (vm-policy-exit-history)
   (py-call (vm_policy.vm_policy_exit_history)))

(= (vm-policy-exit-summary)
   (py-call (vm_policy.vm_policy_exit_summary)))

(= (vm-policy-last-trace)
   (py-call (vm_policy.vm_policy_last_trace)))
