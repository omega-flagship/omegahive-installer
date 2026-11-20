// Purpose: what Enter does in a command palette that lists nothing for its words: hand them to the mind the Ask answers
// with, through the Ask field's own ask, framed as a request to find them.
import { askNowFromField, fillAsk } from '../ask/useAskField'

/** The palette's box holds what to find: "poem about bees" asks "Find poem about bees"; a find, search or look for stays. */
export const askWords = (typed: string): string => {
  const t = typed.trim()
  return !t || /^(find|search|look for)\b/i.test(t) ? t : `Find ${t}`
}

/** The two Ask calls the hand-over makes (fillAsk and askNowFromField), passed in so a test can stand in for them. */
export interface AskDeps {
  fill: (words: string, opts: { replace: true }) => 'filled' | 'kept' | 'none'
  ask: (opts: Record<string, never>) => Promise<string>
}

/**
 * Fill the Ask with the words and ask its mind now, through the field's one recipient decision (askNowFromField). The
 * palette closes only once the words are in the Ask. A turn already open ('busy') leaves them there for the person to
 * send; words the Ask could not take leave the palette open. Example: askInstead('poem about bees', close) fills
 * "Find poem about bees", closes the palette and returns 'asked'.
 */
export async function askInstead(typed: string, close: () => void, deps: AskDeps = { fill: fillAsk, ask: askNowFromField }): Promise<'asked' | 'kept' | 'none'> {
  const words = askWords(typed)
  if (!words || deps.fill(words, { replace: true }) !== 'filled') return 'none'
  close()
  return (await deps.ask({})) === 'asked' ? 'asked' : 'kept'
}
