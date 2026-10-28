/**
 * Identity helpers for Still, pure so they can be tested without a browser. Names are not identities: two minds
 * can both be called Mira, and a swarm can share a mind's name. Anything consequential is bound to an id, and
 * whenever Still names a target it also says which one (its swarm and a short, stable piece of its id).
 */

/** How names are compared: Unicode-normalised, trimmed, case-insensitive. "Mira", "mira " and "ＭＩＲＡ" are one name. */
export const normName = (s: string) => s.normalize('NFKC').trim().toLowerCase()

const MIN = 6

/**
 * A short id for each of `ids`: the shortest tail (at least six characters) that is unique among them, so two
 * different targets never read the same. Ids shorter than that are shown whole.
 */
export function shortIds(ids: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const uniq = [...new Set(ids)]
  for (const id of uniq) {
    let n = Math.min(MIN, id.length)
    while (n < id.length && uniq.some((o) => o !== id && o.endsWith(id.slice(-n)))) n++
    out.set(id, id.slice(-n))
  }
  return out
}

/** One id on its own (no neighbours to compare with). */
export const shortId = (id: string) => (id.length <= MIN ? id : id.slice(-MIN))
