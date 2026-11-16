import { E, MeTTa, S, type Atom } from '@mettascript/hyperon'
import { PETTA_STDLIB_SRC } from '@mettascript/core'
import { toVal, type Val } from '../lib/mindSpace/atoms'
import intents from './intents.metta?raw'

/** The same read-only phrase query serves native homes and the separately gated parts inspector. */
export function readIntentPhrase(query: (head: string, ...args: Atom[]) => Val, look: string, intent: string): string | null {
  const known = query('ui-intent-known', S(intent))
  if (!(Array.isArray(known) && known.length > 0)) return null
  const phrase = query('say-for', S(look), S(intent))
  return typeof phrase === 'string' ? phrase : null
}

let shared: Readonly<{ say(look: string, intent: string): string | null }> | null = null

/** Native homes need authored intent phrases, without importing the candidate inspector or its part catalogue. */
export function nativeWords() {
  if (shared) return shared
  const m = new MeTTa()
  m.run(PETTA_STDLIB_SRC)
  m.run(intents)
  const query = (head: string, ...args: Atom[]): Val => {
    const answer = m.evaluateAtom(E(S(head), ...args))
    if (answer.length !== 1) throw new Error(`UI phrase query ${head} did not return one answer`)
    return toVal(answer[0])
  }
  shared = Object.freeze({ say: (look: string, intent: string) => readIntentPhrase(query, look, intent) })
  return shared
}

/** chromeWord's answers: the table is read once and never changes while the app runs, and the HUD asks on every render. */
const chromeWords = new Map<string, string>()

/** A chrome word every look's screens share (the Ω menu's own entries, e.g. chrome.inbox, the page a person answers
 * minds' asks on), as intents.metta says it for that look. MeTTa says it and React only draws it (J9), so renaming a
 * page is one atom; an intent with nothing said fails loudly instead of showing a stale hard-coded name. */
export function chromeWord(intent: string, look = 'default'): string {
  const key = `${look}\u0000${intent}`
  const known = chromeWords.get(key)
  if (known !== undefined) return known
  const said = nativeWords().say(look, intent)
  if (!said) throw new Error(`intents.metta says nothing for ${intent} in the ${look} look`)
  chromeWords.set(key, said)
  return said
}
