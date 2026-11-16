// Purpose: one sentence for a limit's spend beside what calls not yet settled hold against it, for every place a limit is shown.
import { money } from '../../lib/format'

/** A limit's spend and what calls not yet settled hold against it (cost_reservations.held_usd), in words: "$1.98 spent",
 *  or "$1.98 spent and $0.60 held for calls not yet settled" when anything is held. An absent or zero held_usd (a hive
 *  that does not report holds, or none held) says nothing about holds. */
export const spentAndHeld = (spent: number, held?: number | null): string =>
  `${money(spent)} spent${held ? ` and ${money(held)} held for calls not yet settled` : ''}`
