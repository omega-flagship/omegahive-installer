// @vitest-environment node
// Purpose: a mind's reply streaming into classic's chat (Bubble in features/dot/Chat.tsx), drawn through the words every
// look draws: an artifact id it names streams in as its chip with the artifact's title, never as the id, and once the
// whole reply is in that chip is the same one, never drawn afresh. INVENTED mind, id, title and words.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { Agent, Message } from '../../api/types'
import { useHive } from '../../store/store'
import { loadWords } from '../views/wordsLoader'
import { mountPage, type MountedPage } from '../views/mountedView.testkit'
import { Bubble } from './Chat'

vi.setConfig({ testTimeout: 20_000 })
await loadWords()

const tip = `ar_${'1'.repeat(32)}`
const client = {
  artifact: () => Promise.resolve({ artifact_id: tip, kind: 'view', title: 'Tip calculator', swarm_id: 's1', mind_id: 'a_vega01', revision: 1,
    digest: `sha256:${'d'.repeat(64)}`, created_at: '2026-11-12T00:00:00Z', revised_at: '2026-11-12T00:00:00Z' }),
}
const agent = { id: 'a_vega01', name: 'Vega', hue: 200 } as unknown as Agent
const said = 'for tonight. It works out the tip and splits the bill for four, rounding each share up to the cent.'
const reply: Message = { id: 'm_tip', agent_id: 'a_vega01', conversation_id: 'c_main', direction: 'out', sender: 'a_vega01',
  text: `Here is ${tip} ${said}`, created_at: '2026-11-12T10:00:00Z' }

let page: MountedPage
beforeEach(async () => {
  page = await mountPage()
  useHive.setState({ client: client as never })
})
afterEach(async () => {
  await page.restore()
  useHive.setState({ client: null as never })
})

const chip = () => page.container.findAll((n) => n.getAttribute('data-artifact-ref') === tip)[0]
/** The cursor that follows the words while they stream in. */
const streaming = () => page.container.findAll((n) => (n.getAttribute('class') ?? '').split(' ').includes('animate-pulse')).length > 0
/** Real time passes in small steps until `ok` holds: the reply streams in on its own timer. */
async function until(ok: () => boolean) {
  for (let i = 0; i < 500 && !ok(); i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
  expect(ok()).toBe(true)
}

describe('a reply streaming into the chat', () => {
  it('streams an id in as its chip, and keeps that chip once the whole reply is in', async () => {
    await act(async () => page.root.render(<ul><Bubble m={reply} agent={agent} grouped fresh peerName={() => ''} peerHue={() => 0} /></ul>))
    await until(() => streaming() && chip()?.textContent === 'Tip calculator')
    const streamed = chip()
    expect(/ar_[0-9a-f]{32}/.test(page.container.textContent)).toBe(false)
    await until(() => !streaming())
    expect(chip()).toBe(streamed)
    expect(page.container.textContent).toBe(`Here is Tip calculator ${said}`)
  })
})
