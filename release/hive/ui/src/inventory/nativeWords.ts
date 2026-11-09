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
