// Purpose: the slot under an Ask answer where what MeTTa composes for it (AnswerParts.tsx) is drawn, loaded lazily with
// the screen engine as the words slot is (features/views/Words.tsx), so the engine stays out of the thread's first paint.
import { Suspense, useState } from 'react'
import { lazyRoute } from '../../lib/lazyRoute'
import { loadAnswerParts, loadedAnswerParts, type AnswerPartsProps } from './answerPartsLoader'

const Lazy = lazyRoute(loadAnswerParts)

/**
 * The parts under one answer. Each slot keeps the shape it mounted with, as the words slot does: mounted once the parts
 * have loaded, it draws them at once; mounted before, it stays on the lazy path, which draws them in the same place once
 * they load, showing nothing meanwhile (the answer above stands on its own).
 */
export function AnswerPartsSlot({ r }: AnswerPartsProps) {
  const [Composed] = useState(() => loadedAnswerParts())
  if (Composed) return <Composed r={r} />
  return (
    <Suspense fallback={null}>
      <Lazy r={r} />
    </Suspense>
  )
}
