/**
 * r4 (stand-in Review on f7c1cd4, coordination/omegareview/standin/STANDIN_canvas3_VERDICT_20261006.md): the confirm
 * the person actually sees, rendered. The canvas's own VibeCard is rendered over a real VibeSession (the simulator's
 * invented service), its confirm opened through the session's own review(); the rendered dialog must say what was
 * allowed and asked. Shown to fail with the confirm's facts wiring removed (receipts r4/p4-M*.txt).
 */
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// the confirm is a portal into document.body in the page; here it renders in place so its text can be read
vi.mock('react-dom', async (orig) => ({ ...(await orig<typeof import('react-dom')>()), createPortal: (node: ReactNode) => node }))
// the dialog names document.body as its portal target while rendering (only the name; nothing is attached here)
;(globalThis as { document?: unknown }).document ??= { body: {}, activeElement: null, addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [] }
;(globalThis as { HTMLElement?: unknown }).HTMLElement ??= class {}

import type { CodeContext, HiveClient } from '../../../api/client'
import { SimCodeService } from '../../../api/sim/codeService'
import type { WorkspaceHead } from '../suggestions/contract'
import { VibeCard } from './CodeCanvas'
import { DEPENDENT_GROUPS, PLAIN_SUMMARY, type Caps } from './features'
import { vibeFields } from './useVibe'
import { VibeSession, type SavedFile } from './vibeSession'
import { intentsKit } from './vibeIntents.testkit'

const WS = 'ws_r4'
const CTX: CodeContext = { task_id: 'g_r4', grant_id: 'grant_r4', repository_id: 'sim-suggestions' }
const READY: Caps = { status: 'ready', key: 'k', features: new Set([DEPENDENT_GROUPS, PLAIN_SUMMARY]) }

async function proposal(range: 'lines' | 'file', instruction: string) {
  const svc = new SimCodeService({ workspace_id: WS, task_id: CTX.task_id })
  const ws = (await svc.proxy('GET', `/v1/workspaces/${WS}`, {}, null)) as WorkspaceHead
  const kit = intentsKit(svc, { ctx: CTX })
  const client = kit.client
  const f = (await svc.proxy('GET', `/v1/workspaces/${WS}/files`, { path: 'src/greeting.py' }, null)) as { content: string; digest: string }
  const file: SavedFile = { path: 'src/greeting.py', content: f.content, digest: f.digest }
  const session = new VibeSession({ set: () => 0 as unknown as ReturnType<typeof setTimeout>, clear: () => undefined }, { pollMs: [5] })
  session.setDeps({ client, ctx: CTX, ws, onWorkspace: async () => undefined, turn: kit.turn })
  const lines = { from: f.content.indexOf('def greet'), to: f.content.indexOf('return message') + 'return message'.length }
  await session.ask(instruction, range === 'lines' ? lines : null, file, false, () => 'Anvil', true)
  return { session, client, file }
}

/** The canvas's card for the session's state, with its confirm open, as the page renders it. */
function rendered(session: VibeSession, client: HiveClient, file: SavedFile, caps: Caps = READY): string {
  const noop = () => undefined
  const vibe = {
    ...vibeFields(session, session.getState(), { client, file, dirty: false, caps }),
    ask: async () => undefined,
    choose: noop,
    review: noop,
    send: async () => true as const,
    finish: noop,
    reset: noop,
    undo: async () => undefined, recheck: async () => undefined,
    setReviewing: noop,
    setNote: noop,
  }
  return renderToStaticMarkup(createElement(VibeCard, { vibe, mind: { name: 'Anvil', hue: 280 }, file: file.path, onTest: noop, onDrawer: noop, bottom: 84, phone: false }))
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ')

describe('the rendered confirm says what the person allowed and asked', () => {
  it('lines 4–7: the dialog shows “You allowed Lines 4–7 of src/greeting.py” and the request', async () => {
    const { session, client, file } = await proposal('lines', 'add type hints')
    session.review(file, false, READY)
    expect(session.getState().reviewing).not.toBeNull()
    const t = text(rendered(session, client, file))
    expect(t).toMatch(/You allowed Lines 4–7 of src\/greeting\.py \(the mind could change nothing outside it\)/)
    expect(t).toMatch(/You asked “add type hints”/)
  })
  it('whole file: the dialog says so', async () => {
    const { session, client, file } = await proposal('file', 'use an f-string')
    session.review(file, false, READY)
    const t = text(rendered(session, client, file))
    expect(t).toMatch(/You allowed Whole file: src\/greeting\.py/)
    expect(t).toMatch(/You asked “use an f-string”/)
  })
  it('no confirm is rendered before the person asks for it', async () => {
    const { session, client, file } = await proposal('file', 'use an f-string')
    expect(text(rendered(session, client, file))).not.toMatch(/You allowed Whole file/)
  })
})

describe('the summary’s “why” never claims the service lacks support it could not check', () => {
  it('checking: no why; failed: “couldn’t check”; ready without the feature: “cannot carry one yet”', async () => {
    const { session } = await proposal('file', 'use an f-string')
    expect(session.summary('Anvil', { status: 'checking', features: new Set() })!.why).toBe('')
    const failed = session.summary('Anvil', { status: 'failed', features: new Set() })!.why
    expect(failed).toMatch(/Couldn’t check what the code service supports/)
    expect(failed).not.toMatch(/cannot carry/)
    expect(session.summary('Anvil', { status: 'ready', features: new Set() })!.why).toMatch(/cannot carry one yet/)
  })
  it('and the rendered card shows the same', async () => {
    const { session, client, file } = await proposal('file', 'use an f-string')
    const t = text(rendered(session, client, file, { status: 'failed', key: 'k', features: new Set() }))
    expect(t).toMatch(/Couldn’t check what the code service supports/)
    expect(t).not.toMatch(/cannot carry/)
  })
})
