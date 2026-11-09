export interface EmbeddedDepartureHandle { current: ((leave: () => void) => void) | null }

/** Draft-only UI policy. The caller supplies the real current controller state; this conveys no grant. */
export interface EmbeddedDraftSnapshot { path: string | null; text: string; dirty: boolean }

/** A late OK cannot discard a changed draft or call a departed bench's navigation. */
export async function confirmEmbeddedDeparture(
  read: () => EmbeddedDraftSnapshot,
  current: () => boolean,
  confirm: () => Promise<boolean>,
  leave: () => void,
): Promise<boolean> {
  if (!current()) return false
  const before = read()
  if (before.dirty && !(await confirm())) return false
  if (!current()) return false
  const after = read()
  if (before !== after || before.path !== after.path || before.text !== after.text || before.dirty !== after.dirty) return false
  leave()
  return true
}
