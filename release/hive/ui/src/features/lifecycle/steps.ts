/** Where a person is in Lifecycle setup, and what the next step needs. Pure, so the rules are testable. */
export type LeaseStep = 'needs-coordinator' | 'needs-delegation' | 'needs-member' | 'needs-task' | 'ready'

export function leaseStep(s: { coordinator: string; delegated: string[]; member: string; openTasks: number; task: string }): LeaseStep {
  if (!s.coordinator) return 'needs-coordinator'
  if (!s.delegated.length) return 'needs-delegation'
  if (!s.member) return 'needs-member'
  if (!s.openTasks || !s.task) return 'needs-task'
  return 'ready'
}

export const LEASE_HINT: Record<Exclude<LeaseStep, 'ready'>, string> = {
  'needs-coordinator': 'Needs step 1: choose a coordinator and the members it may run.',
  'needs-delegation': 'Needs step 1: tick at least one member and apply the delegation.',
  'needs-member': 'Choose the member this run is for.',
  'needs-task': 'Choose an open task assigned to this member, or create one.',
}

/** Skills still to allow for a coordinator: none to show until a coordinator is chosen. */
export function missingSkills(coordinator: string, required: string[], allowed: (skill: string) => boolean): string[] {
  return coordinator ? required.filter((s) => !allowed(s)) : []
}
