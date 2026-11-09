/**
 * Whether RestScreen's idle check (a 5 s interval) runs: only while awake. At rest, this screen's own or a phased
 * experience's (shell/restNotices restHolds), the minute clock is the only timer.
 */
export const idleCheckRuns = (o: { allowed: boolean; minutes: number; resting: boolean; phaseRest: boolean }): boolean =>
  o.allowed && o.minutes > 0 && !o.resting && !o.phaseRest
