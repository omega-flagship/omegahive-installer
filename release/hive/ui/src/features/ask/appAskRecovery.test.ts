import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { MiniDocument, press, type MiniNode } from '../../ui/miniDom.testkit'
import type { PresentedAsk } from '../../store/appAsk'

/**
 * The "Return to Ask" card (AppAskRecovery) MOUNTED, so its state is real. A different turn gets a fresh card: not
 * busy, no error, and the earlier turn's late answer cannot reach it. It used to reset by calling setState inside an
 * effect (one wasted render per change, and a lint error); it is now keyed by the turn.
 */

const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as { readFileSync: (p: URL, e: 'utf8') => string }

const claims: { entry: PresentedAsk; settle: (v: null) => void }[] = []
vi.mock('../../store/appAsk', async (orig) => ({
  ...(await orig<typeof import('../../store/appAsk')>()),
  claimAppAsk: (entry: PresentedAsk) => new Promise<null>((settle) => void claims.push({ entry, settle })),
}))

const g = globalThis as Record<string, unknown>
const saved: Record<string, unknown> = {}
let doc: MiniDocument
beforeAll(() => {
  for (const k of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) saved[k] = g[k]
  doc = new MiniDocument()
  g.window = { document: doc, addEventListener: () => undefined, removeEventListener: () => undefined, HTMLIFrameElement: class {} }
  g.HTMLIFrameElement = (g.window as { HTMLIFrameElement: unknown }).HTMLIFrameElement
  g.document = doc
  g.IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) g[k] = v
})

const turn = (operation: string, epoch = 1): PresentedAsk => ({
  app: 'invented-app',
  appName: 'Invented app',
  presentation: { operation_id: operation, epoch, host_active: false } as never,
  controller: {} as never,
  port: {} as never,
  current: () => true,
  offeredLocally: false,
})

const unmounts: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const u of unmounts.splice(0)) await u()
  claims.splice(0)
  const { useAppAskStore } = await import('../../store/appAsk')
  useAppAskStore.setState({ turns: [], provisional: [] })
})

async function mount() {
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { AppAskRecovery } = await import('./AppAskRecovery')
  const { useAppAskStore } = await import('../../store/appAsk')
  const container = doc.body.appendChild(doc.createElement('div'))
  const root = createRoot(container as unknown as HTMLElement)
  await act(async () => root.render(createElement(AppAskRecovery)))
  unmounts.push(async () => act(async () => root.unmount()))
  const button = () => container.findAll((n) => n.tagName === 'BUTTON')[0] as MiniNode | undefined
  return {
    act,
    button,
    status: () => container.findAll((n) => n.getAttribute('role') === 'status').map((n) => n.textContent),
    show: async (...turns: PresentedAsk[]) => act(async () => useAppAskStore.setState({ turns })),
  }
}

describe('the Return to Ask card', () => {
  it('nothing to recover: no card', async () => {
    const m = await mount()
    expect(m.button()).toBeUndefined()
  })

  it('a pending return, then a different turn: the new card is fresh and the late answer cannot touch it', async () => {
    const m = await mount()
    await m.show(turn('op_invented_a'))
    await m.act(async () => press(m.button()!))
    expect(m.button()!.textContent).toBe('Returning…')
    expect(claims.map((c) => c.entry.presentation.operation_id)).toEqual(['op_invented_a'])

    await m.show(turn('op_invented_b'))
    expect(m.button()!.textContent).toBe('Return to Ask')
    expect(m.button()!.getAttribute('disabled')).toBeNull()

    // the first turn's claim fails late: the card for the second turn shows no error and stays ready
    await m.act(async () => claims[0].settle(null))
    expect(m.status()).toEqual([])
    expect(m.button()!.textContent).toBe('Return to Ask')
  })

  it('the same turn with a newer epoch also gets a fresh card', async () => {
    const m = await mount()
    await m.show(turn('op_invented_a', 1))
    await m.act(async () => press(m.button()!))
    await m.act(async () => claims[0].settle(null))
    expect(m.status()).toHaveLength(1)
    await m.show(turn('op_invented_a', 2))
    expect(m.status()).toEqual([])
  })

  it('the reset is a key, not setState in an effect', () => {
    const src = fs.readFileSync(new URL('./AppAskRecovery.tsx', import.meta.url), 'utf8')
    expect(src).not.toMatch(/useEffect/)
    expect(src).toMatch(/<AppAskRecoveryCard key=\{`\$\{entry\.presentation\.operation_id\}:\$\{entry\.presentation\.epoch\}:/)
  })
})
