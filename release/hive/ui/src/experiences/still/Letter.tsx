// Purpose: draw what sits under Still's question box: today's page once the Ask has rows, and before that what waits on
// the person on its own.
import { AskCards, Thread, ThreadHead } from '../../features/ask/Thread'
import { useAskStore } from '../../store/ask'

/**
 * Under Still's question box: today's page once the Ask has rows (the thread, what waits on the person under it), and
 * before the first row what waits on the person alone (AskCards), so a mind's offer to build or a task a mind stopped
 * shows on a fresh paper too. `words` lights up what the orchestrator refers to in its answers (Presence).
 */
export function StillLetter({ words }: { words: string[] }) {
  const rows = useAskStore((s) => s.log.length)
  if (rows === 0) return <div className="st-pro-only"><AskCards /></div>
  return (
    <section className="st-letter st-pro-only" aria-label="Today’s page">
      <ThreadHead variant="letter" />
      <Thread variant="letter" words={words} />
    </section>
  )
}
