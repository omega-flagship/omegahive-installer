// @vitest-environment node
// Purpose: words drawn before the composed words have loaded (features/views/Words.tsx), as a chat draws its first
// messages: while the screen engine loads they read as plain words with the artifact id said as words, then the parts
// MeTTa composes are drawn in the same place, and the chip drawn then is the same chip, title and all, when the chat
// draws the words again. The composed words load only when the test opens a gate, so the first message is drawn before
// they load however warm the module cache is. INVENTED id, title and words.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { useHive } from '../../store/store'
import { Words } from './Words'
import { loadWords } from './wordsLoader'
import { mountPage, settle, type MountedPage } from './mountedView.testkit'

// the screen engine loads once for the file: allow for a loaded machine
vi.setConfig({ testTimeout: 20_000 })

// the slot's loader waits for the gate, then loads the real composed words: with a warm module cache they would
// otherwise arrive inside the first draw, and the words drawn before they load would never be seen
const gate = vi.hoisted(() => {
  let open = () => {}
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { open: () => open(), opened }
})
vi.mock('./wordsLoader', async (importOriginal) => {
  const real = await importOriginal<typeof import('./wordsLoader')>()
  return { ...real, loadWords: () => gate.opened.then(() => real.loadWords()) }
})

const tip = `ar_${'1'.repeat(32)}`
const client = {
  artifact: () => Promise.resolve({ artifact_id: tip, kind: 'view', title: 'Tip calculator', swarm_id: 's1', mind_id: 'a1', revision: 1,
    digest: `sha256:${'d'.repeat(64)}`, created_at: '2026-11-12T00:00:00Z', revised_at: '2026-11-12T00:00:00Z' }),
}

let page: MountedPage
const chips = () => page.container.findAll((n) => n.getAttribute('data-artifact-ref') === tip)
const draw = () => act(async () => page.root.render(<Words text={`Here is ${tip} for tonight.`} />))

beforeEach(async () => {
  page = await mountPage()
  useHive.setState({ client: client as never })
})
afterEach(async () => {
  await page.restore()
  useHive.setState({ client: null as never })
})

describe('words drawn while the composed words load', () => {
  it('read as plain words with no id, then get their chip in place, and keep that chip when drawn again', async () => {
    await draw()
    expect(page.container.textContent).toBe('Here is an artifact for tonight.')
    // the engine comes in: the lazy part draws the composed words where the plain ones were
    await act(async () => {
      gate.open()
      await loadWords()
    })
    await settle()
    expect(page.container.textContent).toBe('Here is Tip calculator for tonight.')
    const [chip] = chips()
    expect(chip).toBeDefined()
    // the chat draws again (a new message, a streamed word): the same chip, never mounted afresh with its title gone
    await draw()
    expect(chips()).toHaveLength(1)
    expect(chips()[0]).toBe(chip)
    expect(page.container.textContent).toBe('Here is Tip calculator for tonight.')
  })
})
