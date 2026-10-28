import { surenessRgb } from '../../lib/color'
import type { Truth } from '../../lib/beliefSentence'

/**
 * uifix-r3.5: a belief clump's colour in the Cosmos scene (Scene.tsx), as linear RGB. The hue is the one sureness
 * decision's tone (neutral whenever the word is "tentative"), the brightness is how much evidence there is (c).
 * Kept apart from the WebGL scene so the colour a person sees can be tested without a GPU.
 */
export function clumpColour(tv: Truth): [number, number, number] {
  const bright = 0.35 + 1.1 * tv.c
  const [r, g, b] = surenessRgb(tv)
  return [(r / 255) * bright, (g / 255) * bright, (b / 255) * bright]
}
