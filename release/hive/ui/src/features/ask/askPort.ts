/**
 * The one Ask, as a port the looks use (Ask-and-apps contract R1.1 §5). A look's rest and awake states reach the shell's
 * one Ask only through this: never a DOM selector of their own, never the Ask store. The Ask itself stays the shell's
 * AskHost (auto-wake, the answerer chooser, every skin); this only names what a look may do with it.
 *
 * Every skin marks its field with `data-ask-input` (ClassicAsk, StillLine, the command line, …), so focus works in every
 * look, where the old `.ask-root .ask-input` selector found Classic's field only.
 *
 * A port belongs to the identity it was made under (R1.1 #2, lib/identityEpoch). After an identity change it is dead:
 * focus and type do nothing, hasWords is false, and every subscription made through it is dropped in the change itself,
 * so a handle a look kept can never fill or listen to the next person's Ask. The shell makes a new port per identity.
 */
import { askFieldHasWords, fillAsk } from './useAskField'
import { focusAskField, onAskDispatch, type AskDispatch, type AskDoc } from './askField'
import { bindEpoch, onIdentityChange } from '../../lib/identityEpoch'
import { usePhase, wakeIntoAsk } from '../../shell/phase'

export type { AskDispatch }
export interface AskPort {
  /** the identity this port was made under is still the current one */
  alive(): boolean
  /** move the caret into the one Ask; at rest it wakes first, so the field is shown in this same tick. false: no field */
  focus(): boolean
  /** add words after any the person typed (never replaces, never sends); 'none' when there is no field or the port is dead */
  type(text: string): 'filled' | 'kept' | 'none'
  /** the field holds unsent words */
  hasWords(): boolean
  /** called each time the person sends from the Ask, for this identity only; returns the unsubscribe */
  onDispatch(cb: (d: AskDispatch) => void): () => void
}

export { ASK_FIELD } from './askField'

/** The port over this page's Ask, for the current identity (a document can be given for tests). */
export function createAskPort(experience: string, doc: AskDoc | null = typeof document === 'undefined' ? null : document): AskPort {
  const binding = bindEpoch()
  const subs = new Set<() => void>()
  const off = onIdentityChange(() => {
    for (const unsub of [...subs]) unsub()
    subs.clear()
    off()
  })
  return {
    alive: () => binding.current(),
    focus() {
      if (!binding.current()) return false
      const p = usePhase.getState()
      if (p.phased && p.phase === 'rest') return wakeIntoAsk('type')
      return focusAskField(doc)
    },
    type: (text) => (binding.current() ? fillAsk(text, { experience, append: true }) : 'none'),
    hasWords: () => binding.current() && askFieldHasWords(),
    onDispatch(cb) {
      if (!binding.current()) return () => undefined
      const unsub = onAskDispatch((d) => { if (binding.current()) cb(d) })
      subs.add(unsub)
      return () => { unsub(); subs.delete(unsub) }
    },
  }
}
