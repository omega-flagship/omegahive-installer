/**
 * Every capability row of the classic UI audit (CLASSIC_UI_AUDIT_20261005.md, rows 1–49) and the
 * registry features that carry it, so a capability cannot silently fall out of the registry (Review B2). Rows that are
 * not person-facing say so explicitly.
 */
export const AUDIT_ROWS: Record<number, string[] | 'not-person-facing'> = {
  1: ['minds.see', 'minds.create', 'minds.wake', 'minds.traces'],
  2: ['minds.create'],
  3: ['minds.outside'],
  4: ['swarms.see', 'swarms.launch', 'swarms.beliefs', 'swarms.edit', 'swarms.archived'],
  5: ['swarms.nesting'],
  6: ['swarms.beliefs'],
  7: ['swarms.vocabulary'],
  8: ['work.goals', 'work.review', 'work.motivations'],
  // Boards became a view of Tasks (Motivations above Tasks)
  9: ['work.goals'],
  10: ['decide.approvals', 'decide.rules', 'decide.history'],
  11: ['decide.asks'],
  12: ['talk.rooms'],
  13: ['work.sessions'],
  14: ['people.manage'],
  15: ['build.roles'],
  16: ['build.models'],
  17: ['money.keys'],
  18: ['money.usage'],
  19: ['money.usage'],
  20: ['decide.reservations'],
  21: ['apps.list', 'apps.open'],
  22: ['apps.open'],
  23: ['apps.activity'],
  24: ['work.artifacts'],
  25: ['work.assets'],
  26: ['build.code'],
  27: ['apps.activity'],
  28: ['build.evolve'],
  29: ['watch.lab'],
  30: ['watch.health'],
  31: ['watch.healthmind'],
  32: ['minds.inventory'],
  33: ['build.updates'],
  34: ['work.explore'],
  35: ['swarms.connections', 'swarms.requests'],
  36: ['swarms.services'],
  37: ['minds.shares'],
  38: ['minds.move'],
  39: ['minds.schedule'],
  40: ['minds.memory'],
  41: ['swarms.lifecycle'],
  42: ['work.flow'],
  43: ['hive.settings', 'hive.identity'],
  44: ['decide.stopall'],
  45: ['hive.changeui'],
  46: ['watch.activity'],
  47: 'not-person-facing',
  48: ['hive.search'],
  49: ['hive.help', 'hive.setup'],
}

/**
 * Audit rows the classic UI now closes (Surface request K, 2026-10-05: the classic P1s). `waitsOn` names a Platform
 * field the UI already reads when present and degrades without: until it ships, that part says less, never guesses.
 */
export interface Closed {
  by: string
  what: string
  waitsOn?: string
}
export const AUDIT_CLOSED: Record<number, Closed> = {
  4: { by: 'request K', what: 'Archived swarms listed (GET /api/swarms?archived=1) with Restore, so it survives a reload; edit, archive and delete were already there' },
  5: { by: 'request K (verified; built earlier)', what: 'Nesting set from swarm settings (holon parent, depth refusal shown)' },
  8: { by: 'request K', what: 'Awaiting review column, "Reviewed by" on done cards, review history, accept/return in a decision dialog', waitsOn: 'review_by on goal list rows and goal.updated (who may review)' },
  20: { by: 'request K', what: 'Calls to settle with held time and auto-settle time, Settle where resolvable, Usage badge', waitsOn: 'dispatched_at, unknown_at, resolvable, auto_settles_at on reservation rows' },
  32: { by: 'request K (verified; built earlier)', what: 'Tools (inventory, activity, per-mind health) in the mind panel: verified complete' },
  33: { by: 'request K', what: 'Place a hold (restart, everything, one app) with a validated end, lift a hold, in decision dialogs' },
  36: { by: 'request K (verified; built earlier)', what: 'Services a swarm offers, set from the swarm page' },
  37: { by: 'request K', what: 'Sharing in the Memory tab with reads and revoke; who revoked; 404 shown as not visible to you', waitsOn: 'R13 visibility on /api/shares* and revoked_by' },
  38: { by: 'request K (verified; built earlier)', what: 'Export, import, settle, moves and convert-native: verified complete' },
  43: { by: 'request K', what: 'Name this hive (PATCH /api/hive/identity), admins, with confirmation' },
  48: { by: 'request K', what: 'Palette navigation built from NAV_ITEMS (every destination, the nav’s own names)' },
  49: { by: 'request K', what: 'First-run checklist from existing reads; admin-only invite step; dismissed per person' },
}
