; omegaclaw.example.hello module: one harmless skill, for learning the module contract.
; It reads nothing, writes nothing and calls no Python. Install it as modules/hello_module/
; (see README.md): the import paths below are written for that location.

(Module omegaclaw.example.hello)
(ModuleKind omegaclaw.example.hello skill)
(ModuleVersion omegaclaw.example.hello "0.1.0")
(ModuleEntrypoint omegaclaw.example.hello "entry.metta")
(ModuleOptional omegaclaw.example.hello True)
(ModuleDefaultEnabled omegaclaw.example.hello False)
(ModuleImplementation omegaclaw.example.hello metta-atomspace)

(Provides omegaclaw.example.hello (Skill hello-greet))

(OrganPrinciple omegaclaw.example.hello "A greeting is returned as text; nothing is stored and nothing leaves the mind.")

!(import! &self (library OmegaClaw-Core ./modules/hello_module/catalog.metta))
!(import! &self (library OmegaClaw-Core ./modules/hello_module/affordance.metta))
!(import! &self (library OmegaClaw-Core ./modules/hello_module/signatures.metta))
!(import! &self (library OmegaClaw-Core ./modules/hello_module/skills.metta))
