import { askConfirmBound } from '../../lib/identityEpoch'
import { askMemory, LOST_WORDS, type EditProblem, type TraceEntry } from '../../lib/askMemory'
import { navigate } from '../../lib/router'
import { useAskStore } from '../../store/ask'

/** The memory screen lives on You and your keys (#/me), as its "What the Ask knows about you" section. */
export const MEMORY_SECTION_ID = 'ask-memory'

let focusNext = false
const focusListeners = new Set<() => void>()
/** Open the memory screen from anywhere (the Ask thread's "What I know"): #/me, scrolled to the section. */
export function openAskMemory(): void {
  focusNext = true
  // the thread steps aside so the screen is in view (it opens again from the Ask)
  useAskStore.getState().setThreadOpen(false)
  navigate({ name: 'me' })
  // already on #/me, the section is mounted and will not mount again: it is told instead (after this render)
  if (focusListeners.size) queueMicrotask(() => focusListeners.forEach((l) => l()))
}
/** A mounted memory section hears every openAskMemory (and takes the focus it asks for). Returns an unsubscribe. */
export function onMemoryFocus(fn: () => void): () => void {
  focusListeners.add(fn)
  return () => {
    focusListeners.delete(fn)
  }
}
/** True once after openAskMemory: the section scrolls itself into view and takes focus. */
export function takeMemoryFocus(): boolean {
  const f = focusNext
  focusNext = false
  return f
}

/** A journal line in the page's words (a forgotten belief's words are gone from it). */
export function traceWords(t: TraceEntry): string {
  switch (t.kind) {
    case 'remember':
      return t.summary ? `Remembered: ${t.summary}` : 'Remembered something, since forgotten.'
    case 'revise':
      return t.summary ? `Updated: ${t.summary}` : 'Updated something, since forgotten.'
    case 'edit':
      return t.summary ? `You edited it to: ${t.summary}` : 'You edited something, since forgotten.'
    case 'forget':
      return 'You had one thing forgotten.'
    case 'forget_all':
      return 'You had everything forgotten.'
    case 'lost':
      return LOST_WORDS
    case 'restore':
      return 'You restored your mind’s memory from a file.'
  }
}

/**
 * "Forget everything", asked and done for the owner shown when the button was pressed (stand-in r1 P2): the question
 * is bound to that owner's store binding and identity epoch; an identity change answers it "no" at once, and a "yes"
 * that arrives after any change forgets nothing. True when everything was forgotten.
 */
export async function confirmForgetAll(count: number): Promise<boolean> {
  const token = askMemory.forgetAllToken()
  const ok = await askConfirmBound(`Forget everything the Ask knows about you in this browser (${count} thing${count === 1 ? '' : 's'})? This cannot be undone. Your “Use my swarm talk in answers” choice stays as you set it.`, 'Forget everything', { danger: true, binding: token.binding })
  return ok && token.binding.commit(() => askMemory.forgetAll(token)) === true
}

/** Why an edit was not kept, in the page's words. */
export function editProblemWords(p: EditProblem): string {
  switch (p) {
    case 'empty':
      return 'Write what the Ask should know, or Cancel.'
    case 'same':
      return 'That is what it says already. Change it, or Cancel.'
    case 'private':
      return 'These words name a private app, and the Ask never keeps anything about one. Say it without naming the app, or Cancel.'
    case 'gone':
      return 'This was forgotten meanwhile (perhaps in another tab), so there is nothing left to edit.'
  }
}
