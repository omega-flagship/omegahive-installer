import type { DotTab } from '../../lib/router'

/**
 * Moving between a mind panel's tabs without losing the chat (mind-chat r1: a person opened Budget and could not find
 * the conversation again). Leaving the chat for another tab is a new history entry, so Back returns to it; coming back
 * to the chat from there steps back to that same entry; moving between the other tabs replaces the entry. Esc on any
 * tab but the chat returns to the chat; Esc on the chat closes the panel. Pure, and tested (tabNav.test.ts).
 */
export type TabStep = 'none' | 'push' | 'replace' | 'back'

export function tabStep(from: DotTab, to: DotTab, leftChatHere: boolean): TabStep {
  if (from === to) return 'none'
  if (from === 'chat') return 'push'
  if (to === 'chat' && leftChatHere) return 'back'
  return 'replace'
}

/** What Esc does on a tab: back to the chat, or (on the chat) close the panel. */
export const escapeFrom = (tab: DotTab): 'chat' | 'close' => (tab === 'chat' ? 'close' : 'chat')

/** The stable, linkable address of a mind's conversation (lib/router: `#/dot/<id>`, the Chat tab). */
export const chatRoute = (id: string) => ({ name: 'dot' as const, id, tab: 'chat' as const })
