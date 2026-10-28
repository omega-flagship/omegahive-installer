/** Names shown in the UI drop an implicit "Omega" prefix: OmegaDesign shows as Design (the owner, 2026-10-04).
 *  Display only: ids and stored names never change, and edit fields keep the real name.
 *  Product names stay whole, and a bare "Omega" (or Omega followed by a space) is left alone. */
const KEEP = new Set(['OmegaHive', 'OmegaClaw', 'OmegaClaws'])

export function shown(name: string | null | undefined): string {
  if (!name) return name ?? ''
  return name.replace(/(^|[\s(/·-])Omega(?=[A-Z][a-z])([A-Za-z]+)/g, (whole, lead: string, rest: string) =>
    KEEP.has('Omega' + rest) ? whole : lead + rest)
}
