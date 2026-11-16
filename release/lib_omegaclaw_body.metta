; Optional body/device/channel organs for a situated OmegaClaw instance.
;
; Optional capabilities are loaded through modules/loader.metta. This file remains
; as the run composition hook for situated deployments, without owning organs
; directly or duplicating module imports.

!(import! &self (library OmegaClaw-Core ./modules/loader.metta))
