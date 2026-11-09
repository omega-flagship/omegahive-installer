import { presenceCommand } from '../../features/ask/Presence'
import { shownMind } from '../../features/ask/words'
import { useAskStore } from '../../store/ask'
import { useC } from './state'

/**
 * Watching the orchestrator work (Jon, 2026-10-05; UNIVERSAL_ASK_DESIGN §9): in the construct its presence is echoed in
 * the console as typed lines, as if a second operator were at the prompt. Presentation only, from the shared Ask store;
 * captions are plain text. Each echo is a copy of the Ask (echoAsk): it leaves the console with the Ask's thread, and
 * every identity change clears the console (state.ts). Returns the unsubscribe (Construct holds it while mounted).
 */
export function watchAskEcho(): () => void {
  let seen = new Set(useAskStore.getState().presence.map((p) => p.id))
  return useAskStore.subscribe((s, prev) => {
    if (s.presence === prev.presence) return
    if (!s.presence.length && !s.log.length) {
      seen = new Set()
      return
    }
    for (const p of s.presence) {
      if (seen.has(p.id)) continue
      seen.add(p.id)
      const who = shownMind(p.actor.name).toLowerCase()
      useC.getState().echoAsk([{ t: `${who}@hive ❯ `, c: 'cyan' }, { t: presenceCommand(p), c: 'hi' }, ...(p.caption ? [{ t: `  # ${p.caption}`, c: 'dim' as const }] : [])])
    }
  })
}
