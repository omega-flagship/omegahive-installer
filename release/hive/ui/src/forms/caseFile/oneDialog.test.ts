import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SimClient } from '../../api/sim/SimClient'
import type { ProgramAction, ProgramDescription } from '../../api/types'
import { HostConfirmController } from '../../features/programs/HostConfirm'
import { prepareConfirm } from '../../lib/hostConfirm'
import { useHive } from '../../store/store'
import { consentParams, type Draft } from '../lifeMap/useAtlas'
import { ActionSheet, sheetContext, sheetParams, takesHostConfirm } from './parts'
import type { CaseState, Sheet } from './useCase'

// Kimi next22b/23b r2 #2: one dialog per form act. A form's own full-context confirm (the case file's sheet, the life
// map's consent envelope) is THE confirm: it shows what the act sends and tells the host `confirmed`, so the host mints
// at once and never shows its own dialog on top. INVENTED sim data only; nothing leaves the page.

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)) }
let a: SimClient
let d: ProgramDescription
beforeEach(async () => {
  vi.stubGlobal('window', { location: { search: '' } })
  a = new SimClient({ seed: 42, latency: false, autoStart: false, historyDays: 1 })
  a.simSession = 'person'
  a.programsHost.installInvented('ledger-fixture')
  await useHive.getState().init(a)
  d = (await a.program('ledger-fixture')).describe as ProgramDescription
})
afterEach(() => {
  a.disconnect()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const note = (): ProgramAction => ({ id: 'note', label: 'Note', confirm: true, params: { text: 'what the note says' } })
const sheetOf = (action: ProgramAction, gate: Sheet['gate'] = null): Sheet => ({ action, items: ['n1'], gate, viaKey: false, seq: 1 })
const cs = { byId: new Map(), closeSheet: () => undefined, run: async () => ({ status: 'done' }), running: null } as unknown as CaseState

/** The host's side of a form act, exactly as ProgramForm does it (source check below): preconfirmed from ctx. */
async function hostSide(ctx: { confirmed?: true }, params?: Record<string, string>) {
  const c = new HostConfirmController({ programId: 'ledger-fixture', swarmId: 's_lyra' })
  c.attach()
  const shown: unknown[] = []
  const stop = c.subscribe(() => shown.push(c.snapshot()))
  const mint = vi.spyOn(a, 'confirmAct')
  const deliver = vi.spyOn(a.programsHost, 'act')
  const p = prepareConfirm('ledger-fixture', { swarm_id: 's_lyra', action: 'note', items: [], params }, d)
  if (!p.ok) throw new Error(p.message)
  const f = c.ask(p.intent, {}, { preconfirmed: ctx.confirmed === true })
  await flush()
  return { c, shown, stop, mint, deliver, f }
}

describe('case file: an action that takes the host confirm is confirmed once, in the sheet', () => {
  it('the sheet is the confirm: armed later, shows what it sends, labelled Confirm; one dialog in the markup', () => {
    expect(takesHostConfirm(note())).toBe(true)
    const html = renderToStaticMarkup(createElement(ActionSheet, { sheet: sheetOf(note()), cs, revision: 'r7', m: 'glass' }))
    expect(html.match(/role="dialog"/g)).toHaveLength(1)
    expect(html).toMatch(/aria-disabled="true"[^>]*>Confirm</)   // not armed on first paint
    expect(html).toContain('Sends')
    expect(html).toContain('note')
    expect(html).toContain('Revision r7')
    expect(html).toContain('you are not asked a second time')
  })
  it('sheetContext tells the host `confirmed` for a host-confirm action (gated or not) and for any gated one; never for a plain one', () => {
    expect(sheetContext(sheetOf(note()), 'r7')).toEqual({ baseRevision: 'r7', confirmed: true })
    expect(sheetContext(sheetOf({ id: 'correct', params: { text: 't' } }), 'r7')).toEqual({ baseRevision: 'r7' })
    const gate = { kind: 'durable', who: 'You', cost: 'None.', deadline: 'Immediate.', disclosure: null } as Sheet['gate']
    expect(sheetContext(sheetOf({ id: 'correct' }, gate), 'r7')).toEqual({ baseRevision: 'r7', confirmed: true })
    expect(sheetParams({ text: ' hello ', note: '  ' })).toEqual({ text: ' hello ' })
    expect(sheetParams({ text: '' })).toBeUndefined()
  })
  it('the act after the sheet: no host dialog at all, exactly one mint and one delivery', async () => {
    const h = await hostSide(sheetContext(sheetOf({ ...note(), params: undefined }), 'r7'))
    expect(await h.f).toMatchObject({ kind: 'done' })
    expect(h.shown.filter(Boolean)).toEqual([])   // the host's dialog never appeared
    expect(h.mint).toHaveBeenCalledTimes(1)
    expect(h.deliver).toHaveBeenCalledTimes(1)
    h.stop()
  })
  it('without the form’s confirm the host asks: one dialog (its own), and nothing is minted until the press', async () => {
    const h = await hostSide({})
    expect(h.shown.filter(Boolean)).toHaveLength(1)
    expect(h.mint).not.toHaveBeenCalled()
    h.c.cancelAll()
    h.stop()
  })
})

describe('life map: the consent envelope is the one confirm and sends exactly what it shows', () => {
  const draft: Draft = { action: 'investigate', items: ['h1'], worker: 'scientist-x', question: 'Does the invented record bear on it?', budget: 600, expiryMs: 86_400_000, reason: '', viaKey: false, source: { revision: 'r3', scope: ['h1'] } }
  it('consentParams is a pure function of the open envelope: the dialog and the send see the same values', () => {
    const g = { digest: 'abcd1234', openedAt: 1_700_000_000_000 }
    const p = consentParams(draft, g)
    expect(p).toEqual({ worker_id: 'scientist-x', question: 'Does the invented record bear on it?', budget_seconds: 600, expires_at: 1_700_086_400, idempotency_key: `atlas-form-abcd1234-${g.openedAt.toString(36)}` })
    expect(consentParams(draft, g)).toEqual(p)   // nothing is made at send time
    expect(consentParams({ ...draft, action: 'revoke-request', digest: 'd1', reason: ' no longer needed ' }, g)).toEqual({ request_digest: 'd1', reason: 'no longer needed' })
  })
  it('source check: the send uses consentParams with `confirmed`, the dialog renders consentParams, ProgramForm skips its dialog only on `confirmed`', async () => {
    const fsName = 'node:fs'
    const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string | URL, e: string) => string }
    const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8')
    const atlas = read('../lifeMap/useAtlas.ts')
    expect(atlas).toMatch(/const params = consentParams\(draft, r\.gate\)/)
    expect(atlas).toMatch(/run\('investigate', draft\.items, params, ctx\)/)
    expect(atlas).toMatch(/run\(draft\.action, draft\.items, params, ctx\)/)
    expect(atlas).not.toMatch(/Date\.now\(\) \+ draft\.expiryMs/)
    expect(read('../lifeMap/parts.tsx')).toMatch(/paramsSummary\(consentParams\(draft, gate\)\)/)
    expect(read('./parts.tsx')).toMatch(/cs\.run\(action, items, sheetParams\(values\), sheetContext\(sheet, inspected\.current\)\)/)
    expect(read('../../features/programs/ProgramForm.tsx')).toMatch(/ask\(p\.intent, \{\}, \{ preconfirmed: ctx\?\.confirmed === true \}\)/)
  })
})
