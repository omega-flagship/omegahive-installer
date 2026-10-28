; Boots the real runtime and writes a marker into &world.  Run it twice with
; different OMEGACLAW_MEMORY_DIR values (tests/test_multi_instance_memory.py)
; to check that two agents from one checkout keep separate memory.

!(import! &self (library lib_import))
!(git-import! "https://github.com/asi-alliance/OmegaClaw-Core.git")
!(import! &self (library OmegaClaw-Core lib_omegaclaw))

!(initLoop)
!(println! (initMemory))
; Markers loaded from a previous boot of this same instance.
!(println! (LOADED-MARKERS (collapse (match &world (InstanceMarker $m) $m))))
!(let $id (getenv "HIVE_INSTANCE_ID")
      (add-atom &world (InstanceMarker $id)))
!(println! (save-runtime-space "world"))
!(println! (MEMORY-FILE (memory-file "world.metta")))
