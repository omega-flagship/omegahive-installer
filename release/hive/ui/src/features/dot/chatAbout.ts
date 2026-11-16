// Purpose: an artifact a person brings into a mind's chat from the Artifacts page's Ask button, kept beside the
// chat's unsent words until it goes with the next message as its id.
import { draftWriter, useDraft } from '../../experiences/drafts'

/** The artifact a chat's next message is about: its id, which the mind reads, and its title, which the person sees. */
export interface ChatAbout { id: string; title: string }

const key = (mindId: string) => `dot:chat:${mindId}:about`

/** Puts an artifact on a mind's chat box, in the drafts store beside the chat's words (experiences/drafts), so it outlives
 * the page change that follows and goes with whatever the person sends there next. One at a time: a second replaces it. */
export function attachAbout(mindId: string, about: ChatAbout): void {
  draftWriter(key(mindId))(JSON.stringify(about))
}

/** The artifact on a mind's chat box, null when there is none, and the way to take it off. */
export function useAbout(mindId: string): [ChatAbout | null, () => void] {
  const [raw, set] = useDraft(key(mindId))
  return [parse(raw), () => set('')]
}

function parse(raw: string): ChatAbout | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<ChatAbout>
    return typeof v.id === 'string' && v.id ? { id: v.id, title: typeof v.title === 'string' ? v.title : '' } : null
  } catch {
    return null
  }
}

/** What goes to the mind: the person's words, then the artifact's id in a code span on a line of its own, the form a mind
 * names an artifact in and the hive draws as that artifact's chip. */
export const withAbout = (text: string, about: ChatAbout | null): string => (about ? `${text}\n\n\`${about.id}\`` : text)
