// Purpose: the screens a person visited in this tab, by name only (never anything they typed), which a bug report
// offers as its steps to reproduce for the person to edit, and the page a report names with every id left out.
import { onIdentityChange } from '../../lib/identityEpoch'
import { routeOf } from '../../lib/recentErrors'
import { parse } from '../../lib/router'

/** How many screens the steps start from: enough to show the way to a bug, few enough to read at a glance. */
export const KEEP_SCREENS = 8

let screens: readonly string[] = []

/** A screen by its name and tab ("dot · chat"), from the address; nothing that names a thing. */
export function screenName(hash: string): string {
  const r = parse(hash)
  const tab = 'tab' in r && typeof r.tab === 'string' ? ` · ${r.tab}` : ''
  return `${r.name}${tab}`
}

/** The page as a report names it: its screen and its address with every id left out ("dot · chat (#/dot/:id/chat)"). */
export const pageOf = (hash: string): string => `${screenName(hash)} (#${routeOf(hash.replace(/^#/, '') || '/')})`

/** Note a screen; the same screen twice in a row is one step. */
export function noteScreen(hash: string): void {
  const name = screenName(hash)
  if (screens[screens.length - 1] === name) return
  screens = [...screens, name].slice(-KEEP_SCREENS)
}

export const screensVisited = (): readonly string[] => screens

/** The steps a bug report starts from: one numbered line per screen, for the person to finish. "" with none. */
export const stepsOf = (visited: readonly string[]): string => visited.map((s, i) => `${i + 1}. Opened ${s}`).join('\n')

onIdentityChange(() => {
  screens = []
})

/** Follow the address from now on (the screen showing now counts). Returns the undo. */
export function watchScreens(target: Window = window): () => void {
  const note = () => noteScreen(target.location.hash)
  note()
  target.addEventListener('hashchange', note)
  return () => target.removeEventListener('hashchange', note)
}
