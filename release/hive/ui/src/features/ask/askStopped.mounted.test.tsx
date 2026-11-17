// @vitest-environment node
// Purpose: verify the Continue row mounted in every look (Jon on #394: "a mounted test per look for the Continue row, as
// createPlan has"): under a request that ended before its answer, is the thread's latest and is still kept, MeTTa's
// Continue is drawn and pressing it sends Continue's own words for that request; otherwise no row, and it goes the moment
// the request is no longer kept.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { MiniDocument, press, type MiniNode } from '../../ui/miniDom.testkit'

vi.setConfig({ testTimeout: 20_000 })

const T = vi.hoisted(() => ({ look: 'classic' }))
vi.mock('../../shell/uiVariant', async (orig) => ({
  ...(await orig<typeof import('../../shell/uiVariant')>()),
  useLook: () => ({ current: { experience: T.look } }),
}))

const { ALL_EXPERIENCES } = await import('../../experiences/registry')
const { EndingWayOn } = await import('./Thread')
const { useAskStore } = await import('../../store/ask')
type AskRow = import('../../store/ask').AskRow

/** Haley, testers' group, 17 Nov: "please have a 'continue task' button". An invented request, stopped by its person. */
const row = (ending: NonNullable<AskRow['ending']>): AskRow => ({ id: 'op_inv1#3', op: 'op_inv1', seq: 3, kind: 'refused', text: 'Stopped.', ending })

let doc: MiniDocument, host: MiniNode, root: Root, saved: Record<string, unknown>
const render = async (el: React.ReactElement) => { await act(async () => root.render(el)); await act(async () => { await Promise.resolve() }) }
const buttons = (name: string) => host.findAll((n) => n.tagName === 'BUTTON' && n.textContent === name)

beforeEach(async () => {
  const g = globalThis as unknown as Record<string, unknown>
  saved = {}
  for (const k of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) saved[k] = g[k]
  doc = new MiniDocument()
  const win = { document: doc, HTMLIFrameElement: class {}, addEventListener: () => undefined, removeEventListener: () => undefined, location: { hash: '#/', search: '', pathname: '/' },
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }) }
  doc.defaultView = win as never
  Object.assign(g, { window: win, document: doc, HTMLIFrameElement: win.HTMLIFrameElement, IS_REACT_ACT_ENVIRONMENT: true })
  host = doc.createElement('div'); doc.body.appendChild(host)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(host as unknown as Element)
})
afterEach(async () => {
  await act(async () => root.unmount())
  for (const [k, v] of Object.entries(saved)) (globalThis as unknown as Record<string, unknown>)[k] = v
  vi.useRealTimers()
})

describe('the Continue row, mounted in every look', () => {
  it('draws Continue under the latest request that ended early while it is kept, and sends its own words for it', async () => {
    const sent: unknown[][] = []
    useAskStore.setState({ continueStopped: async (...a: unknown[]) => void sent.push(a) } as never)
    const until = Date.now() + 3_600_000
    for (const look of ALL_EXPERIENCES.map((x) => x.id)) {
      T.look = look
      await render(<EndingWayOn r={row({ early: true, latest: true, until })} />)
      const shown = buttons('Continue')
      expect(shown, look).toHaveLength(1)
      await act(async () => press(shown[0]))
      expect([sent.at(-1)?.[0], sent.at(-1)?.[3]], look).toEqual(['op_inv1', 'Continue'])
      for (const ending of [{ early: true, latest: false, until }, { early: false, latest: true, until }, { early: true, latest: true, until: Date.now() - 1 }]) {
        await render(<EndingWayOn r={row(ending)} />)
        expect(buttons('Continue'), `${look} ${JSON.stringify(ending)}`).toHaveLength(0)
      }
    }
    expect(sent).toHaveLength(ALL_EXPERIENCES.length)
  })

  it('lets Continue go the moment the request is no longer kept', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    T.look = 'classic'
    await render(<EndingWayOn r={row({ early: true, latest: true, until: Date.now() + 60_000 })} />)
    expect(buttons('Continue')).toHaveLength(1)
    await act(async () => { vi.advanceTimersByTime(59_000) })
    expect(buttons('Continue')).toHaveLength(1)
    await act(async () => { vi.advanceTimersByTime(1_000) })
    expect(buttons('Continue')).toHaveLength(0)
  })
})
