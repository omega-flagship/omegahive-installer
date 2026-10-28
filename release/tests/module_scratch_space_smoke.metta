!(import! &self (library lib_import))
!(git-import! "https://github.com/asi-alliance/OmegaClaw-Core.git")
!(import! &self (library OmegaClaw-Core ./src/helper.py))
!(import! &self (library OmegaClaw-Core ./src/skills_memory.metta))
!(import! &self (library OmegaClaw-Core ./src/skills_reasoning_spaces.metta))
!(import! &self (library OmegaClaw-Core modules/scratch_space/entry.metta))

!(change-state! &maxScratchAtomsChars 20000)

!(println! SCRATCH-MODULE-META)
!(println! (match &self (Provides omegaclaw.memory.scratch-space $thing) $thing))
!(println! (eval (runtime-hooks)))
!(println! (eval (run-runtime-hooks cycle)))

!(println! SCRATCH-HOOK-TRUST)
!(println! (eval (runtime-hook-trusted cycle scratch-space)))
!(println! (eval (register-runtime-hook cycle rogue-hook (scratch-gc))))
!(println! (eval (run-runtime-hooks cycle)))

!(println! SCRATCH-ADD)
!(println! (eval (scratch-add (ScratchDraft syntax-test colon-safe "works") 2)))

!(println! SCRATCH-FIND)
!(println! (eval (scratch-find (ScratchDraft syntax-test $kind $value))))

!(println! SCRATCH-TOUCH)
!(println! (eval (scratch-touch (ScratchDraft syntax-test colon-safe "works"))))

!(println! SCRATCH-WITH-TTL)
!(println! (eval (scratch-all-with-ttl)))

!(println! SCRATCH-GC-1)
!(println! (eval (scratch-gc)))
!(println! (eval (scratch-all-with-ttl)))

!(println! SCRATCH-PROMOTE)
!(println! (eval (scratch-promote (ScratchDraft syntax-test colon-safe "works") "verified by smoke")))

!(if (== (collapse (match &scratch (ScratchDraft syntax-test colon-safe "works")
                          (ScratchDraft syntax-test colon-safe "works"))) ())
    (println! SCRATCH-SMOKE-PASS)
    (println! FAILED-SCRATCH-SMOKE-COUNT))

!(if (== (collapse (match &beliefs (ScratchDraft syntax-test colon-safe "works")
                          (ScratchDraft syntax-test colon-safe "works"))) ())
    (println! FAILED-SCRATCH-PROMOTION)
    (println! SCRATCH-PROMOTION-PASS))
