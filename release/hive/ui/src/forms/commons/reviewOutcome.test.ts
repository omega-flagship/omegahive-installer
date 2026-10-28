import { expect, test } from 'vitest'
import { decisionShown, NOTHING_CHANGED } from '../../lib/decisionGate'
import type { Ask } from './gate'
import { decideAsk, runAct } from './useCommons'

// Review's probe (coordination/receipts-local/omegareview-commons-f0818d8/reviewOutcome.test.ts), ported to the
// current dialog contract. The original extracted DecisionDialog's `else setError(...)` expression; the dialog now
// renders a result through lib/decisionGate.decisionShown, so the probe asks that, over Commons' own decision
// (useCommons.decideAsk, which useCommons.decide is) instead of re-composing outcomeWords by hand.
const ask: Ask = {
  action: 'challenge',
  target: 'b1',
  belief: 'b1',
  seen: { statement: '(--> a b)', truth: 'f 0.9 c 0.8', 'independent sources': 2, 'missing research': 'none', 'commons revision': 'r1' },
  sources: [],
  seq: 1,
}

test('a consequential delivery with a lost answer must not promise no change and safe retry', async () => {
  let postedGoals = 0
  const act = async () => { postedGoals++; throw new Error('Connection lost after goal post') }
  const r = await decideAsk(ask, { act: (action, items, rev, confirmed) => runAct(act, action, items, rev, confirmed), reload: () => undefined, say: () => undefined })
  const shown = decisionShown(r)
  const text = shown.kind === 'error' ? shown.text : shown.kind === 'unsettled' ? shown.unsettled.unsettled : ''
  expect(postedGoals).toBe(1)
  expect(text).toContain('Connection lost after goal post')
  expect(text).not.toContain(NOTHING_CHANGED)
  expect(text).not.toContain('Nothing changed; you can try again.')
})
