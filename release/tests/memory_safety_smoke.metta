; Boots the real runtime, overfills &world, bounds it and saves it.
; tests/test_memory_safety.py checks that protected atoms survive bounding,
; every dropped atom has a receipt, and the save is atomic.

!(import! &self (library lib_import))
!(git-import! "https://github.com/asi-alliance/OmegaClaw-Core.git")
!(import! &self (library OmegaClaw-Core lib_omegaclaw))

!(initLoop)
!(println! (initMemory))
!(add-atom &world (Filler one "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))
!(add-atom &world (Filler two "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"))
!(add-atom &world (Filler three "cccccccccccccccccccccccccccccccccccccccc"))
!(add-atom &world (Identity name "Safety"))
!(add-atom &world (Pin core-fact "kept"))
!(bound-space! &world 60)
!(println! (REMAINING (collapse (get-atoms &world))))
!(println! (save-runtime-space "world"))
!(println! (MEMORY-FILE (memory-file "world.metta")))
