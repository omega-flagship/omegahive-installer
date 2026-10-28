/**
 * p2r2 (stand-in Review FIX-FIRST on a921ef9, coordination/omegareview/standin/STANDIN_canvasp2_VERDICT_20261006.md):
 * behavioural tests through what the canvas runs (LanguageSession is what useLanguage renders; RenameCard is the
 * canvas's own preview; IterationsReader is what the drawer renders). Each fix is shown load-bearing by removing it
 * with every module present (receipts p2r2/M*.txt).
 */
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-dom', async (orig) => ({ ...(await orig<typeof import('react-dom')>()), createPortal: (node: ReactNode) => node }))
;(globalThis as { document?: unknown }).document ??= { body: {}, activeElement: null, addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [] }
;(globalThis as { HTMLElement?: unknown }).HTMLElement ??= class {}

import { readAllIterations, IterationsReader } from './iterations'
import { RenameCard } from './LanguageParts'
import { LanguageSession, renameViews, type Ctx, type RenameState, type SavedFile } from './languageSession'
import type { useLanguage } from './useLanguage'

const ALL = new Set(['language-server-queries', 'rename-preview', 'saved-completion-preview'])
const WS = (id: string, generation = 3) => ({ id, generation, tree_digest: 't'.repeat(64), base_commit: 'c' })
const FILE: SavedFile = { path: 'src/a.py', content: 'def greet(n):\n    return greet(n)\n', digest: 'd'.repeat(64) }
const INV = { servers: [{ id: 'py', extensions: ['.py'], configured: true, executable_present: true }] }
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
function deferred<T>() {
  let open!: (v: T) => void
  const p = new Promise<T>((r) => (open = r))
  return { p, open }
}

/** A fake service: the inventory, a rename preview, completion queries/previews; applies are recorded. */
function service(over: Partial<Record<string, (body: Record<string, unknown>) => Promise<unknown>>> = {}) {
  const posts: { path: string; body: Record<string, unknown> }[] = []
  const call = vi.fn(async (method: string, path: string, body?: unknown) => {
    const b = (body ?? {}) as Record<string, unknown>
    if (method === 'POST') posts.push({ path, body: b })
    if (path.endsWith('/language/servers')) return over.servers ? over.servers(b) : INV
    if (path.endsWith('/language') && b.feature === 'rename') return { result: { preview_id: 'rp_1', edits: [{ path: 'src/a.py', expected_digest: 'd', content: FILE.content.replace(/greet/g, 'hello') }] } }
    if (path.endsWith('/language') && b.feature === 'completion') return over.completion ? over.completion(b) : { completion_query_id: 'cq_1', result: { items: [{ label: 'greet' }] } }
    if (path.endsWith('/completion-previews')) return over.preview ? over.preview(b) : { id: `cp_${b.query_id}`, label: 'greet', path: 'src/a.py', edits: [{ path: 'src/a.py', expected_digest: 'd', content: FILE.content + 'greet\n' }] }
    if (path.endsWith('/renames') || path.endsWith('/completion-applies')) return { workspace: WS('ws_a', 4) }
    throw new Error(`unexpected ${method} ${path}`)
  })
  return { call: call as unknown as Ctx['call'], posts, raw: call }
}
const ctx = (call: Ctx['call'], key = 'A', ws = WS('ws_a'), features: ReadonlySet<string> = ALL): Ctx => ({ key, call, ws, features })
const applies = (posts: { path: string }[]) => posts.filter((p) => p.path.endsWith('/renames') || p.path.endsWith('/completion-applies'))

describe('P1-1: a language preview never outlives the context or capabilities that made it', () => {
  it('a rename previewed under context A is dropped at once on B (same generation) and never applied there', async () => {
    const s = service()
    const ls = new LanguageSession()
    ls.setContext(ctx(s.call))
    await flush()
    await ls.previewRename(FILE, false, 4, 'greet', 'hello')
    expect(ls.getState().rename?.preview.preview_id).toBe('rp_1')
    ls.setContext(ctx(s.call, 'B', WS('ws_b')))
    expect(ls.getState().rename).toBeNull()
    await ls.applyRename()
    expect(applies(s.posts)).toEqual([])
  })
  it('when the service stops declaring rename (same context), the preview is blocked and Rename refuses without sending', async () => {
    const s = service()
    const ls = new LanguageSession()
    ls.setContext(ctx(s.call))
    await flush()
    await ls.previewRename(FILE, false, 4, 'greet', 'hello')
    ls.setContext(ctx(s.call, 'A', WS('ws_a'), new Set(['language-server-queries'])))
    expect(ls.renameBlocked() ?? 'nothing blocks it').toMatch(/no longer says it supports renaming/)
    await ls.applyRename()
    expect(applies(s.posts)).toEqual([])
    expect(ls.getState().note).toMatch(/not applied/)
  })
  it('a completion previewed under A is dropped on a moved candidate and never applied', async () => {
    const s = service()
    const ls = new LanguageSession()
    ls.setContext(ctx(s.call))
    await flush()
    await ls.complete(FILE, false, 5)
    await ls.choose(0, FILE)
    expect(ls.getState().completion?.preview?.id).toBe('cp_cq_1')
    ls.setContext(ctx(s.call, 'A', WS('ws_a', 4)))
    expect(ls.getState().completion).toBeNull()
    await ls.applyCompletion()
    expect(applies(s.posts)).toEqual([])
  })
})

describe('P1-2: the server inventory is keyed and fail closed', () => {
  it('on a new context nothing is offered until ITS inventory answers; a late answer for the old one is dropped', async () => {
    const late = deferred<unknown>()
    const next = deferred<unknown>()
    let n = 0
    const s = service({ servers: () => (n++ === 0 ? Promise.resolve(INV) : n === 2 ? late.p : next.p) })
    const ls = new LanguageSession()
    ls.setContext(ctx(s.call))
    await flush()
    expect(ls.offer('src/a.py')).toEqual({ definition: true, rename: true, completion: true })
    ls.setContext(ctx(s.call, 'B', WS('ws_b'))) // B's read is pending
    expect(ls.offer('src/a.py')).toEqual({ definition: false, rename: false, completion: false })
    ls.setContext(ctx(s.call, 'C', WS('ws_c')))
    late.open(INV) // B answers late
    await flush()
    expect(ls.server('src/a.py')).toBeNull()
    next.open({ servers: [] }) // C has no server
    await flush()
    expect(ls.server('src/a.py')).toBeNull()
  })
  it('a server not declared configured is not offered', async () => {
    const s = service({ servers: async () => ({ servers: [{ id: 'py', extensions: ['.py'], configured: false, executable_present: true }] }) })
    const ls = new LanguageSession()
    ls.setContext(ctx(s.call))
    await flush()
    expect(ls.server('src/a.py')).toBeNull()
  })
})

describe('P1-3: the rename preview shows every edit, exactly', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ line: i + 1, from: i * 10, to: i * 10 + 5, before: `    greet(${i})  `, after: `    hello(${i})  ` }))
  const state: RenameState = { ctx: 'x', from: 'greet', to: 'hello', preview: { preview_id: 'rp_9', edits: [] }, files: [{ path: 'src/a.py', changes: many(15) }], generation: 1, tree_digest: 't' }
  const lang = { rename: state, busy: null, renameBlocked: null, setRename: () => undefined, applyRename: async () => true } as unknown as ReturnType<typeof useLanguage>
  it('all 15 changes of a file are rendered before the confirm, each before and after with its whitespace', () => {
    const html = renderToStaticMarkup(createElement(RenameCard, { lang, phone: false, bottom: 84, open: () => undefined }))
    expect(html.match(/data-rename-change/g)?.length).toBe(15)
    expect(html).toContain('+     hello(14)  ')
    expect(html).toContain('−     greet(14)  ')
    expect(html).not.toContain("more</li>")
  })
  it('drawn in place, a change keeps its exact text', () => {
    expect(renameViews(state, 'src/a.py')[14].after).toBe('    hello(14)  ')
  })
})

describe('P1-4: a late completion answer never attaches to another query', () => {
  it('A dismissed, B started (same item 0): A’s late preview is dropped; B gets only its own', async () => {
    const a = deferred<unknown>()
    let q = 0
    const s = service({
      completion: async () => ({ completion_query_id: `cq_${++q}`, result: { items: [{ label: 'greet' }] } }),
      preview: (b) => (b.query_id === 'cq_1' ? a.p : Promise.resolve({ id: 'cp_B', label: 'greet', path: 'src/a.py', edits: [{ path: 'src/a.py', expected_digest: 'd', content: FILE.content + 'B\n' }] })),
    })
    const ls = new LanguageSession()
    ls.setContext(ctx(s.call))
    await flush()
    await ls.complete(FILE, false, 5)
    const chooseA = ls.choose(0, FILE)
    ls.clearCompletion()
    await ls.complete(FILE, false, 5)
    expect(ls.getState().completion?.query.query_id).toBe('cq_2')
    a.open({ id: 'cp_A', label: 'greet', path: 'src/a.py', edits: [{ path: 'src/a.py', expected_digest: 'd', content: FILE.content + 'A\n' }] })
    await chooseA
    expect(ls.getState().completion?.preview).toBeNull()
    await ls.choose(0, FILE)
    expect(ls.getState().completion?.preview?.id).toBe('cp_B')
  })
})

describe('P2-5: iterations are read in full and fenced to their context', () => {
  const ev = (seq: number, kind = 'iteration.observation') => ({ seq, kind, body: kind === 'iteration.observation' ? { id: `iteration_${seq}`, created_at: seq, author: 'user:you', digest: 'd' } : {} })
  it('pages the whole journal by its cursor and lists every record once, newest first', async () => {
    const pages: Record<string, unknown> = {
      '0': { events: Array.from({ length: 200 }, (_, i) => ev(i + 1, i % 2 ? 'run.started' : 'iteration.observation')) },
      '200': { events: Array.from({ length: 200 }, (_, i) => ev(i + 201)) },
      '400': { events: [ev(401), ev(400)] },
    }
    const call = vi.fn(async (_m: string, _p: string, _b: unknown, q: Record<string, string>) => pages[q.after] ?? { events: [] })
    const r = await readAllIterations(call as never, 'ws_a')
    expect(call).toHaveBeenCalledTimes(3)
    expect(r.items).toHaveLength(100 + 200 + 1)
    expect(r.items[0].id).toBe('iteration_401')
  })
  it('a late list or record for an earlier context is never shown in the new one', async () => {
    const slow = deferred<unknown>()
    const reader = new IterationsReader()
    const callA = vi.fn(async (_m: string, p: string) => (p === '/v1/events' ? slow.p : { record: {}, content: {} }))
    reader.setContext('A')
    const loading = reader.load('A', callA as never, 'ws_a')
    expect(callA).toHaveBeenCalled()
    reader.setContext('B')
    slow.open({ events: [ev(1)] })
    await loading
    expect(reader.getState()).toMatchObject({ ctx: 'B', items: null, open: null })
  })
})
