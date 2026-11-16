// @vitest-environment node
// Purpose: a mind's answer in the Ask (AnswerRow in features/ask/Thread.tsx) drawn as every look draws words said in the
// hive (features/views/Words): an artifact id it names reads as the artifact's title in a chip, in a sentence and in a
// belief alike, never as the id; its bold stays bold; what was asked about is lit up in its words but never in a chip;
// and the exact answer is offered once, "as written", at its end. INVENTED mind, id, title and words.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { AskRow } from '../../store/ask'
import { useHive } from '../../store/store'
import { loadWords } from '../views/wordsLoader'
import { mountPage, settle, type MountedPage } from '../views/mountedView.testkit'
import { AnswerRow } from './Thread'

vi.setConfig({ testTimeout: 20_000 })
await loadWords()

const tip = `ar_${'1'.repeat(32)}`
const client = {
  artifact: () => Promise.resolve({ artifact_id: tip, kind: 'view', title: 'Tip calculator', swarm_id: 's1', mind_id: 'a_vega01', revision: 1,
    digest: `sha256:${'d'.repeat(64)}`, created_at: '2026-11-12T00:00:00Z', revised_at: '2026-11-12T00:00:00Z' }),
}
const answer: AskRow = { id: 'op1#2', op: 'op1', seq: 2, kind: 'answer', who: 'Vega', whoId: 'a_vega01',
  text: `Here is **your tip calculator**, ${tip}, with the split for four.\n\nI noted (--> ${tip} calculator) for later.` } as AskRow

let page: MountedPage
beforeEach(async () => {
  page = await mountPage()
  useHive.setState({ client: client as never })
})
afterEach(async () => {
  await page.restore()
  useHive.setState({ client: null as never })
})

const all = (tag: string) => page.container.findAll((n) => n.tagName === tag)

describe("a mind's answer in the Ask", () => {
  it('names its artifact in a chip, keeps its bold and lit-up words, and offers the exact answer once', async () => {
    await act(async () => page.root.render(<AnswerRow r={answer} variant="glass" words={['tip']} />))
    await settle()
    const text = page.container.textContent
    expect(/ar_[0-9a-f]{32}/.test(text)).toBe(false)
    // a chip in the sentence and one in the belief, the one disclosure, and the two chips in the answer as written
    expect(all('BUTTON').map((b) => b.textContent)).toEqual(['Tip calculator', 'Tip calculator', 'Show as written', 'Tip calculator', 'Tip calculator'])
    expect(all('STRONG').map((b) => b.textContent)).toEqual(['your tip calculator'])
    // what was asked about is lit up in the answer's words, and never inside a chip
    expect(all('MARK').map((m) => m.textContent)).toEqual(['tip'])
    expect(all('BUTTON').some((b) => b.findAll((n) => n.tagName === 'MARK').length > 0)).toBe(false)
    expect(page.container.findAll((n) => n.getAttribute('data-said') !== null).length).toBe(1)
  })
})
