import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SimClient } from '../../api/sim/SimClient'
import type { ProgramDescription } from '../../api/types'
import { precheckAct } from '../../lib/frameOps'
import { useHive } from '../../store/store'
import { admitFrameAct } from './frameAct'
import { HostConfirmController } from './HostConfirm'

// Kimi next22b/23b r2 #1: a frame's file act (and any confirm act) keeps the host's describe checks before any dialog
// or mint: an unknown action and undeclared params are refused `invalid`; a wrong file type `file-type-refused`; a file
// over the action's max_bytes `too-large`. Each is refused with no dialog, no mint and no call. AppFrame admits every
// `op:'act'` through admitFrameAct (source check below). INVENTED sim data only; nothing leaves the page.

function sim() {
  const s = new SimClient({ seed: 42, latency: false, autoStart: false, historyDays: 1 })
  s.simSession = 'person'
  s.programsHost.installInvented('ledger-fixture')
  return s
}
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)) }
const bytes = (n: number) => new Uint8Array(n).fill(120).buffer as ArrayBuffer
const file = (n = 4, mime = 'text/plain', name = 'invented.txt') => ({ name, mime, bytes: bytes(n) })

let a: SimClient
let d: ProgramDescription
let c: HostConfirmController
beforeEach(async () => {
  vi.stubGlobal('window', { location: { search: '' } })
  a = sim()
  await useHive.getState().init(a)
  d = (await a.program('ledger-fixture')).describe as ProgramDescription
  c = new HostConfirmController({ programId: 'ledger-fixture', swarmId: 's_lyra' })
  c.attach()
})
afterEach(() => {
  c.detach()
  a.disconnect()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Admit a frame body; return the admission plus what was minted, sent or shown. */
function admit(body: Record<string, unknown>, canActFile = true) {
  const mint = vi.spyOn(a, 'confirmAct')
  const send = vi.spyOn(a, 'programAct')
  const shown: unknown[] = []
  const stop = c.subscribe(() => shown.push(c.snapshot()))
  const out = admitFrameAct('ledger-fixture', 's_lyra', body, d, canActFile, c)
  return { out, mint, send, shown, stop }
}

describe('file acts: describe checks before any dialog or mint', () => {
  const refused = async (body: Record<string, unknown>, reason: string) => {
    const r = admit(body)
    expect(r.out).toEqual({ kind: 'refused', reason })
    await flush()
    expect(c.snapshot()).toBeNull()   // no dialog
    expect(r.shown).toEqual([])
    expect(r.mint).not.toHaveBeenCalled()
    expect(r.send).not.toHaveBeenCalled()
    r.stop()
  }
  it('an unknown action is refused `invalid`', () => refused({ action: 'attach-renamed', items: [], file: file() }, 'invalid'))
  it('undeclared params are refused `invalid`', () => refused({ action: 'attach', items: [], params: { junk: 'x' }, file: file() }, 'invalid'))
  it('the wrong file type is refused `file-type-refused`', () => refused({ action: 'attach', items: [], file: file(4, 'application/zip', 'a.zip') }, 'file-type-refused'))
  it('a file over the action’s max_bytes is refused `too-large`', () => refused({ action: 'attach', items: [], file: file(5 * 1024 * 1024 + 1) }, 'too-large'))
  it('a file on an action that takes none is refused `file-not-accepted`', () => refused({ action: 'note', items: [], file: file() }, 'file-not-accepted'))
  it('the refused file’s bytes are released (detached) at once', () => {
    const f = file(4, 'application/zip', 'a.zip')
    admit({ action: 'attach', items: [], file: f }).stop()
    expect(f.bytes.byteLength).toBe(0)
  })
  it('a valid file act (the host’s own focus/stage params allowed) opens exactly one dialog and mints nothing yet', async () => {
    const r = admit({ action: 'attach', items: [], params: { focus: 'n1', stage: 'unfold' }, file: file() })
    expect(r.out.kind).toBe('asked')
    expect(c.snapshot()).toMatchObject({ intent: { body: { action: 'attach', swarm_id: 's_lyra' } }, shown: { file: { name: 'invented.txt', mime: 'text/plain', size: 4 } } })
    expect(r.mint).not.toHaveBeenCalled()
    c.cancelAll()
    r.stop()
  })
})

describe('confirm acts without a file: the same describe checks', () => {
  it('unknown action and undeclared params are refused `invalid` with no dialog and no mint', async () => {
    for (const body of [{ action: 'nope', items: [] }, { action: 'note', items: [], params: { amount: 1 } }]) {
      const r = admit(body)
      expect(r.out).toEqual({ kind: 'refused', reason: 'invalid' })
      await flush()
      expect(c.snapshot()).toBeNull()
      expect(r.mint).not.toHaveBeenCalled()
      expect(r.send).not.toHaveBeenCalled()
      r.stop()
      vi.restoreAllMocks()
    }
  })
  it('a declared confirm act is asked (one dialog); a frame-sent token never reaches the body', () => {
    const r = admit({ action: 'note', items: [], confirm_token: 'hct_from_frame' })
    expect(r.out.kind).toBe('asked')
    expect(c.snapshot()!.intent.body).not.toHaveProperty('confirm_token')
    c.cancelAll()
    r.stop()
  })
  it('describe not known here: the hive stays the authority (no local refusal)', () => {
    expect(precheckAct('anything', { x: 1 }, null)).toBeNull()
  })
  it('declared params pass; a non-object params is invalid', () => {
    const acts = [{ id: 'save', params: { title: 'the title' } }]
    expect(precheckAct('save', { title: 't', focus: null }, acts)).toBeNull()
    expect(precheckAct('save', { title: 't', other: 1 }, acts)).toBe('invalid')
    expect(precheckAct('save', ['x'], acts)).toBe('invalid')
    expect(precheckAct('save', undefined, acts)).toBeNull()
  })
})

describe('AppFrame admits every frame act through admitFrameAct (source check)', () => {
  it('no other act path in AppFrame mints, prepares or asks', async () => {
    const fsName = 'node:fs'
    const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string | URL, e: string) => string }
    const src = fs.readFileSync(new URL('./AppFrame.tsx', import.meta.url), 'utf8')
    expect(src).toMatch(/if \(m\.op === 'act'\) \{\n\s+const admitted = admitFrameAct\(/)
    expect(src).not.toMatch(/prepareConfirm|precheckActFile|\.ask\(/)
  })
})
