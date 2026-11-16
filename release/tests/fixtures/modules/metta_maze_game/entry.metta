; Fixture for a game/simulation module.
; The internals could be pure MeTTa, Godot, Unity, browser canvas, or a remote
; simulation. The symbolic surface is what the agent reasons over.

(Module openclaw.game.metta-maze)
(ModuleKind openclaw.game.metta-maze simulation)
(ModuleVersion openclaw.game.metta-maze "0.1.0")
(ModuleEntrypoint openclaw.game.metta-maze "entry.metta")
(ModuleOptional openclaw.game.metta-maze True)
(ModuleImplementation openclaw.game.metta-maze pure-metta-simulation)

(Simulation metta-maze)
(Provides openclaw.game.metta-maze (Simulation metta-maze))
(Provides openclaw.game.metta-maze (Skill start-game))
(Provides openclaw.game.metta-maze (Skill observe-game-state))
(Provides openclaw.game.metta-maze (Skill act-in-game))

(SimulationCapability metta-maze turn-based)
(SimulationCapability metta-maze state-observable)
(SimulationCapability metta-maze action-feedback)

(RuntimeDependency openclaw.game.metta-maze runtime "any")

(TraceWrites openclaw.game.metta-maze GameStateObserved)
(TraceWrites openclaw.game.metta-maze GameActionTaken)
(TraceWrites openclaw.game.metta-maze SimulationOutcome)
