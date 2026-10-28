/**
 * lab-figures r1 (hive/API.md "Figures on recorded research reports"): the only route the UI reads figure bytes
 * from. Host-relative, naming one figure by its sha256, with no query or fragment: the session goes in the
 * Authorization header, never in a URL.
 */
export const FIGURE_READ_ROUTE = /^\/api\/evolve\/swarms\/[^/?#\s]+\/records\/[^/?#\s]+\/figures\/([0-9a-f]{64})$/

/** The sha256 a figure read route names, or null when it is not one. */
export function figureRouteSha(url: string): string | null {
  return FIGURE_READ_ROUTE.exec(url)?.[1] ?? null
}
