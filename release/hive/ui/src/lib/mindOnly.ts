// Purpose: the one rule for which messages a person's page draws: every one but a note the hive sent a mind alone.

/**
 * What a person's page draws of a list of messages: everything but a note the hive sent the mind to instruct it, which
 * the hive marks mind_only (Hive.mind_only: "Assigned to you: ... Read it with hive-goal-get ...", an approval, a notice).
 * The hive decides and marks; the page rewrites nothing and only leaves it out, as it labels a health_check mark (Peter
 * on omegahive#50). The mind keeps the note: this rule is only about what people are shown.
 */
export function forPeople<T extends { mind_only?: boolean }>(items: readonly T[]): T[] {
  return items.filter((x) => !x.mind_only)
}
