/** Purpose: draw the Ask's own Search control.
 * Search, as its own marked control beside the field (feedback #127). Before this, the only way to search from the Ask
 * was the "Search everything for …" row under the field, so a pointer resting on that row could turn Enter into a
 * search. Now the rows only say what Enter will do, and searching has its own button, on show in every look.
 *
 * It is the shell's `search` part (experiences/parts/shell.metta: one owner, the one Ask), and every skin draws it
 * with this one component in its own furniture (`className`, and a face: an icon or the look's word). Its name is the
 * look's phrase for the `ask.search` intent (inventory/intents.metta, say-for), never a component string.
 *
 * It opens the search palette with the words in the field. The words stay in the field: nothing is sent or spent.
 */
import type { ReactNode } from 'react'
import { nativeWords } from '../../inventory/nativeWords'
import { useHive } from '../../store/store'

export const ASK_SEARCH_PART = 'shell any search'
export const ASK_SEARCH_INTENT = 'ask.search'

/** What this look calls the control (say-for look ask.search). */
export const askSearchWords = (look: string): string => nativeWords().say(look, ASK_SEARCH_INTENT) ?? 'Search'

/** The magnifier the icon skins draw. */
export function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      <circle cx="10.5" cy="10.5" r="5.5" stroke="currentColor" strokeWidth="1.8" fill="none" />
      <path d="M15 15l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
    </svg>
  )
}

interface Props {
  /** the look whose words name it (the experience id) */
  look: string
  /** the words in the field now; the palette opens with them typed */
  words: () => string
  /** the skin's own button class */
  className: string
  /** a displayed-origin guard, where the skin has one (a retained skin never acts for a later person) */
  may?: () => boolean
  disabled?: boolean
  /** the face: an icon, or the look's word. Default: the look's phrase. */
  children?: ReactNode
}

export function AskSearch({ look, words, className, may, disabled, children }: Props) {
  const label = askSearchWords(look)
  return (
    <button
      type="button"
      className={className}
      data-ask-search=""
      data-ui-part={ASK_SEARCH_PART}
      data-intent={ASK_SEARCH_INTENT}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => {
        if (may && !may()) return
        useHive.getState().openPalette(words().trim())
      }}
    >
      {children ?? label}
    </button>
  )
}
