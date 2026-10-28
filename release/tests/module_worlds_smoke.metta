; Isolated smoke for large modules: operating surfaces and simulations.
; This proves the same module atom contract can represent a whole UI world or
; game world, not only a small callable skill.

!(import! &self ./repos/OmegaClaw-Core/tests/fixtures/modules/omega_os_surface/entry.metta)
!(import! &self ./repos/OmegaClaw-Core/tests/fixtures/modules/metta_maze_game/entry.metta)

!(println! MODULE-WORLDS-KINDS)
!(println! (collapse (match &self (ModuleKind $module $kind)
                           (Kind $module $kind))))

!(println! MODULE-WORLDS-SURFACES)
!(println! (collapse (match &self (Provides $module (Surface $surface))
                           (SurfaceProvider $module $surface))))

!(println! MODULE-WORLDS-SIMULATIONS)
!(println! (collapse (match &self (Provides $module (Simulation $simulation))
                           (SimulationProvider $module $simulation))))

!(println! MODULE-WORLDS-AFFORDANCES)
!(println! (collapse (match &self (Provides $module (Skill $skill))
                           (Affordance $module $skill))))

!(println! MODULE-WORLDS-CAPABILITIES)
!(println! (collapse (superpose
   ((match &self (SurfaceCapability $thing $capability) (Capability $thing $capability))
    (match &self (SimulationCapability $thing $capability) (Capability $thing $capability))))))

!(println! MODULE-WORLDS-TRACE)
!(println! (collapse (match &self (TraceWrites $module $event)
                           (Trace $module $event))))
