; Standard OmegaClaw composition.
;
; Keep this ordered: core substrate first, modules second, attention third,
; loop last. PeTTa compiles function calls at import time, so loading the loop
; before module-provided affordances makes calls such as initChannels/receive
; compile as inert literals.

!(import! &self (car-atom (collapse (library OmegaClaw-Core lib_omegaclaw_core))))
!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/loader.metta))))
!(import! &self (car-atom (collapse (library OmegaClaw-Core lib_omegaclaw_attention))))
!(import! &self (car-atom (collapse (library OmegaClaw-Core ./src/loop))))
