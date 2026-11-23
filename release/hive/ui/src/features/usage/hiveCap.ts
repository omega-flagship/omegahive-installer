// Purpose: the hive cap, the one limit that holds what a mind with no cap of its own spends: the hive's month rule,
// else its day rule, as the hive's own Budgets.hive_cap reads them (hive/core/budgets.py). A hive rule of
// another period, a total, holds no such mind, since Budgets.paid_without_cap admits its calls only under the hive cap.
// Any line with a scope and a period will do (the store's lines from GET /api/budgets, which are the stored rules, or
// the Limits rows).

export function hiveCap<T extends { scope: string; period: string }>(budgets: readonly T[]): T | null {
  return budgets.find((b) => b.scope === 'hive' && b.period === 'month')
    ?? budgets.find((b) => b.scope === 'hive' && b.period === 'day') ?? null
}
