import { surenessColor, surenessMeter, type Belief } from '../sdk'

/**
 * uifix-r3.5–r3.7: the bar beside a sureness word in Flux. Its length is the sureness tone and its colour the sureness
 * colour, both from the one decision (surenessOf): a tentative belief is a neutral half bar, a "doubts it" bar red and
 * short, a "yes" bar blue and long. Brightness is how much evidence (c).
 * r3.7 (stand-in P1 on r3.6): nothing here moves over time. The width used to spring from 0 (and from the previous
 * belief), so a bar could read 80% for a moment beside "tentative". Length and colour are semantic, so they are set at
 * once, and nothing else moves either: the bar is exactly what the word says at every instant.
 */
export function SurenessMeter({ tv }: { tv: Belief['tv'] }) {
  return (
    <div className="relative h-2 flex-1 overflow-hidden rounded-full" style={{ background: 'rgb(255 255 255 / 0.1)' }} aria-hidden="true" data-sureness-meter="">
      <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${surenessMeter(tv) * 100}%`, opacity: 0.35 + 0.65 * tv.c, background: surenessColor(tv) }} />
    </div>
  )
}
