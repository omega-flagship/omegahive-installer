!(import! &self (library lib_import))
!(git-import! "https://github.com/asi-alliance/OmegaClaw-Core.git")
!(import! &self (library OmegaClaw-Core ./src/skills_reasoning_spaces.metta))
!(import! &self (library OmegaClaw-Core ./src/attention_spin.metta))

!(bind! &attention (new-space))
!(change-state! &spinCounter 0)
!(change-state! &lastResponseMsgNew false)
!(change-state! &lastResponseSexpr ((wait "one")))

!(println! (eval (attention-spin-init)))

(RuntimeHook response spin-counter-test (attention-observe-response (get-state &lastResponseMsgNew) (get-state &lastResponseSexpr)))
(TrustedRuntimeHook response spin-counter-test)

!(println! (eval (runtime-hooks)))
!(println! (eval (run-runtime-hooks response)))

!(if (== (collapse (match &attention (SpinCounter quiet-wait 1 $desc)
                          (SpinCounter quiet-wait 1 $desc))) ())
    (println! FAILED-SPIN-HOOK-WAIT)
    (println! SPIN-HOOK-WAIT-PASS))

!(change-state! &lastResponseSexpr ((agenda-active)))
!(println! (eval (run-runtime-hooks response)))

!(if (== (collapse (match &attention (SpinCounter quiet-wait 0 $desc)
                          (SpinCounter quiet-wait 0 $desc))) ())
    (println! FAILED-SPIN-HOOK-RESET)
    (println! SPIN-HOOK-RESET-PASS))
