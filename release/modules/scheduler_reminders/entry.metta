; omegaclaw.time.scheduler-reminders module.
; MeTTa declares the cognitive surface; Python/JS only execute boundary actions.

(Module omegaclaw.time.scheduler-reminders)
(ModuleKind omegaclaw.time.scheduler-reminders time-organ)
(ModuleVersion omegaclaw.time.scheduler-reminders "0.1.0")
(ModuleEntrypoint omegaclaw.time.scheduler-reminders "entry.metta")
(ModuleOptional omegaclaw.time.scheduler-reminders True)
(ModuleDefaultEnabled omegaclaw.time.scheduler-reminders True)
(ModuleImplementation omegaclaw.time.scheduler-reminders metta-reminder-space)


(Space reminders)
(RuntimeOrgan scheduler-reminders)
(Provides omegaclaw.time.scheduler-reminders (Space reminders))
(Provides omegaclaw.time.scheduler-reminders (RuntimeOrgan scheduler-reminders))
(Provides omegaclaw.time.scheduler-reminders (Skill reminder-add))
(Provides omegaclaw.time.scheduler-reminders (Skill reminder-list))
(Provides omegaclaw.time.scheduler-reminders (Skill reminder-cancel))
(Provides omegaclaw.time.scheduler-reminders (Skill reminder-due))

(OrganPrinciple omegaclaw.time.scheduler-reminders "Reminders surface time facts and continuity hints; they do not choose goals.")

(RuntimeDependency omegaclaw.time.scheduler-reminders python ">=3.10")

(TraceWrites omegaclaw.time.scheduler-reminders ReminderAdded)
(TraceWrites omegaclaw.time.scheduler-reminders ReminderCancelled)
(TraceWrites omegaclaw.time.scheduler-reminders ReminderDueObserved)

!(import! &self (library OmegaClaw-Core ./modules/scheduler_reminders/catalog.metta))
!(import! &self (library OmegaClaw-Core ./modules/scheduler_reminders/affordance.metta))
!(import! &self (library OmegaClaw-Core ./modules/scheduler_reminders/signatures.metta))
!(import! &self (library OmegaClaw-Core ./modules/scheduler_reminders/skills.metta))
