// @vitest-environment node
// Purpose: words said in the hive as a person reads them, through the one slot every look draws them with (Words.tsx), composed by MeTTa (words.metta) and drawn by the said and written blocks: an artifact id reads as its title in a chip, a word while it is read, a plain notice when it cannot be opened, never the id; a statement reads as English with the exact words, chips and all, behind "Show as written"; and a press on a chip opens the artifact. The hive here is a stand-in client. INVENTED ids, titles and words.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { ApiError } from '../../api/client'
import { press } from '../../ui/miniDom.testkit'
import { useHive } from '../../store/store'
import { Words } from './Words'
import { loadWords } from './wordsLoader'
import { mountPage, settle, type MountedPage } from './mountedView.testkit'

vi.setConfig({ testTimeout: 20_000 })
await loadWords()

const id = (digit: string) => `ar_${digit.repeat(32)}`
const [tip, list, gone, slow, plan] = [id('1'), id('2'), id('3'), id('4'), id('5')]
const row = (artifact_id: string, kind: string, title: string) => ({ artifact_id, kind, title, swarm_id: 's1', mind_id: 'a1', revision: 1,
  digest: `sha256:${'d'.repeat(64)}`, created_at: '2026-11-12T00:00:00Z', revised_at: '2026-11-12T00:00:00Z' })
const ROWS: Record<string, ReturnType<typeof row>> = { [tip]: row(tip, 'view', 'Tip calculator'), [list]: row(list, 'plan', 'Shopping list'), [plan]: row(plan, 'plan', 'Garden plan') }
const client = {
  artifact: (asked: string) => {
    if (asked === slow) return new Promise(() => undefined)   // still being read
    if (ROWS[asked]) return Promise.resolve(ROWS[asked])
    return Promise.reject(new ApiError(404, 'not_found', 'no such artifact'))
  },
}

const ANY_ID = /ar_[0-9a-f]{32}/
let page: MountedPage
const buttons = () => page.container.findAll((n) => n.tagName === 'BUTTON')
/** What a person reads or hears: the text, and the attributes shown on hover or read aloud. */
const labels = () => page.container.findAll((n) => n.nodeType === 1).flatMap((n) => ['title', 'aria-label'].map((k) => n.getAttribute(k) ?? '')).filter(Boolean)
const draw = async (node: ReactNode) => {
  await act(async () => page.root.render(node))
  await settle()
}

beforeEach(async () => {
  page = await mountPage()
  useHive.setState({ client: client as never })
})
afterEach(async () => {
  await page.restore()
  useHive.setState({ client: null as never })
})

describe('words said in the hive, as a person reads them', () => {
  it('an id reads as its title, a word while it is read, and a plain notice when it cannot be opened, never the id', async () => {
    await draw(<Words text={`Here is ${tip} for tonight, the list as \`${list}\`, the old one (${gone}) and ${slow}.`} />)
    const text = page.container.textContent
    expect(text).toBe('Here is Tip calculator for tonight, the list as Shopping list, the old one (Artifact not available) and Artifact.')
    expect([text, ...labels()].some((s) => ANY_ID.test(s))).toBe(false)
    // the ones that can be opened are buttons; the one that cannot says why on hover and is no button
    expect(buttons()).toHaveLength(3)
    expect(labels()).toContain('It is no longer here, or not shown to you.')
  })

  it('a statement reads as English beside a chip, and "Show as written" keeps the notation but not the id', async () => {
    await draw(<Words text={`I revised (--> rr-lyrae variable) to f 0.89, c 0.71 in ${tip}.`} />)
    const text = page.container.textContent
    expect(text).toContain('Tip calculator')
    expect(page.container.findAll((n) => n.getAttribute('data-said') !== null).length).toBeGreaterThan(0)
    expect(buttons().map((b) => b.textContent)).toContain('Show as written')
    expect(text).toContain('(--> rr-lyrae variable)')   // as written, the notation stays exactly as the mind wrote it
    expect([text, ...labels()].some((s) => ANY_ID.test(s))).toBe(false)
  })

  it('an id a statement names reads as its chip too, in the English and as written', async () => {
    await draw(<Words text={`I filed (--> ${plan} garden-notes) today.`} />)
    const text = page.container.textContent
    expect(text).toContain('Garden plan')
    expect([text, ...labels()].some((s) => ANY_ID.test(s))).toBe(false)
    // the chip in the sentence, the disclosure, and the chip in the words as written, hidden until it opens
    expect(buttons().map((b) => b.textContent)).toEqual(['Garden plan', 'Show as written', 'Garden plan'])
  })

  it('words with nothing to say in English offer no "as written"; a place showing only "as written" shows only that', async () => {
    await draw(<Words text="Kelp is recovering." />)
    expect(page.container.textContent).toBe('Kelp is recovering.')
    expect(buttons()).toHaveLength(0)
    await draw(<Words text="(--> vega star)" said={false} written className="cm-raw" />)
    expect(buttons().map((b) => b.textContent)).toEqual(['Show as written'])
    expect(page.container.findAll((n) => n.getAttribute('class')?.split(' ').includes('cm-raw') ?? false)).toHaveLength(1)
  })

  it('a chip opens its artifact on Artifacts', async () => {
    await draw(<Words text={`The plan is ${plan}.`} />)
    await act(async () => { press(buttons()[0]) })
    expect(window.location.hash).toBe(`#/artifacts/${plan}`)
  })
})
