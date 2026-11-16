/**
 * An experience's own handler for acts it does in place (Still's sheets and passages), so every Ask skin in that
 * experience (its question box and its floating line) does them the same way. Vocabulary and places only: the engine
 * (lib/intent) and the runner (run.ts) are shared and never forked.
 */
import type { IntentAct } from '../../lib/intent'

/** true: done (the field clears); 'keep': done, but the words stay (a refusal or a search); false: not this skin's act. */
export type ActHandler = (act: IntentAct, you: string) => Promise<boolean | 'keep'> | boolean | 'keep'
const handlers = new Map<string, ActHandler>()

export function registerActHandler(experience: string, fn: ActHandler): () => void {
  handlers.set(experience, fn)
  return () => {
    if (handlers.get(experience) === fn) handlers.delete(experience)
  }
}

export const actHandlerFor = (experience: string): ActHandler | undefined => handlers.get(experience)
