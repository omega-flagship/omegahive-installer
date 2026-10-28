/**
 * p2r3 (stand-in FIX-FIRST on p2r2, coordination/omegareview/standin/STANDIN_canvasp2r2_VERDICT_20261007.md), adopting
 * Code's correction 14eafcd3: an apply's completion and a record's reload belong to the context they were issued in.
 * Both tests fail on p2r2 (80a2881) and pass with the correction (receipts code-canvas/p2r3).
 */
import { describe, expect, it, vi } from 'vitest'
import { askConfirm, confirmShowing, onConfirmChange } from '../../../ui/confirm'
import { IterationsReader } from './iterations'
import { LanguageSession, type Ctx, type SavedFile } from './languageSession'

const ALL = new Set(['language-server-queries', 'rename-preview', 'saved-completion-preview'])
const WS = (id: string, generation = 3) => ({ id, generation, tree_digest: 't'.repeat(64), base_commit: 'c' })
const FILE: SavedFile = { path: 'src/a.py', content: 'def greet(n):\n    return greet(n)\n', digest: 'd'.repeat(64) }
const INV = { servers: [{ id: 'py', extensions: ['.py'], configured: true, executable_present: true }] }
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('P1: an apply started in context A never lands in B', () => {
  it('a rename applied under A, switched to B in flight: B’s workspace handler is never called with A’s result', async () => {
    let release!: (v: unknown) => void
    const late = new Promise((r) => (release = r))
    const call = vi.fn(async (method: string, path: string, body?: unknown) => {
      const b = (body ?? {}) as Record<string, unknown>
      if (path.endsWith('/language/servers')) return INV
      if (path.endsWith('/language') && b.feature === 'rename') return { result: { preview_id: 'rp_1', edits: [{ path: 'src/a.py', expected_digest: 'd', content: FILE.content.replace(/greet/g, 'hello') }] } }
      if (path.endsWith('/renames')) return late
      throw new Error(`unexpected ${method} ${path}`)
    }) as unknown as Ctx['call']
    const onA = vi.fn(async () => undefined)
    const onB = vi.fn(async () => undefined)
    const ls = new LanguageSession()
    ls.setContext({ key: 'A', call, ws: WS('ws_a'), features: ALL }, onA)
    await flush()
    await ls.previewRename(FILE, false, 4, 'greet', 'hello')
    expect(ls.getState().rename?.preview.preview_id).toBe('rp_1')
    const applying = ls.applyRename()
    ls.setContext({ key: 'B', call, ws: WS('ws_b'), features: ALL }, onB)
    release({ workspace: WS('ws_a', 4) })
    await applying
    await flush()
    expect(onB).not.toHaveBeenCalled()
    expect(onA).not.toHaveBeenCalled()
  })
})

describe('P2: a late record continuation from A never resets the reader to A', () => {
  it('switched to B, then A’s captured load runs: the reader stays on B and nothing is read for A', async () => {
    const reader = new IterationsReader()
    reader.setContext('A')
    reader.setContext('B')
    const call = vi.fn(async () => ({ events: [] }))
    await reader.load('A', call as never, 'ws_a')
    expect(reader.getState().ctx).toBe('B')
    expect(call).not.toHaveBeenCalled()
  })
})

describe('Kimi p2r3 hardening: a confirm ends with the lifetime that asked it', () => {
  it('aborting the caller’s signal answers its open question “no”', async () => {
    const life = new AbortController()
    const asked = askConfirm('Keep the record?', 'Keep the record', { signal: life.signal })
    life.abort()
    await expect(asked).resolves.toBe(false)
  })
  it('an aborted earlier lifetime never answers a newer question', async () => {
    const old = new AbortController()
    const first = askConfirm('first?', 'OK', { signal: old.signal })
    let settled = false
    const second = askConfirm('second?', 'OK').then((v) => ((settled = true), v))
    await expect(first).resolves.toBe(false)
    old.abort()
    await flush()
    expect(settled).toBe(false)
    askConfirm('third?', 'OK') // replaces the second, answering it no
    await expect(second).resolves.toBe(false)
  })
  it('an already-aborted signal answers at once without asking', async () => {
    const gone = new AbortController()
    gone.abort()
    await expect(askConfirm('late?', 'OK', { signal: gone.signal })).resolves.toBe(false)
  })
})

describe('p2r4 stand-in: an already-ended lifetime never disturbs the question on screen', () => {
  it('an already-aborted call answers only itself; the existing dialog stays up and unanswered', async () => {
    let first: boolean | undefined
    const asked = askConfirm('Keep the record?', 'Keep the record').then((v) => (first = v))
    const gone = new AbortController()
    gone.abort()
    await expect(askConfirm('late?', 'OK', { signal: gone.signal })).resolves.toBe(false)
    await flush()
    expect(confirmShowing()).toBe('Keep the record?')
    expect(first).toBeUndefined()
    askConfirm('next?', 'OK') // tidy: replaces (answers) the first
    await asked
  })
  it('an abort mid-dialog clears the dialog and tells the host', async () => {
    const life = new AbortController()
    const heard = vi.fn()
    const off = onConfirmChange(heard)
    const asked = askConfirm('Keep the record?', 'Keep the record', { signal: life.signal })
    heard.mockClear()
    life.abort()
    await expect(asked).resolves.toBe(false)
    expect(confirmShowing()).toBeNull()
    expect(heard).toHaveBeenCalled()
    off()
  })
})
