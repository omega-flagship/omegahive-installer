import type { FormActResult } from '../contract'

/** The canvas's words, in one place (plain, short, one sentence where a sentence will do). */

export const EMPTY_TITLE = 'What would you like to make?'
export const EMPTY_BODY = 'Say it in the Ask below, or start from one of these: it fills the Ask for you to change, and nothing is sent until you send it.'

/** Three starting points. Each only fills the Ask with editable words (j0-fixes r1); nothing is sent or made until the person sends it. */
export const SUGGESTIONS: { label: string; ask: string }[] = [
  { label: 'A poster for a neighbourhood event', ask: 'Make a poster inviting neighbours to a small community event' },
  { label: 'A warm invitation card', ask: 'Make a warm, friendly invitation card' },
  { label: 'A bold announcement for the hive', ask: 'Make a bold one-line announcement poster for our swarm' },
]

export const MODES = [
  { id: 'make', label: 'Make', hint: 'Shape the design' },
  { id: 'compare', label: 'Compare', hint: 'See the directions side by side' },
  { id: 'deliver', label: 'Deliver', hint: 'Keep it in the hive or take a picture of it' },
] as const
export type Mode = (typeof MODES)[number]['id']

/** A Save refused because Studio (Design) is not switched on in this swarm: nothing was kept or sent. */
export const STUDIO_OFF_HERE = 'Studio isn’t switched on in this swarm, so nothing was kept and nothing was sent. Your changes are still here. An admin can switch it on: Ω → Where it runs…'

/** One plain sentence for a save that did not go through, with what to do next. Never "nothing changed" for unknown. */
export function saveSentence(r: FormActResult): { text: string; tone: 'ok' | 'warn' | 'error' } {
  if (r.unknown) return { text: 'The hive did not say whether this version was kept. Check the version list before keeping it again.', tone: 'warn' }
  if (r.status === 'done') return { text: 'Kept in the hive.', tone: 'ok' }
  // the hive refused before anything was sent: Studio is not switched on in this swarm (demo D3; host app_inactive)
  if (r.code === 'app_inactive') return { text: STUDIO_OFF_HERE, tone: 'warn' }
  const m = (r.message ?? '').toLowerCase()
  if (/person|named|sign/.test(m)) return { text: 'Keeping a version needs a signed-in person. Sign in, then keep it again.', tone: 'error' }
  if (/stale|revision|retain/.test(m) || r.status === 'stale') return { text: 'The design moved on in the hive since you opened it. Open the latest, then make your change again.', tone: 'error' }
  if (/cancel|declin|not now/.test(m)) return { text: 'Not kept. Your changes are still here.', tone: 'warn' }
  return { text: `Design did not keep it${r.message ? `: ${r.message.replace(/\.$/, '')}` : ''}. Your changes are still here.`, tone: 'error' }
}

export const LOAD_ERROR = 'This design could not be opened.'
export const DECK_NOTE = 'This is a slide deck. The living canvas draws single designs for now; the Studio opens decks.'

/** Design's disposition: the picture is the canvas's mirror of Design's drawing, not Design's verified export. */
export const PICTURE_ACTION = 'Save a picture (SVG, unverified mirror)'
export const DELIVER_NOTE = 'Keeping and saving each ask you to confirm first. The picture is the canvas’s mirror of Design’s drawing; Design has not verified it. Sharing goes through the Ask, so you see who it would reach before anything is sent.'
