; Optional Home Assistant body app.
;
; Enable by importing this file from modules/loader.metta:
; !(import! &self (library OmegaClaw-Core ./modules/home_assistant/entry.metta))

(Module omegaclaw.app.home-assistant)
(ModuleKind omegaclaw.app.home-assistant body-app)
(ModuleVersion omegaclaw.app.home-assistant "0.1.0")
(ModuleEntrypoint omegaclaw.app.home-assistant "entry.metta")
(ModuleOptional omegaclaw.app.home-assistant True)
(ModuleDefaultEnabled omegaclaw.app.home-assistant False)
(ModuleImplementation omegaclaw.app.home-assistant home-assistant-rest-api)

(BodyApp home-assistant)
(Provides omegaclaw.app.home-assistant (App home-assistant))
(Provides omegaclaw.app.home-assistant (Sense house-state))
(Provides omegaclaw.app.home-assistant (Affordance house-control))

(OrganPrinciple home-assistant "Home Assistant is a body app for sensing and acting in a physical environment, not cognition.")
(OrganPrinciple home-assistant "Action summaries returned to the loop stay compact; full traces remain inspectable in runtime memory.")
(OrganPrinciple home-assistant "The agent should sense, reason, act, verify, and remember; this module does not automate choices.")

(RuntimeDependency omegaclaw.app.home-assistant python ">=3.10")
(RuntimeDependency omegaclaw.app.home-assistant home-assistant "long-lived-access-token")
(RuntimeConfig omegaclaw.app.home-assistant HOME_ASSISTANT_URL "deployment-local")
(RuntimeConfig omegaclaw.app.home-assistant HOME_ASSISTANT_TOKEN "runtime-secret")
(RuntimeConfig omegaclaw.app.home-assistant OMEGACLAW_HA_TRACE "optional-default-off")

(TraceAvailable omegaclaw.app.home-assistant HouseObservation)
(TraceWrites omegaclaw.app.home-assistant HouseObservation)
(TraceAvailable omegaclaw.app.home-assistant HouseActionTrace)
(TraceWrites omegaclaw.app.home-assistant HouseActionTrace)
(TraceAvailable omegaclaw.app.home-assistant HouseOutcomeTrace)
(TraceWrites omegaclaw.app.home-assistant HouseOutcomeTrace)

!(import! &self (library OmegaClaw-Core ./modules/home_assistant/catalog.metta))
!(import! &self (library OmegaClaw-Core ./modules/home_assistant/affordance.metta))
!(import! &self (library OmegaClaw-Core ./modules/home_assistant/signatures.metta))
!(import! &self (library OmegaClaw-Core ./modules/home_assistant/skills.metta))
!(import! &self (car-atom (collapse (library OmegaClaw-Core ./modules/home_assistant/bridge/home_assistant.py))))
