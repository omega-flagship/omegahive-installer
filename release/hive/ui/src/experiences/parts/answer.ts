/**
 * The Ask's read-only answers about the UI's named parts (lib/intent/uiParts), in plain words with each part's atom
 * name, read from the real MeTTa parts space (./space). Lists and explains; changes nothing.
 */
import { roleOf, type PartsAct } from '../../lib/intent/uiParts'
import { partName, partsSpace, type Explained, type PartId, type UiPartsSpace } from './space'

export interface Here {
  /** the experience in front (registry id) */
  look: string
  /** its name, as the gallery says it */
  lookName: string
  /** the shell's state when the experience is phased; null when it is not (then its parts in every state count) */
  state: 'rest' | 'awake' | 'pro' | null
}

const STATE_WORDS: Record<string, string> = { rest: 'at rest', awake: 'awake', pro: 'in Pro', any: 'in every state' }
const words = (p: PartId) => p.name.replace(/-/g, ' ')
const where = (h: Here) => (h.state ? `${h.lookName}, ${STATE_WORDS[h.state]}` : h.lookName)
const join = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)
const FROM = 'Read from the parts space (real MeTTa atoms: lib_ui over the shell’s and registered looks’ parts). Nothing changed.'

function drawnBy(e: Explained): string {
  return e.impls.length ? `drawn by ${join(e.impls.map((i) => `${i.library} ${i.component}`))}` : 'with nothing registered to draw it'
}

function explainLine(e: Explained): string {
  const p = e.part
  const bits = [`${words(p)} (${p.look}, ${STATE_WORDS[p.state] ?? p.state}) is ${partName(p)}`]
  if (e.roles.length) bits.push(`it plays ${join(e.roles)}`)
  bits.push(drawnBy(e))
  if (e.owners.length) bits.push(`owned by ${join(e.owners.map(partName))}`)
  if (e.slots.length) bits.push(`customisable: ${join(e.slots)}`)
  if (e.history.length) bits.push(`history: ${e.history.map((h) => `${h.what} in ${h.round} (${h.when})`).join('; ')}`)
  if (e.counterparts.length) bits.push(`linked to ${join(e.counterparts.map(partName))}`)
  return `${bits.join('; ')}.${e.doc ? ` ${e.doc}` : ''}`
}

/** The answer to one parts act, as the Ask says it. */
export function answerParts(act: PartsAct, here: Here, s: UiPartsSpace = partsSpace()): string {
  const own = s.list(here.look)
  if (act.op === 'role' && act.anywhere) {
    const ps = s.playing(act.role, null)
    if (!ps.length) return `Nothing plays the ${act.role} role in any look yet. ${FROM}`
    return `The ${act.role} role, in every look: ${ps.map((p) => `${words(p)} (${p.look}, ${STATE_WORDS[p.state] ?? p.state}) ${partName(p)}`).join('; ')}. ${FROM}`
  }
  if (!own.length) {
    const roles = s.sharedRoles()
    return `${here.lookName} has no named parts yet. Shared roles: ${join(roles)}. ${FROM}`
  }
  if (act.op === 'list') {
    const ps = here.state ? s.onScreen(here.look, here.state) : own
    const lines = ps.map((p) => {
      const e = s.explain(p)
      return `${words(p)} ${partName(p)}${e.roles.length ? ` plays ${join(e.roles)}` : ''}, ${drawnBy(e)}`
    })
    return `${where(here)}: ${ps.length} named part${ps.length === 1 ? '' : 's'}. ${lines.join('; ')}. ${FROM}`
  }
  if (act.op === 'role') {
    const ps = here.state ? s.playing(act.role, here.look, here.state) : s.playing(act.role, here.look)
    // the shell's own parts play their roles in every look (the one Ask)
    const shell = here.state ? s.onScreen(here.look, here.state).filter((p) => p.look === 'shell' && s.explain(p).roles.includes(act.role)) : []
    const all = [...ps, ...shell]
    if (!all.length) {
      const elsewhere = s.playing(act.role, here.look)
      return `Nothing plays the ${act.role} role ${here.state ? STATE_WORDS[here.state] : 'here'} in ${here.lookName}.${elsewhere.length ? ` In ${here.lookName} it is played ${elsewhere.map((p) => `${STATE_WORDS[p.state] ?? p.state} by ${words(p)} ${partName(p)}`).join('; ')}.` : ''} ${FROM}`
    }
    return `${where(here)}: the ${act.role} role is played by ${all.map((p) => explainLine(s.explain(p))).join(' ')} ${FROM}`
  }
  // explain: a part's own name here, else the parts playing a role of that name here
  const name = act.name.replace(/\s+/g, '-').replace(/^omega$/, 'ω')
  const byName = own.filter((p) => p.name === name && (!here.state || p.state === here.state))
  const named = byName.length ? byName : own.filter((p) => p.name === name)
  const role = named.length ? null : roleOf(act.name)
  const byRole = role ? s.playing(role, here.look, here.state) : []
  const ps = named.length ? named : byRole
  if (!ps.length) return `${here.lookName} has no part called “${act.name}”. Ask “list the parts” to see them. ${FROM}`
  return `${ps.map((p) => explainLine(s.explain(p))).join(' ')} ${FROM}`
}
