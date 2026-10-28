/**
 * A count with its noun: "1 mind", "3 minds", "0 minds". The one plural helper for shown counts (no "1 minds").
 * `many` is for nouns that do not just take an s ("person", "people"; "mind needs you", "minds need you").
 */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/**
 * The same, for a count that may be only a floor while a read is still partial ("3+", as `atLeast` says it): "1 task",
 * "2 tasks", "1+ tasks" (a floor of one may be more, so it takes the plural).
 */
export const pluralAtLeast = (n: number, partial: boolean, one: string, many = `${one}s`): string => `${partial ? `${n}+` : n} ${n === 1 && !partial ? one : many}`
