; Optional attention / ECAN-lite immune organ.

!(import! &self (car-atom (collapse (library OmegaClaw-Core ./src/attention_ledger.py))))
!(import! &self (car-atom (collapse (library OmegaClaw-Core ./src/skill_catalog_attention.metta))))
!(import! &self (car-atom (collapse (library OmegaClaw-Core ./src/skill_affordance_attention.metta))))
!(import! &self (car-atom (collapse (library OmegaClaw-Core ./src/skills_attention.metta))))
!(bind! &attention (new-space))
!(import! &self (car-atom (collapse (library OmegaClaw-Core ./src/attention_spin.metta))))
!(register-space "attention" &attention immune)
!(register-space-alias attention "attention")
!(register-space-persistence "attention" (memory-file "attention.metta") runtime-state)
!(attention-spin-init)

; Keep this as a symbolic runtime-hook atom. Registering through eval would
; evaluate the observer once and store a stale result instead of the live call.
(RuntimeHook response spin-counter (attention-observe-response (get-state &lastResponseMsgNew) (get-state &lastResponseSexpr)))
(TrustedRuntimeHook response spin-counter)
