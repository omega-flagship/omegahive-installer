/**
 * A link that asks for an app's graph view (`?view=graph`, the guided tour) while the page is open (stand-in r1 P1):
 * the same guard as the View menu. With unsaved edits the person is asked first; if they keep their edits, nothing
 * switches and the route goes back to what it was. Pure and injected, so it is tested.
 * `isDirty` is read when the link is followed, never a value captured earlier (followups-r5: a stale closure could
 * miss edits made after the page last rendered, or ask about edits already saved).
 */
export async function followViewLink(o: { isDirty: () => boolean; confirm: () => Promise<boolean>; apply: () => void; restore: () => void }): Promise<boolean> {
  if (o.isDirty() && !(await o.confirm())) {
    o.restore()
    return false
  }
  o.apply()
  return true
}

/**
 * One unsaved-edits question at a time (followups-r5): a single route event that changes both `?source` and
 * `?view=graph` used to put up two dialogs, the newer cancelling the older (askConfirm keeps one question on screen).
 * Asks made while a question is open share its answer; once it is answered, the next ask asks again.
 */
export function oneQuestion(): (ask: () => Promise<boolean>) => Promise<boolean> {
  let open: Promise<boolean> | null = null
  return (ask) => {
    if (open) return open
    const p: Promise<boolean> = ask().finally(() => { if (open === p) open = null })
    open = p
    return p
  }
}

/**
 * The question both route guards share (followups-r6, Kimi r5 #4): one route event can open another creation AND switch
 * to the graph view, and whichever guard asks first, its words are the ones shown, so they name both.
 */
export const DISCARD_QUESTION = 'This design has unsaved edits. Opening another creation or switching the view discards them.'
export const DISCARD_LABEL = 'Discard and continue'
