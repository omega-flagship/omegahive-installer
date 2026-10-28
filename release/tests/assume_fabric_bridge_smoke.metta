!(import! &self (library lib_import))
!(git-import! "https://github.com/asi-alliance/OmegaClaw-Core.git")
!(import! &self (library OmegaClaw-Core lib_omegaclaw))

; Assume fabric-boundary smoke test.
; AtomSpace keeps meaning; py-call runs the replaceable dynamics backend.
; This is not exposed as a live the agent skill yet.

!(println! (ASSUME-DENSE-BRIDGE (py-call (assume.house_control_demo))))
!(println! (ASSUME-FABRICPC-BRIDGE (py-call (assume.house_control_fabricpc_demo))))
