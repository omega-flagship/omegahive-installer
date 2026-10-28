/** The swarm settings' coordinator picker (SwarmSettings), which the Ask's "Set a coordinator for <swarm>" focuses. */
export const COORDINATOR_PICKER = 'swarm-coordinator-picker'

/** Open a swarm's settings and put focus on its coordinator picker once it is on screen (gives up after ~3 s). */
export function focusCoordinatorPicker(doc: Pick<Document, 'getElementById'> = document, tries = 30, every = 100): void {
  const el = doc.getElementById(COORDINATOR_PICKER) as HTMLElement | null
  if (el) {
    el.focus()
    el.scrollIntoView?.({ block: 'center' })
    return
  }
  if (tries > 0) setTimeout(() => focusCoordinatorPicker(doc, tries - 1, every), every)
}
