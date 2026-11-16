; Skill implementation loader.
;
; The advertised command catalog lives in ./hive/runtime/extensions/skill_catalog.metta.
; This facade preserves the historical hive/runtime/extensions/skills.metta import while keeping
; organs reviewable by cognitive/body boundary.

!(import! &self (library OmegaClaw-Core ./hive/runtime/extensions/skills_core.metta))
!(import! &self (library OmegaClaw-Core ./hive/runtime/extensions/skills_runtime_spaces.metta))
!(import! &self (library OmegaClaw-Core ./hive/runtime/extensions/skills_memory.metta))
!(import! &self (library OmegaClaw-Core ./hive/runtime/extensions/skills_space_mutation.metta))
!(import! &self (library OmegaClaw-Core ./hive/runtime/extensions/skills_affordance.metta))
!(import! &self (library OmegaClaw-Core ./hive/runtime/extensions/skill_affordance_core.metta))
!(import! &self (library OmegaClaw-Core ./hive/runtime/extensions/skill_affordance_memory.metta))
!(import! &self (library OmegaClaw-Core ./hive/runtime/extensions/skill_affordance_reasoning.metta))
!(import! &self (library OmegaClaw-Core ./hive/runtime/extensions/skill_affordance_affordance.metta))
