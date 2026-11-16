import { surenessMeter } from '../../lib/color'
import type { Truth } from '../../lib/beliefSentence'

/** uifix-r3.6: Still's small meter beside the sureness word: its length is the sureness tone (a tentative belief is half). */
export function StillMeter({ tv }: { tv: Truth }) {
  return (
    <span className="st-meter" aria-hidden data-sureness-meter="">
      <i style={{ transform: `scaleX(${Math.max(0.06, surenessMeter(tv))})` }} />
    </span>
  )
}
