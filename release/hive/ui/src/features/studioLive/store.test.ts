import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { useHive } from '../../store/store'
import { useAskStore } from '../../store/ask'
import { sha256Hex } from './api'
import { checkAskEvent } from '../../api/ask'
import { DrawingSessionView, projectDrawingSession } from './DirectingStudio'
import { askMind } from '../ask/mind'
import {
  attachFrame, confirmSetup, detachFrame, frameOutcome, framePiece, proposeSetup, resetStudioLiveForTests, stopSession, useStudioLive, type SetupProposal,
  setDirectionMode, drawingTurnAssociation, steerSession, runtimeForTests,
} from './store'
import { studioRoute } from './route'
import type { FrameReport } from './outcomes'

/**
 * J3 r4.3 O3: the session's bindings, end to end through the store with a fake host. INVENTED values only.
 * Covers case #3 (stale setup card), Stop ordering (local before host), identity close-first, Design O3 finding P1 #2
 * (old-mount reports never re-sent) and the admitted-stream hold.
 */

const H = (c: string) => c.repeat(64)
const bump = () => useHive.setState({ inits: useHive.getState().inits + 1 })   // a sign-in change (identity epoch)
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
/** waits (bounded, macrotask turns) until a condition holds; never a timed sleep */
const until = async (cond: () => boolean) => { for (let i = 0; i < 50 && !cond(); i++) await settle() }
/** settles the fake host's chains: macrotask turns (crypto.subtle digests resolve outside the microtask queue), bounded */
const settle = async () => { for (let i = 0; i < 8; i++) { await flush(); await new Promise((r) => setTimeout(r, 0)) } await flush() }

const proposal: SetupProposal = {
  operation_id: 'op_inv1',
  request: { swarm_id: 's_x', program_id: 'omegadesign', app_pin: { id: 'omegadesign' }, maker_id: 'a_m', title: 'Invented poster', detail: 'invented', piece: { scene_id: 'sim-poster', source_ref: null }, key_id: 'k1', model: 'invented-model', role_id: null, tools: [], cap_usd: 2, step_cap_usd: 0.25, coordinator_exclusive: false, max_steps: 12, window_minutes: 60 },
  consent: { schema: 'omega-studio-consent-1', swarm_id: 's_x', program_id: 'omegadesign', app_pin: { id: 'omegadesign' }, maker_id: 'a_m', model: 'invented-model', key_id: 'k1', role_id: null, tools: [], payer: 'own_key', monthly: { kind: 'own_key_limit', limit_micros: 10_000_000 }, cap_micros: 2_000_000, step_cap_micros: 250_000, step_window_s: 180, max_steps: 12, window_minutes: 60, piece: { scene_id: 'sim-poster', source_ref: null }, coordinator_exclusive: false, title: 'Invented poster', detail: 'invented', disclosures: ['maker_restarts_between_steps', 'maker_reads_unsaved_piece_while_live'] },
  consent_digest: `sha256:${'c'.repeat(64)}`,
  maker_name: 'Invented maker', key_label: 'invented key', audience: 'only you', month_left_micros: 6_000_000,
}
let log: string[]
let steerCalls: { operation: string; at: number }[]

/** Actual producer domains are deliberately distinct; the event is validated by the real current Ask reader. */
function retainedTurn(operation = 'op_inv1', turn = 'at_inv1', principal = 'user:p_a') {
  const event = checkAskEvent({ type: 'ask', operation_id: operation, turn_id: turn, principal, seq: 1, phase: 'accepted', at: '2026-10-29T00:00:00Z', thread: { id: 'thread_inv1', mind: { id: 'omega_wren', name: 'Wren' }, budget_usd: 5, spent_usd: 0 }, acting_as: { mind_id: 'omega_wren', name: 'Wren' } })
  if (!event) throw new Error('Synthetic retained Ask frame must satisfy the real reader')
  return { op: operation, you: 'Invented drawing request', state: 'open' as const, lastSeq: 1, events: [event], ahead: [], outcomes: {}, notes: [], steers: [], moves: 0, tookOver: false, presence: 0, actingAs: { mind_id: 'omega_wren', name: 'Wren' } }
}

/** Current-state adapter, NOT an SSR-hook override. Browser subscriptions/mounted integration remain separate. */
function renderCurrentSession() {
  const projection = projectDrawingSession(useStudioLive.getState(), useAskStore.getState(), useHive.getState().client)
  expect(projection.s.ledger).not.toBeNull()
  const html = renderToStaticMarkup(createElement(DrawingSessionView, { projection, edit: null, toggleEdit: () => undefined }))
  expect(html.length).toBeGreaterThan(0)
  expect(html).toContain(`data-studio-session="${projection.s.ledger!.state}"`)
  expect(html).toContain('Directing Create')
  return html
}
/** r1.13: what the fake host lists in the person's Studio space, and each canvas's current scene id */
let listed: { artifact_id: string; kind: string; title: string; revision: number; digest: string }[] = []
let sceneOf: Record<string, string> = {}
let ledgerRaw: Record<string, unknown>
let onRecord: (() => void) | null
let pieceSeq: number
let mountEpoch: number | null
let recorded: Record<string, unknown>[]
let submitFails: unknown[]
const fsRead = ((await import(/* @vite-ignore */ 'node:' + 'fs')) as unknown as { readFileSync(p: string, e: 'utf8'): string }).readFileSync
const store = new Map<string, string>()
vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) })
const offer = (on: boolean) => useAskStore.setState({ settings: { swarm_id: null, thread_budget_usd: 5, capabilities: { conductor: false, memory: false, studio_sessions: on, studio_directions: on } } } as never)
function fakeClient() {
  return {
    mode: 'live',
    subscribe: () => () => undefined,
    studioRecordIntent: async (_op: string, b: { request: Record<string, unknown> }) => { log.push('host:record'); recorded.push(b.request); onRecord?.(); return { intent_id: 'ai_studio1' } },
    askSubmitIntent: async () => { log.push('host:submit'); if (submitFails.length) throw submitFails.shift(); return { session_id: 'ss_a', stream_id: 'as_aaaaaaaaaaaaaaaaaaaaaaaa', goal_id: 'g_a', proposal_artifact_id: 'ar_p', state: 'active', maker_id: 'a_m', payer: 'you', cap_usd: 2, step_cap_usd: 0.25 } },
    studioSession: async () => ledgerRaw,
    // r1.14d: `hostPrefix` answers as the real host does (studio_steps upload: body_sha256 = "sha256:<hex>")
    studioPiece: async (_sid: string, b: { seq: number; body: string }) => { log.push(`host:piece:${b.seq}`); if (pieceGate) await pieceGate; pieceSeq = b.seq; const h = `${hostPrefix ? 'sha256:' : ''}${await sha256Hex(b.body)}`; (ledgerRaw as { piece: unknown }).piece = { seq: b.seq, body_sha256: h, scene_ref: null, at: null }; return { seq: b.seq, body_sha256: h } },
    studioOutcome: async (_sid: string, n: number, b: { receiver_generation: number }) => { log.push(`host:outcome:${n}:gen${b.receiver_generation}`); outcomeBodies.push(b as unknown as Record<string, unknown>); return { n } },
    studioControl: async (_sid: string, b: { action: string }) => { log.push(`host:control:${b.action}`); return {} },
    askSteer: async (operation: string, b: { steer_id: string; text: string; at_seq: number }) => { steerCalls.push({ operation, at: b.at_seq }); if (operation !== 'op_inv1') throw new Error('Ask endpoint requires the operation selector, never the server turn selector'); log.push(`host:steer:${b.text}`); (ledgerRaw.directions as unknown[]).push({ seq: 1, steer_id: b.steer_id, state: 'queued' }); return { steer_id: b.steer_id, operation_id: operation, turn_id: 'at_inv1', new_turn: false, studio: { session_id: 'ss_a', seq: 1, state: 'queued' } } },
    studioMount: async (_sid: string, b: { expected_epoch: number | null }) => {
      log.push(`host:mount:${b.expected_epoch}`)
      if (b.expected_epoch !== mountEpoch) { const { ApiError } = await import('../../api/client'); throw new ApiError(409, 'mount_conflict', 'x') }
      mountEpoch = (mountEpoch ?? 0) + 1
      ledgerRaw.mount_epoch = mountEpoch
      return { mount_epoch: mountEpoch, mount_token: `mt_${String(mountEpoch).repeat(24)}`, lease_expires_at: new Date(Date.now() + 60_000).toISOString() }
    },
    studioMountHeartbeat: async () => ({}),
    studioMountReadback: async () => ({ attempt: null }),
    // r1.13: the person's saved canvases and Studio's view of one exact canvas (the call-time re-read of the pick)
    studioMaker: async () => { log.push('host:setup-maker'); return { maker: { id: 'a_m', swarm_id: 's_mystudio' } } },
    swarmArtifacts: async (sw: string, o: { kind?: string }) => { log.push(`host:list:${sw}:${o.kind}`); return listed },
    programView: async (_id: string, b: { swarm_id: string; focus?: string }) => {
      log.push(`host:view:${b.swarm_id}`)
      const ref = JSON.parse(String(b.focus).slice('studio-source:'.length))
      return { revision: 'r', items: [{ id: 'editable-source', kind: 'status', label: 'x', data: { reference: ref, source: { schema: 'omega-studio-source-1', current: { scene: { id: sceneOf[ref.artifact_id] ?? 'scene_inv' }, revision: 1, digest: 'sha256:s' }, history: [] } } }], links: [] }
    },
    studioUnmount: async () => { log.push('host:unmount'); return {} },
  }
}
let posts: { mount: number; msg: Record<string, unknown> }[] = []
const port = (mount: number) => ({ mount, programId: 'omegadesign', swarmId: 's_x', post: (m: object) => { posts.push({ mount, msg: m as Record<string, unknown> }); log.push(`frame${mount}:${(m as { type: string }).type}`) } })
/** a published step (sim of the host ledger): proposal revision n, optionally with the maker-read tuple */
const addStep = (n: number, extra: Record<string, unknown> = {}) => (ledgerRaw.steps as unknown[]).push({ n, state: 'finished', proposal_n: n, proposal_digest: `sha256:${H(String(n))}`, direction_seqs: [], ...extra })
let pieceGate: Promise<void> | null = null
let hostPrefix = false
let outcomeBodies: Record<string, unknown>[] = []
const ref = (rev: number) => ({ scene_id: 'sim-poster', revision: rev, digest: `sha256:${H('d')}` })
const report = (mount: number, gen: number): FrameReport => ({ proposal: { artifact_id: 'ar_p', revision: 1, digest: `sha256:${H('1')}` }, outcome: 'refused', reason: 'conflict', piece_before: ref(2), piece_after: ref(2), receiver_generation: mount, receipt_digest: H('r'), observed_generation: gen, op_ids: ['op-a'] })
const capture = (gen: number) => ({ body: `{"invented":${gen}}`, scene_ref: ref(2), edit_generation: gen, pending_fields: false })

async function started() {
  proposeSetup(proposal)
  await confirmSetup()
  await settle()
  expect(useStudioLive.getState().ledger?.session_id).toBe('ss_a')
}

beforeEach(() => {
  log = []
  steerCalls = []
  listed = [{ artifact_id: 'ar_inv_piece', kind: 'studio-source', title: 'Invented canvas', revision: 2, digest: 'sha256:piece' }]
  sceneOf = {}
  onRecord = null
  pieceSeq = 0
  mountEpoch = null
  posts = []
  pieceGate = null
  hostPrefix = false
  outcomeBodies = []
  recorded = []
  submitFails = []
  store.clear()
  ledgerRaw = {
    session_id: 'ss_a', stream_id: 'as_aaaaaaaaaaaaaaaaaaaaaaaa', state: 'active', ask_turn_id: 'at_inv1', goal_id: 'g_a', proposal_artifact_id: 'ar_p', maker_id: 'a_m', swarm_id: 's_x', program_id: 'omegadesign', scene_id: 'sim-poster',
    steps: [], directions: [], budget: {}, stop: { state: 'none' }, piece: null,
  }
  useHive.setState({ client: fakeClient() as never })
  useAskStore.setState({ bound: { session: 'inv', principal: 'user:p_a', auth: null }, log: [], turns: { op_inv1: retainedTurn() } } as never)
  offer(true)
  resetStudioLiveForTests()
})
afterEach(() => {
  try { expect(steerCalls.filter((c) => c.operation !== 'op_inv1')).toEqual([]) }
  finally { resetStudioLiveForTests() }
})

describe('case #3: a setup card belongs to the sign-in it was shown under', () => {
  it('a sign-in change after the card was shown: the card is gone for the new person and Start sends nothing', async () => {
    proposeSetup(proposal)
    bump()
    expect(useStudioLive.getState().setup).toBeNull()   // the new person never sees the earlier person's card
    await confirmSetup()
    expect(log).toEqual([])
  })
  it('a sign-in change between record and submit: the submit is never sent with the new bearer', async () => {
    onRecord = bump
    proposeSetup(proposal)
    await confirmSetup()
    expect(log).toEqual(['host:record'])
  })
  it('the card’s page went away (unmount): Start asks to confirm again and sends nothing', async () => {
    let alive = true
    proposeSetup(proposal, () => alive)
    alive = false
    await confirmSetup()
    expect(log).toEqual([])
    expect(useStudioLive.getState().setup?.state).toBe('needs-reconfirm')
  })
})

describe('the mounted session', () => {
  it('opens the frame only with the host-admitted stream and scene; without them it holds', async () => {
    delete ledgerRaw.stream_id
    await started()
    attachFrame(port(1))
    await settle()
    expect(log.filter((x) => x.startsWith('frame'))).toEqual([])
    expect(useStudioLive.getState().openHold).toMatch(/drawing stream/)
  })
  it('Stop: local receiving closes (a frame message) BEFORE the one host stop; the same control id on a retry', async () => {
    await started()
    attachFrame(port(1))
    await settle()
    expect(log).toContain('frame1:studio-live-open')
    log = []
    const p = stopSession()
    expect(log[0]).toBe('frame1:studio-live-close')   // synchronously, before anything awaits
    expect(useStudioLive.getState().local).toBe('stopped')
    await p
    expect(log).toEqual(['frame1:studio-live-close', 'host:control:stop'])
  })
  it('a sign-in change closes receiving synchronously, and nothing more is written for that session', async () => {
    await started()
    attachFrame(port(1))
    await settle()
    log = []
    bump()
    expect(log).toEqual(['frame1:studio-live-close'])
    framePiece(1, 'ss_a', capture(5))
    frameOutcome(1, 'ss_a', report(1, 5))
    await settle()
    expect(log).toEqual(['frame1:studio-live-close'])
  })
  it('Design O3 P1 #2: an old mount’s held report is retired, never re-sent under the new mount; the new mount’s report progresses', async () => {
    await started()
    attachFrame(port(1))
    await settle()
    addStep(1)
    frameOutcome(1, 'ss_a', report(1, 9))            // held: no acknowledged upload with generation 9 yet
    await settle()
    detachFrame(1)
    attachFrame(port(2))
    await settle()
    framePiece(2, 'ss_a', capture(9))                 // the new mount uploads a piece with that generation
    await until(() => useStudioLive.getState().remount === 'recovered')
    expect(pieceSeq).toBe(1)
    expect(useStudioLive.getState().remount).toBe('recovered')
    log = []
    addStep(2)                                        // proposed after the reopened view recovered (k = 1)
    frameOutcome(2, 'ss_a', { ...report(2, 9), proposal: { artifact_id: 'ar_p', revision: 2, digest: `sha256:${H('2')}` } })
    await settle()
    const st = useStudioLive.getState()
    expect(log.filter((x) => x.startsWith('host:outcome'))).toEqual(['host:outcome:2:gen2'])   // only the new mount's
    const old = st.retired.find((e) => e.report.receiver_generation === 1)!
    expect(old.report.observed_generation).toBe(9)
    expect(old.body).toBeNull()                       // no new-mount custody was attached to it
  })
})

describe('E3 mount authority, through the store', () => {
  it('an old upload refusal cannot revoke the replacement mount; that mount keeps uploading', async () => {
    const c = fakeClient()
    const put = c.studioPiece
    let first = true
    let rejectOld: (e: unknown) => void = () => { throw new Error('Old upload was not sent') }
    c.studioPiece = async (sid, body) => {
      if (first) {
        first = false
        log.push('host:old-piece-pending')
        return new Promise<never>((_resolve, reject) => { rejectOld = reject })
      }
      return put(sid, body)
    }
    useHive.setState({ client: c as never })
    await started()
    attachFrame(port(1))
    await settle()
    framePiece(1, 'ss_a', capture(8))
    await settle()
    expect(log).toContain('host:old-piece-pending')
    expect(log).toContain('frame1:studio-live-open')

    detachFrame(1)
    attachFrame(port(2))
    await settle()
    expect(log).toContain('frame2:studio-live-open')
    expect(useStudioLive.getState().local).toBe('receiving')
    log = []
    const { ApiError } = await import('../../api/client')
    rejectOld(new ApiError(409, 'stale_mount', 'old mount'))
    await settle()
    expect(log).not.toContain('frame2:studio-live-close')
    expect(useStudioLive.getState().local).toBe('receiving')

    framePiece(2, 'ss_a', capture(9))
    await settle()
    expect(log).toContain('host:piece:1')
    expect(useStudioLive.getState().custody.seq).toBe(1)
    expect(useStudioLive.getState().local).toBe('receiving')
  })
  it('opens only after winning the compare-and-swap; a lost CAS closes locally and says so; the token never reaches React state', async () => {
    await started()
    mountEpoch = 5                                     // another window won first
    ledgerRaw.mount_epoch = null                       // this page still believes there is none
    attachFrame(port(1))
    await settle()
    expect(log).toContain('host:mount:null')
    expect(log).not.toContain('frame1:studio-live-open')
    expect(useStudioLive.getState().local).toBe('mount-lost')
    expect(JSON.stringify(useStudioLive.getState())).not.toMatch(/mt_/)
  })
  it('unmount revokes the mount with the same person; a sign-in change never sends it', async () => {
    await started()
    attachFrame(port(1))
    await settle()
    detachFrame(1)
    await settle()
    expect(log).toContain('host:unmount')
    log = []
    attachFrame(port(2))
    await settle()
    bump()
    await settle()
    expect(log.filter((x) => x === 'host:unmount')).toEqual([])
  })
})

describe('directions and the next turn (Design routing review)', () => {
  it('an already-selected Queue refuses stale same-principal auth through the actual Ask caller, with no ordinary fallback', async () => {
    await started()
    expect(setDirectionMode('queue')).toBe(true)
    const before = useStudioLive.getState()
    const drafts = { next: [...before.next], held: [...before.held], sent: [...before.sent] }
    const writes = [...log]
    const original = { send: useAskStore.getState().send, steer: useAskStore.getState().steer }
    const ordinaryAttempts: string[] = []
    // Forbidden fallback endpoints record BEFORE throwing; post-SUT assertions cannot be swallowed by the caller.
    useAskStore.setState({
      send: async () => { ordinaryAttempts.push('send'); throw new Error('No ordinary Ask fallback is allowed') },
      steer: async () => { ordinaryAttempts.push('steer'); throw new Error('No ordinary Ask fallback is allowed') },
    })
    try {
      useAskStore.setState({ bound: { ...useAskStore.getState().bound!, auth: 'earlier-auth-handle' } })
      expect(studioRoute()).not.toBeNull() // no reset observer has run: the actual selected-route branch is reached
      expect(drawingTurnAssociation().state).toBe('foreign')
      await expect(askMind('Do not queue under stale auth', { swarm_id: 's_x' } as never)).resolves.toBeUndefined()
      expect(useStudioLive.getState().directionMode).toBe('queue')
      expect(useStudioLive.getState().next).toEqual(drafts.next)
      expect(useStudioLive.getState().held).toEqual(drafts.held)
      expect(useStudioLive.getState().sent).toEqual(drafts.sent)
      expect(ordinaryAttempts).toEqual([])
      expect(steerCalls).toEqual([])
      expect(log).toEqual(writes)
    } finally { useAskStore.setState(original) }
  })

  it('an already-selected Queue rechecks the original runtime binding before any draft mutation', async () => {
    await started()
    expect(setDirectionMode('queue')).toBe(true)
    const route = studioRoute()!
    const before = useStudioLive.getState()
    const drafts = { next: [...before.next], held: [...before.held], sent: [...before.sent] }
    const writes = [...log]
    const current = vi.spyOn(runtimeForTests()!.binding, 'current').mockReturnValue(false) // explicit guard endpoint
    try {
      expect(await route.steer('Do not use a stale runtime', 'typed', { swarm_id: 's_x' } as never)).toBe(false)
      expect(current).toHaveBeenCalled()
      expect(useStudioLive.getState().next).toEqual(drafts.next)
      expect(useStudioLive.getState().held).toEqual(drafts.held)
      expect(useStudioLive.getState().sent).toEqual(drafts.sent)
      expect(steerCalls).toEqual([])
      expect(log).toEqual(writes)
    } finally { current.mockRestore() }
  })

  it('an already-selected route cannot queue old words after the real identity observer resets the session', async () => {
    await started()
    expect(setDirectionMode('queue')).toBe(true)
    const route = studioRoute()!
    bump()
    const writes = [...log]
    expect(studioRoute()).toBeNull()
    expect(await route.steer('Old-person Queue words', 'typed', { swarm_id: 's_x' } as never)).toBe(false)
    expect(useStudioLive.getState().next).toEqual([])
    expect(useStudioLive.getState().held).toEqual([])
    expect(useStudioLive.getState().sent).toEqual([])
    expect(steerCalls).toEqual([])
    expect(log).toEqual(writes)
  })

  it('joins the actual retained server-turn frame to its operation for both the active organ label and real Steer call', async () => {
    await started()
    expect(useStudioLive.getState().ledger?.ask_turn_id).toBe('at_inv1')
    expect(drawingTurnAssociation()).toMatchObject({ state: 'known', serverTurnId: 'at_inv1', operationId: 'op_inv1', omega: { mind_id: 'omega_wren', name: 'Wren' } })
    const html = renderCurrentSession()
    expect(html).toContain('Wren · drawing')
    expect(html).toContain('Maker ID (host record)')
    expect(html).toContain('a_m')
    expect(await steerSession('Use the verified operation', 'typed', { swarm_id: 's_x' } as never)).toBe(true)
    await settle()
    expect(steerCalls).toEqual([{ operation: 'op_inv1', at: 1 }])
    expect(useStudioLive.getState().ledger?.ask_turn_id).toBe('at_inv1')
  })

  it('holds Steer without a retained mapping, shows the unknown identity and reason, and leaves Queue separate', async () => {
    await started()
    useAskStore.setState({ turns: {} })
    expect(drawingTurnAssociation().state).toBe('missing')
    const html = renderCurrentSession()
    expect(html).toContain('This record does not identify the omega')
    expect(html).toContain('not uniquely retained under your current sign-in')
    expect(html).toMatch(/disabled[^>]*>Steer/)
    expect(setDirectionMode('steer')).toBe(false)
    expect(await steerSession('Keep these direction words')).toBe(false)
    expect(useStudioLive.getState().held.map((h) => h.text)).toContain('Keep these direction words')
    expect(steerCalls).toEqual([])
    expect(setDirectionMode('queue')).toBe(true)
    await studioRoute()!.steer('Separate new work', 'typed', { swarm_id: 's_x' } as never)
    expect(useStudioLive.getState().next.map((n) => n.text)).toEqual(['Separate new work'])
    expect(steerCalls).toEqual([])
  })

  it('refuses duplicate, conflicting, foreign, aliased, unplaced and malformed mappings instead of guessing an operation', async () => {
    await started()
    const mixed = retainedTurn()
    mixed.lastSeq = 2
    mixed.events.push({ ...mixed.events[0], seq: 2, turn_id: 'at_other' })
    const mismatched = retainedTurn()
    mismatched.events = [{ ...mismatched.events[0], operation_id: 'op_other' }]
    const cases = [
      [{ op_inv1: retainedTurn(), op_other: retainedTurn('op_other') }, 'ambiguous'],
      [{ op_inv1: mixed }, 'ambiguous'],
      [{ op_inv1: mismatched }, 'ambiguous'],
      [{ op_inv1: retainedTurn('op_inv1', 'at_inv1', 'user:foreign') }, 'foreign'],
      [{ wrong_key: retainedTurn() }, 'invalid'],
      [{ op_inv1: { ...retainedTurn(), appAskTurnId: 'at_other' } }, 'ambiguous'],
      [{ at_inv1: retainedTurn('at_inv1', 'at_inv1') }, 'invalid'],
      [{ op_inv1: { ...retainedTurn(), events: [], ahead: retainedTurn().events, lastSeq: 0 } }, 'missing'],
    ] as const
    for (const [turns, state] of cases) {
      useAskStore.setState({ turns } as never)
      expect(drawingTurnAssociation().state).toBe(state)
      expect(setDirectionMode('steer')).toBe(false)
      expect(await steerSession(`Hold ${state}`)).toBe(false)
      expect(steerCalls).toEqual([])
      expect(renderCurrentSession()).not.toContain('Wren · drawing')
    }
  })

  it('does not use retained frames or touch old-person drafts while the current principal or auth handle differs', async () => {
    await started()
    const beforeHeld = [...useStudioLive.getState().held]
    const originalBound = useAskStore.getState().bound!
    useAskStore.setState({ bound: { ...originalBound, principal: 'user:foreign' } })
    expect(drawingTurnAssociation().state).toBe('foreign')
    expect(await steerSession('Do not move across people')).toBe(false)
    expect(setDirectionMode('queue')).toBe(false)
    expect(useStudioLive.getState().held).toEqual(beforeHeld)
    expect(steerCalls).toEqual([])
    useAskStore.setState({ bound: { ...originalBound, auth: 'earlier-auth-handle' } })
    expect(drawingTurnAssociation().state).toBe('foreign')
    expect(await steerSession('Do not use an earlier auth handle')).toBe(false)
    expect(useStudioLive.getState().held).toEqual(beforeHeld)
    expect(steerCalls).toEqual([])
  })

  it('an actual identity reset removes the association and a retained old direction callback creates no new-person draft or write', async () => {
    await started()
    expect(drawingTurnAssociation().state).toBe('known')
    const oldSteer = steerSession
    bump()
    expect(drawingTurnAssociation().state).not.toBe('known')
    expect(await oldSteer('Old-person words')).toBe(false)
    expect(useStudioLive.getState().held).toEqual([])
    expect(useStudioLive.getState().next).toEqual([])
    expect(steerCalls).toEqual([])
    expect(studioRoute()).toBeNull()
  })

  it('a visible Queue choice routes future words to the existing next-turn queue without a host call', async () => {
    await started()
    log.length = 0
    expect(setDirectionMode('queue')).toBe(true)
    expect(await studioRoute()!.steer('A separate poster', 'typed', { swarm_id: 's_x' } as never)).toBe(true)
    expect(useStudioLive.getState().next.map((n) => n.text)).toEqual(['A separate poster'])
    expect(useStudioLive.getState().sent).toEqual([])
    expect(log).toEqual([])
  })

  it('switching back to Steer uses the same bound direction path and does not consume queued work', async () => {
    await started()
    expect(setDirectionMode('queue')).toBe(true)
    await studioRoute()!.steer('Later work', 'typed', { swarm_id: 's_x' } as never)
    expect(setDirectionMode('steer')).toBe(true)
    await studioRoute()!.steer('Make the title bigger', 'typed', { swarm_id: 's_x' } as never)
    await settle()
    expect(log.filter((x) => x.startsWith('host:steer'))).toEqual(['host:steer:Make the title bigger'])
    expect(useStudioLive.getState().next.map((n) => n.text)).toEqual(['Later work'])
    expect(useStudioLive.getState().sent.map((d) => d.text)).toEqual(['Make the title bigger'])
  })

  it('switching modes never withdraws or also queues a direction already recorded by the host', async () => {
    await started()
    await studioRoute()!.steer('Current direction', 'typed', { swarm_id: 's_x' } as never)
    await settle()
    const before = useStudioLive.getState().sent.map((d) => ({ ...d }))
    const hostBefore = JSON.stringify(ledgerRaw.directions)
    expect(setDirectionMode('queue')).toBe(true)
    expect(useStudioLive.getState().sent).toEqual(before)
    expect(useStudioLive.getState().next).toEqual([])
    expect(JSON.stringify(ledgerRaw.directions)).toBe(hostBefore)
  })

  it('a capability drop after choosing Queue keeps the words held and sends no new work', async () => {
    await started()
    expect(setDirectionMode('queue')).toBe(true)
    const route = studioRoute()!
    offer(false)
    log.length = 0
    expect(await route.steer('Keep these words', 'typed', { swarm_id: 's_x' } as never)).toBe(false)
    expect(useStudioLive.getState().next).toEqual([])
    expect(useStudioLive.getState().held.map((h) => h.text)).toContain('Keep these words')
    expect(log).toEqual([])
    expect(setDirectionMode('steer')).toBe(false)
  })

  it('the choice and queued words reset with the person, and the previous route cannot queue for the next person', async () => {
    await started()
    expect(setDirectionMode('queue')).toBe(true)
    await studioRoute()!.steer('Old person work', 'typed', { swarm_id: 's_x' } as never)
    bump()
    expect(useStudioLive.getState().directionMode).toBe('steer')
    expect(useStudioLive.getState().next).toEqual([])
    expect(studioRoute()).toBeNull()
    expect(setDirectionMode('queue')).toBe(false)
  })

  it('missing directions capability cannot be enabled by selecting Steer; Queue remains separate work', async () => {
    await started()
    useAskStore.setState({ settings: { ...useAskStore.getState().settings!, capabilities: { conductor: false, memory: false, studio_sessions: true, studio_directions: false } } } as never)
    expect(setDirectionMode('steer')).toBe(false)
    expect(setDirectionMode('queue')).toBe(true)
    await studioRoute()!.steer('Separate work', 'typed', { swarm_id: 's_x' } as never)
    expect(useStudioLive.getState().next.map((n) => n.text)).toEqual(['Separate work'])
    expect(log.some((x) => x.startsWith('host:steer'))).toBe(false)
  })

  it('“Also queue as new work” is additive, offered only while still queued, and two queued turns are both kept', async () => {
    const { alsoQueue, queueNext, steerSession } = await import('./store')
    await started()
    await steerSession('bigger headline', 'typed', { swarm_id: 's_x' } as never)
    await settle()
    const d = useStudioLive.getState().sent[0]
    alsoQueue(d.steer_id)
    expect(useStudioLive.getState().next.map((n) => n.text)).toEqual(['bigger headline'])
    expect(log.filter((x) => x.startsWith('host:steer'))).toEqual(['host:steer:bigger headline'])   // the direction stays active
    queueNext('and a second job', { swarm_id: 's_x' } as never)
    expect(useStudioLive.getState().next.map((n) => n.text)).toEqual(['bigger headline', 'and a second job'])
    ;(ledgerRaw.directions as { state: string }[])[0].state = 'delivered'
    useStudioLive.setState((s) => ({ sent: s.sent.map((x) => ({ ...x, queuedToo: false })) }))
    const { refresh } = await import('./store')
    await refresh()
    alsoQueue(d.steer_id)                               // delivered: no longer offered
    expect(useStudioLive.getState().next.length).toBe(2)
  })
})

describe('Create R3.1: queued work is a new admitted Ask turn', () => {
  // Real Ask success replies carry the thread that their accepted frame names.
  const queueThread = { id: 'thread_inv1', mind: { id: 'omega_wren', name: 'Wren' }, budget_usd: 5, spent_usd: 0 }
  const realAdmit = useAskStore.getState().admit
  beforeEach(() => useAskStore.setState({ open: null }))
  afterEach(() => useAskStore.setState({ admit: realAdmit, open: null }))
  const context = { route: 'hive', experience: 'classic', swarm_id: 's_x' } as const
  const accepted = { admitted: true, op: 'op_queue', principal: 'user:p_a' } as const
  const complete = (op: string) => {
    const t = retainedTurn(op)
    const done = checkAskEvent({ type: 'ask', operation_id: op, turn_id: 'at_inv1', principal: 'user:p_a', seq: 2, phase: 'done', outcome: 'complete', at: '2026-10-29T00:00:01Z' })
    if (!done) throw new Error('The queued-turn completion must satisfy the actual Ask reader')
    return { ...t, state: 'done' as const, lastSeq: 2, events: [...t.events, done] }
  }

  it('Send now while an Ask is open keeps the same draft and emits no direction', async () => {
    const { queueNext, sendNext } = await import('./store')
    await started()
    useAskStore.setState({ open: 'op_inv1' })
    queueNext('A separate drawing, not a direction', context)
    const queued = useStudioLive.getState().next[0]
    await sendNext(queued.id)
    expect(useStudioLive.getState().next).toEqual([queued])
    expect(steerCalls).toEqual([])
    expect(log.filter((x) => x.startsWith('host:steer'))).toEqual([])
    expect(renderCurrentSession()).toMatch(/disabled=""[^>]*>Send now/)
  })

  it('completion of an older turn cannot redirect queued words into a different open turn', async () => {
    const { queueNext } = await import('./store')
    await started()
    useAskStore.setState({ open: 'op_inv1' })
    queueNext('The next job', context)
    const queued = useStudioLive.getState().next[0]
    useAskStore.setState({ open: 'op_other', turns: { op_inv1: complete('op_inv1'), op_other: retainedTurn('op_other') } })
    await flush()
    expect(useStudioLive.getState().next).toEqual([queued])
    expect(steerCalls).toEqual([])
  })

  it('keeps words until positive admission, then consumes only that queued item', async () => {
    const { queueNext, sendNext } = await import('./store')
    let resolve!: (value: typeof accepted) => void
    const admit = vi.fn(() => new Promise<typeof accepted>((r) => { resolve = r }))
    useAskStore.setState({ admit })
    queueNext('First job', context)
    queueNext('Second job', context)
    const first = useStudioLive.getState().next[0]
    const pending = sendNext(first.id)
    expect(useStudioLive.getState().next.map((x) => x.text)).toEqual(['First job', 'Second job'])
    expect(admit).toHaveBeenCalledWith('First job', context, { newTurnOnly: true })
    resolve(accepted)
    await pending
    expect(useStudioLive.getState().next.map((x) => x.text)).toEqual(['Second job'])
  })

  it('an edit made during admission is retained as new queued work', async () => {
    const { queueNext, editNext, sendNext } = await import('./store')
    let resolve!: (value: typeof accepted) => void
    useAskStore.setState({ admit: () => new Promise<typeof accepted>((r) => { resolve = r }) })
    queueNext('Original words', context)
    const id = useStudioLive.getState().next[0].id
    const pending = sendNext(id)
    editNext(id, 'My edited draft')
    resolve(accepted)
    await pending
    expect(useStudioLive.getState().next.map((x) => x.text)).toEqual(['My edited draft'])
    expect(useStudioLive.getState().next[0].handoff).toBe('edited')
  })

  it.each(['refused', 'not_available', 'held'] as const)('a known %s handoff keeps the words available', async (reason) => {
    const { queueNext, sendNext } = await import('./store')
    const admit = vi.fn(async () => ({ admitted: false as const, reason }))
    useAskStore.setState({ admit })
    queueNext('Keep my draft', context)
    await sendNext()
    await sendNext() // automatic progress cannot retry a definitely unadmitted draft
    expect(admit).toHaveBeenCalledTimes(1)
    const kept = useStudioLive.getState().next[0]
    expect(kept).toMatchObject({ text: 'Keep my draft', handoff: 'not-admitted' })
    await sendNext(kept.id) // a separate explicit manual choice
    expect(admit).toHaveBeenCalledTimes(2)
  })

  it.each(['unknown', 'not_admitted'] as const)('a %s handoff is visible and never automatically retried', async (reason) => {
    const { queueNext, editNext, sendNext } = await import('./store')
    await started()
    const admit = vi.fn(async () => ({ admitted: false as const, reason }))
    useAskStore.setState({ admit })
    queueNext('Do not duplicate this request', context)
    const id = useStudioLive.getState().next[0].id
    await sendNext(id)
    editNext(id, 'An edited draft still needs its original handoff checked')
    useAskStore.setState({ open: 'op_inv1' })
    useAskStore.setState({ open: null, turns: { op_inv1: complete('op_inv1') } })
    if (reason === 'not_admitted') {
      await sendNext() // the original neutral case still proves no automatic retry
      expect(admit).toHaveBeenCalledTimes(1)
      expect(useStudioLive.getState().next[0]).toMatchObject({ id, handoff: 'not-admitted', text: 'An edited draft still needs its original handoff checked' })
      await sendNext(id) // definite no-admission permits only the person's explicit retry
      expect(admit).toHaveBeenCalledTimes(2)
      expect(useStudioLive.getState().next[0]).toMatchObject({ id, handoff: 'not-admitted', text: 'An edited draft still needs its original handoff checked' })
      expect(steerCalls).toEqual([])
      return
    }
    await sendNext(id)
    await flush()
    expect(admit).toHaveBeenCalledTimes(1)
    expect(useStudioLive.getState().next[0]).toMatchObject({ id, handoff: 'uncertain', text: 'An edited draft still needs its original handoff checked' })
    expect(renderCurrentSession()).toContain('The Ask has not confirmed this handoff')
    expect(renderCurrentSession()).toMatch(/disabled=""[^>]*>Send now/)
    expect(steerCalls).toEqual([])
  })

  it('an exception keeps an uncertain draft instead of losing it or starting another operation', async () => {
    const { queueNext, sendNext } = await import('./store')
    const admit = vi.fn(async () => { throw new Error('Invented ambiguous handoff') })
    useAskStore.setState({ admit })
    queueNext('Keep these words', context)
    await sendNext()
    await sendNext()
    expect(admit).toHaveBeenCalledTimes(1)
    expect(useStudioLive.getState().next[0]).toMatchObject({ text: 'Keep these words', handoff: 'uncertain' })
  })

  it('concurrent Send now actions reserve one handoff until its actual answer', async () => {
    const { queueNext, sendNext } = await import('./store')
    let resolve!: (value: typeof accepted) => void
    const admit = vi.fn(() => new Promise<typeof accepted>((r) => { resolve = r }))
    useAskStore.setState({ admit })
    queueNext('Exactly one new job', context)
    const pending = sendNext()
    await sendNext()
    expect(admit).toHaveBeenCalledTimes(1)
    resolve(accepted)
    await pending
    expect(useStudioLive.getState().next).toEqual([])
  })

  it('a late admission cannot remove a different person\'s queued words', async () => {
    const { queueNext, sendNext } = await import('./store')
    let resolve!: (value: typeof accepted) => void
    useAskStore.setState({ admit: () => new Promise<typeof accepted>((r) => { resolve = r }) })
    queueNext('Earlier person', context)
    const pending = sendNext()
    bump()
    queueNext('New person draft', context)
    resolve(accepted)
    await pending
    expect(useStudioLive.getState().next.map((x) => x.text)).toEqual(['New person draft'])
  })

  it('a positively admitted turn that completes early advances once to the next queued draft', async () => {
    const { queueNext, sendNext } = await import('./store')
    await started()
    let resolve!: (value: typeof accepted) => void
    const admit = vi.fn()
      .mockImplementationOnce(() => new Promise<typeof accepted>((r) => { resolve = r }))
      .mockResolvedValue({ admitted: false, reason: 'refused' })
    useAskStore.setState({ admit })
    queueNext('First job', context)
    queueNext('Second job', context)
    const pending = sendNext()
    useAskStore.setState({ open: accepted.op })
    useAskStore.setState({ open: null, turns: { [accepted.op]: complete(accepted.op) } })
    expect(admit).toHaveBeenCalledTimes(1)
    resolve(accepted)
    await pending
    await flush()
    expect(admit).toHaveBeenCalledTimes(2)
    expect(admit.mock.calls[1][0]).toBe('Second job')
    expect(useStudioLive.getState().next.map((x) => x.text)).toEqual(['Second job'])
  })
  const queuedTransport = async (read: 'confirmed' | 'unknown' | 'completed' = 'confirmed') => {
    const { ApiError } = await import('../../api/client')
    const c = useHive.getState().client as unknown as {
      ask: ReturnType<typeof vi.fn>; askTurn: ReturnType<typeof vi.fn>
    }
    const requests: import('../../api/ask').AskBody[] = []
    let readsConfirm = read !== 'unknown'
    const view = (op: string) => ({ operation_id: op, turn_id: 'at_inv1', thread: queueThread, state: 'accepted' as const, events: read === 'completed' && requests.length === 1 ? complete(op).events : retainedTurn(op).events, more: false })
    c.ask = vi.fn(async (body: import('../../api/ask').AskBody) => {
      requests.push(structuredClone(body))
      if (requests.length === 1) throw new ApiError(0, 'network', 'Synthetic lost POST response')
      return view(body.operation_id)
    })
    c.askTurn = vi.fn(async (op: string) => {
      if (!readsConfirm) throw new ApiError(403, 'forbidden', 'Synthetic unreadable original')
      return view(op)
    })
    await started()
    return { c, requests, confirm: () => { readsConfirm = true } }
  }

  it('real admit: lost POST then original readback, completion and second queued job advance once without steering or a replacement', async () => {
    const { queueNext, sendNext } = await import('./store')
    const h = await queuedTransport()
    useAskStore.setState({ admit: realAdmit })
    queueNext('First real-admit job', context)
    queueNext('Second real-admit job', context)
    await sendNext()
    const original = h.requests[0].operation_id
    expect(h.requests).toHaveLength(1)
    expect(h.c.askTurn).toHaveBeenCalledWith(original, 0)
    expect(useStudioLive.getState().next.map((x) => x.text)).toEqual(['Second real-admit job'])
    const done = complete(original).events[1]
    useAskStore.getState().onEvent(done)
    await flush()
    expect(h.requests).toHaveLength(2)
    expect(h.requests[1].text).toBe('Second real-admit job')
    expect(h.requests[1].operation_id).not.toBe(original)
    expect(h.requests.filter((b) => b.operation_id === original)).toHaveLength(1)
    expect(useStudioLive.getState().next).toEqual([])
    useAskStore.getState().onEvent(done) // duplicate completion cannot advance again
    await flush()
    expect(h.requests).toHaveLength(2)
    expect(steerCalls).toEqual([])
  })

  it('real admit: completion inside the original readback survives the handoff lock and advances queue2 exactly once', async () => {
    const { queueNext, sendNext } = await import('./store')
    const h = await queuedTransport('completed')
    useAskStore.setState({ admit: realAdmit })
    queueNext('Early-completing original', context)
    queueNext('Exactly one second job', context)
    await sendNext()
    await flush()
    expect(h.requests).toHaveLength(2)
    expect(h.requests[1].text).toBe('Exactly one second job')
    expect(new Set(h.requests.map((b) => b.operation_id)).size).toBe(2)
    expect(useStudioLive.getState().next).toEqual([])
    useAskStore.getState().onEvent(complete(h.requests[0].operation_id).events[1])
    await flush()
    expect(h.requests).toHaveLength(2)
    expect(steerCalls).toEqual([])
  })

  it.each(['ask_busy', 'operation_conflict'] as const)('real admit retains queue words after a same-id %s placeholder until an actual matching frame', async (code) => {
    const { ApiError } = await import('../../api/client')
    const { AskRefusal } = await import('../../api/ask')
    const { queueNext, sendNext, canCheckNext } = await import('./store')
    const h = await queuedTransport('unknown')
    let original = ''
    h.c.askTurn = vi.fn(async () => { throw new AskRefusal(404, 'not_available', 'Synthetic missing read') })
    h.c.ask = vi.fn(async (body: import('../../api/ask').AskBody) => {
      h.requests.push(structuredClone(body))
      if (!original) { original = body.operation_id; throw new ApiError(0, 'network', 'Synthetic lost POST response') }
      if (body.operation_id === original) {
        if (code === 'ask_busy') throw new AskRefusal(409, code, 'Synthetic same-id busy', { operation_id: original })
        throw new ApiError(409, code, 'Synthetic operation conflict')
      }
      return { operation_id: body.operation_id, turn_id: 'at_inv1', thread: queueThread, state: 'accepted' as const, events: retainedTurn(body.operation_id).events, more: false }
    })
    useAskStore.setState({ admit: realAdmit })
    queueNext('Do not consume on a placeholder', context)
    queueNext('Second queued job after actual completion', context)
    const id = useStudioLive.getState().next[0].id
    await sendNext(id)
    await flush()
    expect(h.requests).toHaveLength(2) // original and unchanged same-id legacy recovery, never a new operation
    expect(new Set(h.requests.map((b) => b.operation_id)).size).toBe(1)
    expect(h.requests[1]).toEqual(h.requests[0])
    expect(useStudioLive.getState().next.map((n) => n.text)).toEqual(['Do not consume on a placeholder', 'Second queued job after actual completion'])
    expect(useStudioLive.getState().next[0].handoff).toBe('uncertain')
    expect(canCheckNext(id)).toBe(false) // legacy display is open/no-unsure, not an actionable checkAgain
    expect(renderCurrentSession()).toContain('>Open Ask</button>')
    await sendNext(id)
    expect(h.requests).toHaveLength(2)
    useAskStore.getState().onEvent(retainedTurn(original).events[0])
    await flush()
    expect(useStudioLive.getState().next.map((n) => n.text)).toEqual(['Second queued job after actual completion'])
    expect(h.requests).toHaveLength(2)
    useAskStore.getState().onEvent(complete(original).events[1])
    await flush()
    expect(h.requests).toHaveLength(3)
    expect(new Set(h.requests.map((b) => b.operation_id)).size).toBe(2)
    expect(h.requests[2].text).toBe('Second queued job after actual completion')
    expect(useStudioLive.getState().next).toEqual([])
    expect(steerCalls).toEqual([])
  })

  const ordinaryFrame = (op: string, phase: 'accepted' | 'done') => {
    const e = checkAskEvent({ type: 'ask', operation_id: op, turn_id: 'at_inv1', seq: phase === 'accepted' ? 1 : 2, phase, at: '2026-10-29T00:00:01Z', ...(phase === 'accepted' ? { thread: { id: 'thread_inv1', mind: { id: 'omega_wren', name: 'Wren' }, budget_usd: 5, spent_usd: 0 } } : { outcome: 'complete' }) })
    if (!e) throw new Error('Ordinary no-principal frame must satisfy the current API reader')
    expect(e).not.toHaveProperty('principal')
    return e
  }

  it('C6 R3: real pre-POST epoch rejection retains a manual draft, then one retry and completion advance the queue', async () => {
    const { queueNext, sendNext, canCheckNext } = await import('./store')
    const h = await queuedTransport()
    h.c.ask = vi.fn(async (body: import('../../api/ask').AskBody) => {
      h.requests.push(structuredClone(body))
      return { operation_id: body.operation_id, turn_id: 'at_inv1', thread: queueThread, state: 'accepted' as const, events: [ordinaryFrame(body.operation_id, 'accepted')], more: false }
    })
    useAskStore.setState({ admit: realAdmit })
    const words = 'A pre-POST rejection stays available for my manual choice'
    queueNext(words, context)
    queueNext('Second queued job after the manually admitted original', context)
    const first = useStudioLive.getState().next[0]
    const bound = useAskStore.getState().bound
    let changed = false
    const unsubscribe = useAskStore.subscribe((s) => {
      if (changed || !s.open || s.turns[s.open]?.you !== words) return
      changed = true
      useAskStore.setState({ epoch: s.epoch + 1 }) // same person/client/session; invalidate only the optimistic snapshot
    })
    try { await sendNext(first.id) } finally { unsubscribe() }
    expect(changed).toBe(true)
    expect(useAskStore.getState().bound).toBe(bound)
    expect(h.c.ask).not.toHaveBeenCalled()
    expect(h.requests).toEqual([])
    expect(useAskStore.getState().open).toBeNull()
    expect(useStudioLive.getState().next[0]).toMatchObject({ id: first.id, text: words, handoff: 'not-admitted' })
    expect(canCheckNext(first.id)).toBe(false) // no receipt was issued, so no guessed original check
    await sendNext() // an automatic attempt cannot retry even a definitely unadmitted draft
    expect(h.c.ask).not.toHaveBeenCalled()
    await sendNext(first.id) // the person's explicit manual retry, not an automatic resubmission
    expect(h.c.ask).toHaveBeenCalledTimes(1)
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0].text).toBe(words)
    expect(useStudioLive.getState().next.map((n) => n.text)).toEqual(['Second queued job after the manually admitted original'])
    const original = h.requests[0].operation_id
    useAskStore.getState().onEvent(ordinaryFrame(original, 'done'))
    await flush()
    expect(h.c.ask).toHaveBeenCalledTimes(2)
    expect(h.requests[1].text).toBe('Second queued job after the manually admitted original')
    expect(h.requests[1].operation_id).not.toBe(original)
    expect(useStudioLive.getState().next).toEqual([])
    expect(steerCalls).toEqual([])
    useAskStore.getState().onEvent(ordinaryFrame(h.requests[1].operation_id, 'done'))
  })

  it('real admit uses ordinary no-principal readback/complete frames, advances queue2 and ignores a cloned duplicate seq', async () => {
    const { queueNext, sendNext } = await import('./store')
    const h = await queuedTransport()
    h.c.askTurn = vi.fn(async (op: string) => ({ operation_id: op, turn_id: 'at_inv1', thread: queueThread, state: 'accepted' as const, events: [ordinaryFrame(op, 'accepted')], more: false }))
    useAskStore.setState({ admit: realAdmit })
    queueNext('Ordinary protocol original', context)
    queueNext('Second ordinary job', context)
    await sendNext()
    const op = h.requests[0].operation_id
    expect(h.requests).toHaveLength(1)
    expect(useStudioLive.getState().next.map((n) => n.text)).toEqual(['Second ordinary job'])
    const done = ordinaryFrame(op, 'done')
    useAskStore.getState().onEvent(done)
    await flush()
    expect(h.requests).toHaveLength(2)
    expect(h.requests[1].text).toBe('Second ordinary job')
    useAskStore.getState().onEvent({ ...done }) // same sequence, a fresh JSON/event object
    await flush()
    expect(h.requests).toHaveLength(2)
    expect(useStudioLive.getState().next).toEqual([])
    expect(steerCalls).toEqual([])
  })

  it('a real unknown receipt is confirmed by an ordinary no-principal accepted frame, then only complete advances queue2', async () => {
    const { queueNext, sendNext } = await import('./store')
    const h = await queuedTransport('unknown')
    useAskStore.setState({ admit: realAdmit })
    queueNext('Unknown original with ordinary frames', context)
    queueNext('Wait for that original to complete', context)
    await sendNext()
    const op = h.requests[0].operation_id
    expect(useStudioLive.getState().next[0].handoff).toBe('uncertain')
    useAskStore.getState().onEvent(ordinaryFrame(op, 'accepted'))
    await flush()
    expect(h.requests).toHaveLength(1)
    expect(useStudioLive.getState().next.map((n) => n.text)).toEqual(['Wait for that original to complete'])
    useAskStore.getState().onEvent(ordinaryFrame(op, 'done'))
    await flush()
    expect(h.requests).toHaveLength(2)
    expect(h.requests[1].operation_id).not.toBe(op)
    expect(useStudioLive.getState().next).toEqual([])
  })

  it('ordinary no-principal early COMPLETE survives the real-admit lock and does not block a later valid queue job', async () => {
    const { queueNext, sendNext } = await import('./store')
    const h = await queuedTransport()
    h.c.askTurn = vi.fn(async (op: string) => ({ operation_id: op, turn_id: 'at_inv1', thread: queueThread, state: 'done' as const, events: [ordinaryFrame(op, 'accepted'), ordinaryFrame(op, 'done')], more: false }))
    useAskStore.setState({ admit: realAdmit })
    queueNext('Ordinary early-completing original', context)
    queueNext('Second job after early completion', context)
    await sendNext()
    await flush()
    expect(h.requests).toHaveLength(2)
    expect(h.requests[1].text).toBe('Second job after early completion')
    const op = h.requests[0].operation_id
    useAskStore.getState().onEvent({ ...ordinaryFrame(op, 'done') })
    await flush()
    expect(h.requests).toHaveLength(2)
    queueNext('A later valid third job', context)
    useAskStore.getState().onEvent(ordinaryFrame(h.requests[1].operation_id, 'done'))
    await flush()
    expect(h.requests).toHaveLength(3)
    expect(h.requests[2].text).toBe('A later valid third job')
    expect(new Set(h.requests.map((b) => b.operation_id)).size).toBe(3)
  })

  it.each([null, 7, undefined, 'user:p_other'] as const)('a supplied invalid/foreign principal extension %s never auto-drains the next queue item', async (principal) => {
    const { queueNext, sendNext } = await import('./store')
    const h = await queuedTransport()
    useAskStore.setState({ admit: realAdmit })
    queueNext('Admitted original', context)
    queueNext('Retain after foreign or invalid completion', context)
    await sendNext()
    const op = h.requests[0].operation_id
    useAskStore.getState().onEvent({ ...ordinaryFrame(op, 'done'), principal })
    await flush()
    expect(h.requests).toHaveLength(1)
    expect(useStudioLive.getState().next[0].text).toBe('Retain after foreign or invalid completion')
  })

  it('real original remains unknown until one explicit bounded check; a positive read preserves edited words as manual-only', async () => {
    const { queueNext, sendNext, checkNext, canCheckNext, editNext } = await import('./store')
    const h = await queuedTransport('unknown')
    useAskStore.setState({ admit: realAdmit })
    queueNext('Submitted original', context)
    queueNext('Next job', context)
    const id = useStudioLive.getState().next[0].id
    await sendNext(id)
    expect(useStudioLive.getState().next[0].handoff).toBe('uncertain')
    expect(canCheckNext(id)).toBe(true)
    expect(renderCurrentSession()).toContain('Check again')
    expect(renderCurrentSession()).toContain('aria-describedby=')
    editNext(id, 'Edited retained draft')
    const original = h.requests[0].operation_id
    h.confirm()
    const checking = checkNext(id)
    await checkNext(id) // same original check lock, no second operation
    await checking
    expect(h.requests).toHaveLength(1)
    expect(useStudioLive.getState().next[0]).toMatchObject({ text: 'Edited retained draft', handoff: 'edited' })
    useAskStore.getState().onEvent(complete(original).events[1])
    await flush()
    await sendNext() // automatic completion does not release the edited draft
    expect(h.requests).toHaveLength(1)
    expect(useStudioLive.getState().next.map((x) => x.text)).toEqual(['Edited retained draft', 'Next job'])
    await sendNext(id) // only the person's separate manual action submits edited words
    expect(h.requests).toHaveLength(2)
    expect(h.requests[1].text).toBe('Edited retained draft')
    expect(h.requests[1].operation_id).not.toBe(original)
  })

  it('C6: a changed bound principal short-circuits a real unknown receipt before its admission lookup', async () => {
    const { queueNext, sendNext, canCheckNext, checkNext } = await import('./store')
    const h = await queuedTransport('unknown')
    useAskStore.setState({ admit: realAdmit })
    queueNext('Keep this original under its own principal', context)
    const id = useStudioLive.getState().next[0].id
    await sendNext(id)
    expect(canCheckNext(id)).toBe(true)
    const admissionOf = useAskStore.getState().admissionOf
    const lookup = vi.fn(admissionOf) // observe the real receipt lookup, never manufacture admission
    useAskStore.setState({ admissionOf: lookup })
    lookup.mockClear()
    const bound = useAskStore.getState().bound!
    const principal = bound.principal
    const reads = h.c.askTurn.mock.calls.length
    try {
      // Defence before the identity observer's notification; C5 already refuses downstream.
      bound.principal = 'user:p_other'
      expect(canCheckNext(id)).toBe(false)
      await checkNext(id)
      expect(lookup).not.toHaveBeenCalled()
      expect(h.c.askTurn).toHaveBeenCalledTimes(reads)
      expect(h.requests).toHaveLength(1)
      expect(useStudioLive.getState().next[0]).toMatchObject({ id, handoff: 'uncertain', text: 'Keep this original under its own principal' })
    } finally {
      bound.principal = principal
      useAskStore.setState({ admissionOf })
    }
  })

  it('C6: editing a definitively refused real original retires its receipt and keeps the words manual-only', async () => {
    const { ApiError } = await import('../../api/client')
    const { queueNext, sendNext, canCheckNext, checkNext, editNext } = await import('./store')
    const h = await queuedTransport('unknown')
    useAskStore.setState({ admit: realAdmit })
    queueNext('Original words awaiting a real decision', context)
    const id = useStudioLive.getState().next[0].id
    await sendNext(id)
    const original = h.requests[0].operation_id
    h.c.askTurn = vi.fn(async () => { throw new ApiError(404, 'not_available', 'Synthetic original not found') })
    h.c.ask = vi.fn(async (body: import('../../api/ask').AskBody) => {
      h.requests.push(structuredClone(body))
      throw new ApiError(403, 'forbidden', 'Synthetic definitive original refusal')
    })
    await checkNext(id) // the existing recovery may retry only the SAME original body/id
    expect(useAskStore.getState().turns[original].state).toBe('refused')
    expect(useStudioLive.getState().next[0].handoff).toBe('not-admitted')
    expect(h.requests).toHaveLength(2)
    expect(h.requests[1]).toEqual(h.requests[0])
    const admissionOf = useAskStore.getState().admissionOf
    const lookup = vi.fn(admissionOf)
    useAskStore.setState({ admissionOf: lookup })
    try {
      editNext(id, 'Edited words are a separate manual choice')
      useAskStore.setState({ threadOpen: !useAskStore.getState().threadOpen })
      expect(useStudioLive.getState().next[0]).toMatchObject({ id, handoff: 'edited', text: 'Edited words are a separate manual choice' })
      lookup.mockClear()
      useAskStore.setState({ threadOpen: !useAskStore.getState().threadOpen })
      expect(lookup).not.toHaveBeenCalled() // a later notification cannot dispatch the retired correlation
      expect(canCheckNext(id)).toBe(false)
      await checkNext(id)
      await sendNext() // automatic progress never resubmits the edited words
      expect(h.requests).toHaveLength(2)
      expect(new Set(h.requests.map((b) => b.operation_id))).toEqual(new Set([original]))
      expect(useStudioLive.getState().next[0].text).toBe('Edited words are a separate manual choice')
      expect(steerCalls).toEqual([])
    } finally {
      useAskStore.setState({ admissionOf })
    }
  })

  it('C6: a rematerialized COMPLETE for an already-used operation cannot advance again, while a later operation can', async () => {
    const { queueNext, sendNext } = await import('./store')
    const h = await queuedTransport()
    useAskStore.setState({ admit: realAdmit })
    queueNext('A completes and advances B', context)
    queueNext('B was queued before A completed', context)
    await sendNext()
    const original = h.requests[0].operation_id
    useAskStore.getState().onEvent(ordinaryFrame(original, 'done'))
    await flush()
    expect(h.requests).toHaveLength(2)
    expect(h.requests[1].text).toBe('B was queued before A completed')
    useAskStore.getState().onEvent(ordinaryFrame(h.requests[1].operation_id, 'done'))
    await flush()
    expect(useAskStore.getState().open).toBeNull()
    queueNext('C waits for a new manual start', context)
    const next = useStudioLive.getState().next[0]
    const retained = useAskStore.getState().turns[original]
    const firstDone = retained.events.find((e) => e.phase === 'done')
    if (!firstDone) throw new Error('The real admitted original must retain its completion')
    const replay = structuredClone(firstDone)
    expect(replay).not.toBe(firstDone)
    // A retained turn can be rebuilt from DATA; event-object identity is not operation identity.
    useAskStore.setState((s) => ({ open: original, turns: { ...s.turns, [original]: { ...retained, state: 'open' as const, lastSeq: 1, events: [ordinaryFrame(original, 'accepted')], ahead: [] } } }))
    useAskStore.getState().onEvent(replay)
    await flush()
    expect(h.requests).toHaveLength(2)
    expect(useStudioLive.getState().next).toEqual([next])
    queueNext('D waits for C to complete', context)
    await sendNext(next.id) // only the person's manual choice starts C
    expect(h.requests).toHaveLength(3)
    expect(h.requests[2].text).toBe('C waits for a new manual start')
    useAskStore.getState().onEvent(ordinaryFrame(h.requests[2].operation_id, 'done'))
    await flush()
    expect(h.requests).toHaveLength(4)
    expect(h.requests[3].text).toBe('D waits for C to complete')
    expect(new Set(h.requests.map((b) => b.operation_id)).size).toBe(4)
    expect(useStudioLive.getState().next).toEqual([])
    expect(steerCalls).toEqual([])
    useAskStore.getState().onEvent(ordinaryFrame(h.requests[3].operation_id, 'done'))
  })

  it('removing a real unknown draft without an identity change clears only queue correlation and disables stale checks', async () => {
    const { queueNext, sendNext, checkNext, canCheckNext, dropNext } = await import('./store')
    const h = await queuedTransport('unknown')
    useAskStore.setState({ admit: realAdmit })
    queueNext('Remove only this local draft', context)
    const id = useStudioLive.getState().next[0].id
    await sendNext(id)
    const original = h.requests[0].operation_id
    expect(canCheckNext(id)).toBe(true)
    const reads = h.c.askTurn.mock.calls.length
    const sameBinding = useAskStore.getState().bound
    dropNext(id)
    expect(canCheckNext(id)).toBe(false)
    await checkNext(id) // a stale handler cannot issue a read or replace the original
    expect(h.c.askTurn).toHaveBeenCalledTimes(reads)
    expect(useAskStore.getState().bound).toBe(sameBinding)
    expect(useAskStore.getState().turns[original].state).toBe('checking')
    expect(useStudioLive.getState().next).toEqual([])
    expect(h.requests).toHaveLength(1)
  })

  it('removal during an existing real original check cannot reinsert the draft or touch later words without an identity bump', async () => {
    const { queueNext, sendNext, checkNext, canCheckNext, dropNext } = await import('./store')
    const h = await queuedTransport('unknown')
    useAskStore.setState({ admit: realAdmit })
    queueNext('Removed while checking', context)
    const id = useStudioLive.getState().next[0].id
    await sendNext(id)
    let finish!: () => void
    h.c.askTurn = vi.fn(async (op: string) => { await new Promise<void>((r) => { finish = r }); return { operation_id: op, turn_id: 'at_inv1', events: retainedTurn(op).events, more: false } })
    const pending = checkNext(id)
    await flush()
    dropNext(id)
    queueNext('Later retained words', context)
    const later = useStudioLive.getState().next[0]
    expect(canCheckNext(id)).toBe(false)
    await checkNext(id)
    expect(h.c.askTurn).toHaveBeenCalledTimes(1)
    finish()
    await pending
    await flush()
    expect(useStudioLive.getState().next).toEqual([later])
    expect(canCheckNext(id)).toBe(false)
    expect(h.requests).toHaveLength(1)
  })

  it('an unknown without a safe receipt keeps words held and offers Open Ask, not a permanently disabled check or a new request', async () => {
    const { queueNext, sendNext, checkNext, canCheckNext, focusAsk } = await import('./store')
    await started()
    const admit = vi.fn(async () => { throw new Error('Synthetic ambiguous handoff') })
    useAskStore.setState({ admit, threadOpen: false })
    queueNext('Keep these unconfirmed words', context)
    const id = useStudioLive.getState().next[0].id
    await sendNext(id)
    expect(canCheckNext(id)).toBe(false)
    const html = renderCurrentSession()
    expect(html).toContain('An original-operation check is not available here')
    expect(html).toContain('>Open Ask</button>')
    expect(html).not.toContain('>Check again</button>')
    expect(html).toMatch(/disabled=""[^>]*>Send now/)
    expect(html).toContain('aria-describedby=')
    await checkNext(id)
    focusAsk()
    expect(useAskStore.getState().threadOpen).toBe(true)
    await sendNext(id)
    expect(admit).toHaveBeenCalledTimes(1)
    expect(useStudioLive.getState().next[0]).toMatchObject({ id, text: 'Keep these unconfirmed words', handoff: 'uncertain' })
  })

  it('an Ask thread reset invalidates its receipt without clearing uncertainty or inventing a replacement', async () => {
    const { queueNext, sendNext, checkNext, canCheckNext } = await import('./store')
    const h = await queuedTransport('unknown')
    useAskStore.setState({ admit: realAdmit })
    queueNext('Preserved across local Ask reset', context)
    const id = useStudioLive.getState().next[0].id
    await sendNext(id)
    useAskStore.getState().reset()
    expect(canCheckNext(id)).toBe(false)
    await checkNext(id)
    const html = renderCurrentSession()
    expect(html).toContain('>Open Ask</button>')
    expect(html).not.toContain('>Check again</button>')
    expect(useStudioLive.getState().next[0]).toMatchObject({ id, handoff: 'uncertain', text: 'Preserved across local Ask reset' })
    expect(h.requests).toHaveLength(1)
  })

  it.each(['open', 'done', 'checking'] as const)('a retained %s turn without an unsure body cannot advertise or run checkAgain', async (state) => {
    const { queueNext, sendNext, checkNext, canCheckNext } = await import('./store')
    const h = await queuedTransport('unknown')
    useAskStore.setState({ admit: realAdmit })
    queueNext('Keep until original proof', context)
    const id = useStudioLive.getState().next[0].id
    await sendNext(id)
    const op = h.requests[0].operation_id
    const reads = h.c.askTurn.mock.calls.length
    useAskStore.setState((s) => ({ turns: { ...s.turns, [op]: { ...s.turns[op], state, unsure: undefined } } }))
    expect(canCheckNext(id)).toBe(false)
    await checkNext(id)
    expect(h.c.askTurn).toHaveBeenCalledTimes(reads)
    expect(renderCurrentSession()).toContain('>Open Ask</button>')
    expect(renderCurrentSession()).not.toContain('>Check again</button>')
    expect(useStudioLive.getState().next[0].handoff).toBe('uncertain')
    expect(h.requests).toHaveLength(1)
  })

  it('a foreign frame cannot turn an unknown original into an actionable check on its now-open/no-unsure turn', async () => {
    const { queueNext, sendNext, checkNext, canCheckNext } = await import('./store')
    const h = await queuedTransport('unknown')
    useAskStore.setState({ admit: realAdmit })
    queueNext('Original principal only', context)
    const id = useStudioLive.getState().next[0].id
    await sendNext(id)
    const op = h.requests[0].operation_id
    const reads = h.c.askTurn.mock.calls.length
    const foreign = retainedTurn(op, 'at_inv1', 'user:p_other').events[0]
    useAskStore.getState().onEvent(foreign)
    expect(useAskStore.getState().turns[op].state).toBe('open') // inherited generic frame handling, not admission proof
    expect(canCheckNext(id)).toBe(false)
    await checkNext(id)
    expect(h.c.askTurn).toHaveBeenCalledTimes(reads)
    expect(renderCurrentSession()).toContain('>Open Ask</button>')
    expect(useStudioLive.getState().next[0].handoff).toBe('uncertain')
    expect(h.requests).toHaveLength(1)
  })

  it('a late successful check cannot touch the new identity or imply cancellation after explicit draft removal', async () => {
    const { queueNext, sendNext, checkNext, dropNext } = await import('./store')
    const h = await queuedTransport('unknown')
    useAskStore.setState({ admit: realAdmit })
    queueNext('Old identity original', context)
    const id = useStudioLive.getState().next[0].id
    await sendNext(id)
    let finish!: () => void
    h.c.askTurn = vi.fn(async (op: string) => { await new Promise<void>((r) => { finish = r }); return { operation_id: op, turn_id: 'at_inv1', events: retainedTurn(op).events, more: false } })
    const pending = checkNext(id)
    await flush()
    dropNext(id) // removes the local draft, not the actual original Ask
    bump()
    queueNext('New identity words', context)
    finish()
    await pending
    await flush()
    expect(useStudioLive.getState().next.map((x) => x.text)).toEqual(['New identity words'])
    expect(h.requests).toHaveLength(1)
  })

  it('a stopped original cannot auto-drain even if a complete frame is later retained', async () => {
    const { queueNext } = await import('./store')
    await started()
    const admit = vi.fn(async () => accepted)
    useAskStore.setState({ admit, open: accepted.op })
    queueNext('Wait for the person after Stop', context)
    useAskStore.setState({ open: null, turns: { [accepted.op]: { ...complete(accepted.op), refusedEarly: 'stopped' } } })
    await flush()
    expect(admit).not.toHaveBeenCalled()
    expect(useStudioLive.getState().next[0].text).toBe('Wait for the person after Stop')
  })

  it.each(['cancelled', 'spend_cap', 'error'] as const)('a real-admitted original ending %s never advances the second draft', async (outcome) => {
    const { queueNext, sendNext } = await import('./store')
    const h = await queuedTransport()
    useAskStore.setState({ admit: realAdmit })
    queueNext('Original job', context)
    queueNext('Wait for a complete answer', context)
    await sendNext()
    const op = h.requests[0].operation_id
    const done = checkAskEvent({ type: 'ask', operation_id: op, turn_id: 'at_inv1', principal: 'user:p_a', seq: 2, phase: 'done', outcome, at: '2026-10-29T00:00:01Z' })
    expect(done).not.toBeNull()
    useAskStore.getState().onEvent(done!)
    await flush()
    expect(h.requests).toHaveLength(1)
    expect(useStudioLive.getState().next[0].text).toBe('Wait for a complete answer')
  })

})

describe('observedBase delivery (Design READBACK: receive needs the maker-read tuple)', () => {
  it('forwards a step to the receiving frame only with the host’s piece_read, once per mount', async () => {
    const tuple = { seq: 4, body_sha256: H('a'), scene_ref: ref(3), edit_generation: 7 }
    await started()
    attachFrame(port(1))
    await settle()
    addStep(1, { piece_read: tuple })
    addStep(2)                                                          // no piece_read: held
    const { refresh } = await import('./store')
    await refresh()
    await refresh()
    expect(log.filter((x) => x === 'frame1:studio-live-step')).toEqual(['frame1:studio-live-step'])
  })
})

describe('r1.4 (stand-in r1.3 P2): reload cleanup reads the host R3 stop and money as R3 sends them', () => {
  /** the host R3 ledger's exact key set (fixture copied from host eb006a94 ledger/stop_view/_step_view/piece_view) */
  const r3Stopped = () => JSON.parse(fsRead(new URL('./fixtures/r3StoppedLedger.json', import.meta.url).pathname, 'utf8')).ledger as Record<string, unknown> & { budget: Record<string, unknown>; stop: Record<string, unknown> }
  const KEEP = 'omegahive.studioLive.session'
  const restoreWith = async (raw: Record<string, unknown>) => {
    const { restoreHeld } = await import('./store')
    offer(true)
    const c = fakeClient()
    c.studioSession = async () => raw
    useHive.setState({ client: c as never })
    store.set(KEEP, JSON.stringify({ principal: 'user:p_a', sid: 'ss_a', programId: 'omegadesign', swarmId: 's_x' }))
    restoreHeld()
    await settle()
    expect(useStudioLive.getState().ledger?.session_id).toBe('ss_a')        // the R3 ledger parsed
    return store.has(KEEP)
  }
  it('a stopped, released R3 session with budget.unknown 0 is forgotten on reload (R3 sends no stop.in_flight)', async () => {
    const raw = r3Stopped()
    expect('in_flight' in raw.stop).toBe(false)
    expect(await restoreWith(raw)).toBe(false)
  })
  it('kept while money is unresolved: budget.unknown > 0, or not known', async () => {
    const owed = r3Stopped()
    owed.budget.unknown = 0.12
    expect(await restoreWith(owed)).toBe(true)
    resetStudioLiveForTests()
    const unread = r3Stopped()
    delete unread.budget.unknown
    expect(await restoreWith(unread)).toBe(true)
  })
  it('kept while the stop is not confirmed: maker not released, or still stopping', async () => {
    const held = r3Stopped()
    held.stop.maker_released = false
    expect(await restoreWith(held)).toBe(true)
    resetStudioLiveForTests()
    const stopping = r3Stopped()
    stopping.state = 'stopping'
    stopping.stop.state = 'stopping'
    expect(await restoreWith(stopping)).toBe(true)
  })
})

describe('r1.6: host R5 controls (pause, resume, finish stopping) and their refusals', () => {
  const control = (fn: (sid: string, b: { control_id: string; action: string }) => unknown) => {
    const c = fakeClient() as unknown as Record<string, unknown>
    c.studioControl = async (sid: string, b: { control_id: string; action: string }) => { log.push(`host:control:${b.action}`); return fn(sid, b) }
    return c
  }
  const fail = async (status: number, code: string) => { const { ApiError } = await import('../../api/client'); return new ApiError(status, code, 'x') }
  it('Pause sends one pause control and reads the ledger back; a paused session offers Resume (host state only)', async () => {
    const c = control((_s, b) => { if (b.action === 'pause') { ledgerRaw.state = 'paused'; ledgerRaw.state_reason = 'paused_by_person' } return { state: ledgerRaw.state } })
    useHive.setState({ client: c as never })
    await started()
    log = []
    const { pauseSession } = await import('./store')
    await pauseSession()
    await settle()
    expect(log.filter((x) => x.startsWith('host:control'))).toEqual(['host:control:pause'])
    expect(useStudioLive.getState().ledger?.state).toBe('paused')
    expect(useStudioLive.getState().control).toBeNull()
  })
  it('a refused pause (409 not_active) says so with its way on; the session is left as the host has it', async () => {
    const e = await fail(409, 'not_active')
    useHive.setState({ client: control(() => { throw e }) as never })
    await started()
    const { pauseSession } = await import('./store')
    await pauseSession()
    await settle()
    const ctl = useStudioLive.getState().control
    expect(ctl?.state).toBe('refused')
    expect(ctl?.refusal?.code).toBe('not_active')
    expect(ctl?.refusal?.words).toMatch(/Only a running session can be paused/)
  })
  it('resume refused 409 consent_mismatch: stays paused, says Stop then confirm, and shows a REFRESHED card that starts only after the stop is confirmed', async () => {
    const e = await fail(409, 'consent_mismatch')
    const c = control((_s, b) => { if (b.action === 'resume') throw e; if (b.action === 'stop') { ledgerRaw.state = 'stopped'; ledgerRaw.stop = { state: 'stopped', in_flight: 0, maker_released: true } } return {} }) as Record<string, unknown>
    let previews = 0
    c.studioSetupProposal = async () => { previews++; return proposal }
    useHive.setState({ client: c as never })
    await started()
    ledgerRaw.state = 'paused'
    const { refresh, resumeSession } = await import('./store')
    await refresh()
    log = []
    await resumeSession()
    await settle()
    const s = useStudioLive.getState()
    expect(s.control?.refusal?.code).toBe('consent_mismatch')
    expect(s.control?.refusal?.next).toBe('confirm-new-card')   // r1.7: only consent_mismatch offers the new card
    expect(previews).toBe(1)
    expect(s.setup?.afterStop).toBe(true)
    expect(s.ledger?.state).toBe('paused')                         // nothing changed on the host
    await confirmSetup()                                            // not stopped yet: the refreshed card starts nothing
    expect(log.filter((x) => x === 'host:record')).toEqual([])
    await stopSession()
    await settle()
    expect(useStudioLive.getState().ledger?.state).toBe('stopped')
    await confirmSetup()                                            // confirmed stopped: now it may start a new session
    expect(log).toContain('host:record')
  })
  it('a resume refused for a reason with nowhere new to go (not_paused, studio_stopping) reads no refreshed card', async () => {
    for (const code of ['not_paused', 'studio_stopping']) {
      resetStudioLiveForTests()
      const e = await fail(409, code)
      const c = control(() => { throw e }) as Record<string, unknown>
      let previews = 0
      c.studioSetupProposal = async () => { previews++; return proposal }
      useHive.setState({ client: c as never })
      await started()
      ledgerRaw.state = 'paused'
      const { refresh, resumeSession } = await import('./store')
      await refresh()
      await resumeSession()
      await settle()
      expect(useStudioLive.getState().control?.refusal?.code).toBe(code)
      expect(previews).toBe(0)
      ledgerRaw.state = 'active'
    }
  })
  it('Finish stopping is offered ONCE: a second press sends nothing', async () => {
    useHive.setState({ client: control(() => ({ state: 'stopping' })) as never })
    await started()
    const { finishStopping } = await import('./store')
    log = []
    await finishStopping()
    await finishStopping()
    await settle()
    expect(log.filter((x) => x.startsWith('host:control'))).toEqual(['host:control:finish_stopping'])
    expect(useStudioLive.getState().finishUsed).toBe(true)
  })
  it('a lost control answer retries the SAME control id once (host idempotency), then says it is not confirmed', async () => {
    const ids: string[] = []
    const e = await fail(0, 'network')
    useHive.setState({ client: control((_s, b) => { ids.push(b.control_id); throw e }) as never })
    await started()
    const { pauseSession } = await import('./store')
    await pauseSession()
    await settle()
    expect(ids.length).toBe(2)
    expect(ids[0]).toBe(ids[1])
    expect(useStudioLive.getState().control?.state).toBe('refused')
  })
})

describe('r1.7: resume refusals take their real next step; Finish stopping per park; own key; R6.2 publish', () => {
  const ctlClient = (fn: (b: { control_id: string; action: string }) => unknown) => {
    const c = fakeClient() as unknown as Record<string, unknown>
    c.studioControl = async (_sid: string, b: { control_id: string; action: string }) => { log.push(`host:control:${b.action}`); return fn(b) }
    return c
  }
  it('only consent_mismatch reads a refreshed card: money and drift at resume read none and leave the session paused', async () => {
    const { ApiError } = await import('../../api/client')
    for (const [status, code, next] of [[402, 'budget_exhausted', 'none'], [402, 'spend_limit', 'none'], [409, 'model_drift', 'stop-then-new'], [409, 'key_drift', 'stop-then-new'], [409, 'payer_mismatch', 'stop-then-new'], [409, 'role_drift', 'stop-then-new'], [409, 'consent_mismatch', 'confirm-new-card']] as const) {
      resetStudioLiveForTests()
      ledgerRaw.state = 'active'
      const c = ctlClient((b) => { if (b.action === 'resume') throw new ApiError(status, code, 'x'); return {} })
      let previews = 0
      c.studioSetupProposal = async () => { previews++; return proposal }
      useHive.setState({ client: c as never })
      await started()
      ledgerRaw.state = 'paused'
      const { refresh, resumeSession } = await import('./store')
      await refresh()
      await resumeSession()
      await settle()
      const s = useStudioLive.getState()
      expect([code, s.control?.refusal?.next]).toEqual([code, next])
      expect([code, previews]).toEqual([code, code === 'consent_mismatch' ? 1 : 0])
      expect([code, !!s.setup?.afterStop]).toEqual([code, code === 'consent_mismatch'])
      expect(s.ledger?.state).toBe('paused')
    }
  })
  it('Finish stopping re-arms when the host parks the Stop anew (finish_stopping false -> true), one press per park', async () => {
    useHive.setState({ client: ctlClient(() => ({ state: 'stopping' })) as never })
    await started()
    const { finishStopping, refresh } = await import('./store')
    ledgerRaw.state = 'stopping'
    ledgerRaw.stop = { state: 'stopping', stop_failed: true, finish_stopping: true, in_flight: 0 }
    await refresh()
    log = []
    await finishStopping()
    await finishStopping()                                         // same park: nothing more
    ledgerRaw.stop = { state: 'stopping', stop_failed: false, finish_stopping: false, in_flight: 0 }
    await refresh()                                                // the press cleared the flags
    await finishStopping()                                         // not offered: nothing sent
    ledgerRaw.stop = { state: 'stopping', stop_failed: true, finish_stopping: true, in_flight: 0, message: 'Studio’s mind couldn’t be stopped. An administrator must stop the process.' }
    await refresh()                                                // parked again
    expect(useStudioLive.getState().finishUsed).toBe(false)
    await finishStopping()
    await settle()
    expect(log.filter((x) => x.startsWith('host:control'))).toEqual(['host:control:finish_stopping', 'host:control:finish_stopping'])
  })
  it('own_key_needed at setup: the card says so with Keys, nothing is retried automatically; Try again sends once more', async () => {
    const { ApiError } = await import('../../api/client')
    submitFails = [new ApiError(402, 'own_key_needed', 'x')]
    proposeSetup(proposal)
    await confirmSetup()
    await settle()
    const card = useStudioLive.getState().setup
    expect(card?.state).toBe('refused')
    expect(card?.refusal?.code).toBe('own_key_needed')
    expect(card?.refusal?.remedy?.go).toBe('keys')
    expect(log.filter((x) => x === 'host:submit')).toEqual(['host:submit'])   // once; no automatic retry
    await confirmSetup()                                                        // r1.9: the refused (stale) card can't be resubmitted
    await settle()
    expect(log.filter((x) => x === 'host:submit')).toEqual(['host:submit'])
  })
  it('R6.2: a step re-announced after an idempotent second publish (same revision) is forwarded to the frame ONCE', async () => {
    await started()
    attachFrame(port(1))
    await settle()
    const tuple = { seq: 1, body_sha256: H('a'), scene_ref: ref(3), edit_generation: 7 }
    addStep(1, { piece_read: tuple })
    const { refresh } = await import('./store')
    await refresh()
    ;(ledgerRaw.steps as Record<string, unknown>[])[0].studio_already_started = 'possible'   // maker-side marker: ignored
    await refresh()
    await refresh()
    expect(log.filter((x) => x === 'frame1:studio-live-step')).toEqual(['frame1:studio-live-step'])
  })
})

describe('r1.8: a setup refused for a changed key, model or payer (or own_key_needed) shows a FRESH card; never the old one', () => {
  /** the card the host would show NOW: the resolved value actually changed between the refusal and the retry */
  const changed = (what: 'key' | 'model' | 'payer'): SetupProposal => {
    const consent = { ...proposal.consent, ...(what === 'key' ? { key_id: 'k_mine' } : what === 'model' ? { model: 'invented-model-2' } : { payer: 'hive_key' as const }) }
    return { ...proposal, operation_id: 'op_inv2', consent, consent_digest: `sha256:${'e'.repeat(64)}`, request: { ...proposal.request, ...(what === 'key' ? { key_id: 'k_mine' } : what === 'model' ? { model: 'invented-model-2' } : {}) }, key_label: what === 'key' ? 'my own key' : proposal.key_label }
  }
  const sentKeys = () => recorded.map((r) => `${r.key_id}/${r.model}/${String(r.consent_digest).slice(7, 10)}`)
  for (const [code, what, line] of [['key_drift', 'key', /^Paid by: your own key “invented key” → your own key “my own key”$/], ['model_drift', 'model', /^Model: invented-model → invented-model-2$/], ['payer_mismatch', 'payer', /^Paid by: your own key “invented key” → this hive’s key “invented key”$/], ['consent_mismatch', 'key', /^Paid by: .* → .*my own key/]] as const) {
    it(`${code}: the fresh card names what changed (old → new) and waits for an explicit confirm; the old card is never resubmitted`, async () => {
      const { ApiError } = await import('../../api/client')
      const c = fakeClient() as unknown as Record<string, unknown>
      let previews = 0
      c.studioSetupProposal = async () => { previews++; return changed(what) }
      useHive.setState({ client: c as never })
      submitFails = [new ApiError(409, code, 'x')]
      proposeSetup(proposal)
      await confirmSetup()
      await settle()
      const card = useStudioLive.getState().setup!
      expect(previews).toBe(1)
      expect(card.state).toBe('needs-reconfirm')                     // no auto-confirm
      expect(card.proposal.consent_digest).toBe(changed(what).consent_digest)
      expect(card.changes?.some((x) => line.test(x))).toBe(true)
      expect(card.notice).toMatch(/nothing was started/)
      expect(log.filter((x) => x === 'host:submit').length).toBe(1)
      await confirmSetup()                                            // the person confirms the NEW card
      await settle()
      expect(sentKeys()[1]).toBe(`${changed(what).request.key_id}/${changed(what).request.model}/eee`)
    })
  }
  it('own_key_needed → the person adds their key → Try again reads a FRESH card naming the new key; nothing is sent until they confirm', async () => {
    const { ApiError } = await import('../../api/client')
    const c = fakeClient() as unknown as Record<string, unknown>
    let current: SetupProposal = proposal
    c.studioSetupProposal = async () => current
    useHive.setState({ client: c as never })
    submitFails = [new ApiError(402, 'own_key_needed', 'x')]
    proposeSetup(proposal)
    await confirmSetup()
    await settle()
    expect(useStudioLive.getState().setup?.refusal?.code).toBe('own_key_needed')
    current = changed('key')                                          // they added their own key in Keys
    const { reviewAgain } = await import('./store')
    log = []
    await reviewAgain()
    await settle()
    const card = useStudioLive.getState().setup!
    expect(log).toEqual([])                                           // Try again sends nothing to admission
    expect(card.state).toBe('needs-reconfirm')
    expect(card.proposal.consent.key_id).toBe('k_mine')
    expect(card.changes).toContain('Paid by: your own key “invented key” → your own key “my own key”')
    await confirmSetup()
    await settle()
    expect(recorded.at(-1)?.key_id).toBe('k_mine')
  })
  it('the real sim host (R7): setup refuses own_key_needed; add the key; setup shows the card; a key change → key_drift → fresh card; confirming it admits', async () => {
    const { SimClient } = await import('../../api/sim/SimClient')
    const sim = new SimClient({ seed: 7, latency: false, autoStart: false, persona: 'person', studio: { keyNone: true } })
    useHive.setState({ client: sim as never })
    const { readSetupProposal } = await import('./store')
    const { setupRefusal } = await import('./refusals')
    const refused = await sim.studioSetupProposal('omegadesign', 's_forge').then(() => null, (e) => setupRefusal(e))
    expect(refused?.code).toBe('own_key_needed')
    expect(refused?.remedy?.go).toBe('keys')
    const host = (sim as unknown as { studio: { addOwnKey(): void; changeWorld(c: object): void } }).studio
    host.addOwnKey()
    const p = readSetupProposal(await sim.studioSetupProposal('omegadesign', 's_forge'))!
    expect(p.hostRequest).toBe(true)
    expect(p.maker?.name).toBe('Bellows')
    proposeSetup(p)
    host.changeWorld({ key: 'k_sim_newer', label: 'Your newer key (invented)' })
    await confirmSetup()                                              // key_drift → the card is invalidated, a fresh one loads
    await settle()
    const card = useStudioLive.getState().setup!
    expect(card.state).toBe('needs-reconfirm')
    expect(card.proposal.consent.key_id).toBe('k_sim_newer')
    expect(card.changes).toContain('Paid by: your own key “Your own key (invented)” → your own key “Your newer key (invented)”')
    await confirmSetup()
    await settle()
    expect(useStudioLive.getState().admission?.session_id).toMatch(/^ss_sim/)
  })

})

describe('r1.9: a failed refresh never leaves the stale card confirmable (stand-in r1.8 blocking)', () => {
  const changedKey = (): SetupProposal => ({ ...proposal, operation_id: 'op_inv3', consent: { ...proposal.consent, key_id: 'k_mine' }, consent_digest: `sha256:${'f'.repeat(64)}`, request: { ...proposal.request, key_id: 'k_mine' }, key_label: 'my own key' })
  const submits = () => log.filter((x) => x === 'host:submit').length
  it('drift: the old card is invalidated BEFORE the fetch; a failed fetch is refresh-failed; Start can’t reach the host; Try loading again re-fetches, never confirms', async () => {
    const { ApiError } = await import('../../api/client')
    const c = fakeClient() as unknown as Record<string, unknown>
    let release!: () => void
    let fail = true
    let previews = 0
    c.studioSetupProposal = async () => { previews++; await new Promise<void>((r) => { release = r }); if (fail) throw new ApiError(503, 'unavailable', 'x'); return changedKey() }
    useHive.setState({ client: c as never })
    submitFails = [new ApiError(409, 'key_drift', 'x')]
    proposeSetup(proposal)
    const first = confirmSetup()
    await until(() => previews === 1)
    expect(useStudioLive.getState().setup?.state).toBe('refreshing')       // invalidated before the fetch answered
    expect(useStudioLive.getState().setup?.stale).toBe(true)
    await confirmSetup()                                                    // a press while it loads: nothing sent
    expect(submits()).toBe(1)
    release()
    await first
    await settle()
    const s = useStudioLive.getState().setup!
    expect(s.state).toBe('refresh-failed')
    expect(s.refusal?.words).toBe('Couldn’t load the updated card. Nothing was started.')
    expect(s.proposal.consent_digest).toBe(proposal.consent_digest)          // the draft (shown values) is kept, for display
    await confirmSetup()                                                    // the stale card can't be confirmed
    await settle()
    expect(submits()).toBe(1)
    const { reviewAgain } = await import('./store')
    fail = false
    const again = reviewAgain()                                             // Try loading again: a re-fetch only
    await until(() => previews === 2)
    release()
    await again
    await settle()
    expect(submits()).toBe(1)                                               // still nothing confirmed
    expect(useStudioLive.getState().setup?.state).toBe('needs-reconfirm')
    expect(useStudioLive.getState().setup?.stale).toBeFalsy()
    await confirmSetup()                                                    // the person confirms the FRESH card
    await settle()
    expect(recorded.at(-1)?.key_id).toBe('k_mine')
  })
  it('own key: Try again with a failing fetch stays refresh-failed and stale; nothing reaches admission', async () => {
    const { ApiError } = await import('../../api/client')
    const c = fakeClient() as unknown as Record<string, unknown>
    let previews = 0
    c.studioSetupProposal = async () => { previews++; throw new ApiError(0, 'network', 'x') }
    useHive.setState({ client: c as never })
    submitFails = [new ApiError(402, 'own_key_needed', 'x')]
    proposeSetup(proposal)
    await confirmSetup()
    await settle()
    expect(useStudioLive.getState().setup?.stale).toBe(true)                // own key: the values are unusable at once
    const { reviewAgain } = await import('./store')
    await reviewAgain()
    await settle()
    const s = useStudioLive.getState().setup!
    expect(previews).toBe(1)
    expect(s.state).toBe('refresh-failed')
    expect(s.refusal?.words).toBe('Couldn’t load the updated card. Nothing was started.')
    await confirmSetup()
    await settle()
    expect(submits()).toBe(1)
  })
  it('a fresh card that does not parse is a failed load too (never the old one)', async () => {
    const { ApiError } = await import('../../api/client')
    const c = fakeClient() as unknown as Record<string, unknown>
    c.studioSetupProposal = async () => ({ not: 'a card' })
    useHive.setState({ client: c as never })
    submitFails = [new ApiError(409, 'model_drift', 'x')]
    proposeSetup(proposal)
    await confirmSetup()
    await settle()
    expect(useStudioLive.getState().setup?.state).toBe('refresh-failed')
    await confirmSetup()
    expect(submits()).toBe(1)
  })
})

describe('r1.10: the R7 setup card (POST /api/studio/setup)', () => {
  const prep = { operation_id: 'op_inv1', title: 'Invented poster', detail: 'invented', scene_id: 'scene_inv', max_steps: 12, window_minutes: 60, source_ref: { artifact_id: 'ar_inv_piece', revision: 2, digest: 'sha256:piece' }, studio_swarm: 's_mystudio' }
  const r7 = (over: Record<string, unknown> = {}) => ({
    maker: { id: 'a_m', name: 'My maker', swarm_id: 's_x', kind: 'omega' }, operation_id: 'op_inv1', prep,
    request: { ...proposal.request, app_pin: { id: 'omegadesign', version: '0.4.20', digest: 'sha256:pin' }, consent_digest: proposal.consent_digest },
    consent: proposal.consent, consent_digest: proposal.consent_digest, maker_name: 'My maker', key_label: 'my key', ...over,
  })
  it('a setup answer is read as a host card: its request is recorded UNCHANGED (never rebuilt from the consent)', async () => {
    const { readSetupProposal } = await import('./store')
    const p = readSetupProposal(r7())!
    expect([p.hostRequest, p.maker?.name, p.key_label]).toEqual([true, 'My maker', 'my key'])
    proposeSetup(p)
    await confirmSetup()
    await settle()
    expect(recorded[0]).toEqual(r7().request)
  })
  it('a setup answer whose request digest is not the card’s is refused (never shown as a card to confirm)', async () => {
    const { readSetupProposal } = await import('./store')
    expect(readSetupProposal(r7({ request: { ...r7().request, consent_digest: `sha256:${'9'.repeat(64)}` } }))).toBeNull()
  })
  it('a drift reads setup again WITH what the person chose (the same Ask turn and choice)', async () => {
    const { ApiError } = await import('../../api/client')
    const { readSetupProposal } = await import('./store')
    const c = fakeClient() as unknown as Record<string, unknown>
    const seen: unknown[] = []
    c.studioSetupProposal = async (_p: string, _s: string, pr: unknown) => { seen.push(pr); return r7({ consent_digest: `sha256:${'e'.repeat(64)}`, request: { ...r7().request, consent_digest: `sha256:${'e'.repeat(64)}` } }) }
    useHive.setState({ client: c as never })
    submitFails = [new ApiError(409, 'studio_maker_missing', 'x')]
    proposeSetup(readSetupProposal(r7())!)
    await confirmSetup()
    await settle()
    expect(seen).toEqual([prep])
    expect(useStudioLive.getState().setup?.state).toBe('needs-reconfirm')
  })
  it('the session’s own Studio space differs from the swarm open here: receiving waits and says where it draws', async () => {
    await started()
    ledgerRaw.swarm_id = 's_mystudio'
    const { refresh, ELSEWHERE } = await import('./store')
    await refresh()
    attachFrame(port(1))
    await settle()
    expect(log.filter((x) => x.startsWith('frame1:studio-live-open'))).toEqual([])
    expect(useStudioLive.getState().openHold).toBe(ELSEWHERE)
  })
  it('prepFromAsk: the latest own Ask turn with words (its op and words); none → null', async () => {
    const { prepFromAsk } = await import('./store')
    useAskStore.setState({ log: [], turns: {} } as never)
    expect(prepFromAsk()).toBeNull()
    useAskStore.setState({ log: [{ kind: 'turn', op: 'op_a' }, { kind: 'turn', op: 'op_b' }], turns: { op_a: { op: 'op_a', you: 'first', state: 'done' }, op_b: { op: 'op_b', you: 'a poster for the picnic', state: 'done' } } } as never)
    const p = prepFromAsk()!
    expect([p.operation_id, p.title, p.detail]).toEqual(['op_b', 'a poster for the picnic', 'a poster for the picnic'])
    expect('scene_id' in p).toBe(false)                              // r1.13: never a random scene
  })
})

describe('r1.10 on R7.3 (a80972e1): the live capability shape, own key on setup-again, the way into the Ask', () => {
  /** GET /api/me/ask as R7.3's Ask.capabilities() answers it (both Studio flags together, or both absent) */
  const r73 = (studio: boolean) => ({ swarm_id: null, thread_budget_usd: 5, capabilities: { conductor: true, memory: true, ...(studio ? { studio_sessions: true, studio_directions: true } : {}) } })
  it('studio_sessions + studio_directions as R7.3 publishes them: live Studio and steering are offered; absent: neither', async () => {
    const { studioCapable } = await import('./api')
    const c = fakeClient()
    useAskStore.setState({ settings: r73(true) } as never)
    expect(studioCapable(c as never, useAskStore.getState().settings)).toBe(true)
    await started()
    const { steerSession } = await import('./store')
    expect(await steerSession('warmer please')).toBe(true)                     // directions offered by the host flag
    expect(log).toContain('host:steer:warmer please')
    expect(studioCapable(c as never, r73(false) as never)).toBe(false)
    expect(studioCapable(c as never, { capabilities: { conductor: true, memory: true, studio_sessions: 'true' } } as never)).toBe(false)
  })
  it('studio_sessions without studio_directions (an older host): drawing yes, steering held with the words kept', async () => {
    useAskStore.setState({ settings: { swarm_id: null, thread_budget_usd: 5, capabilities: { conductor: true, memory: true, studio_sessions: true } } } as never)
    await started()
    const { steerSession } = await import('./store')
    expect(await steerSession('bigger')).toBe(false)
    expect(useStudioLive.getState().held.map((h) => h.text)).toEqual(['bigger'])
  })
  it('key_drift (R7.2 not_own_key) → setup again answers own_key_needed → the own-key card (Keys + Try again), still stale', async () => {
    const { ApiError } = await import('../../api/client')
    const c = fakeClient() as unknown as Record<string, unknown>
    c.studioSetupProposal = async () => { throw new ApiError(402, 'own_key_needed', 'x', { envelope: { code: 'own_key_needed', message: 'x', scope: 'studio_maker' } }) }
    useHive.setState({ client: c as never })
    submitFails = [new ApiError(409, 'key_drift', 'x', { envelope: { code: 'key_drift', message: 'x', reason: 'not_own_key' } })]
    proposeSetup(proposal)
    await confirmSetup()
    await settle()
    const s = useStudioLive.getState().setup!
    expect([s.state, s.stale, s.refusal?.code, s.refusal?.remedy?.go]).toEqual(['refused', true, 'own_key_needed', 'keys'])
    await confirmSetup()
    expect(log.filter((x) => x === 'host:submit').length).toBe(1)
  })
  it('a named setup refusal on the reload says what it is after the plain line', async () => {
    const { ApiError } = await import('../../api/client')
    const c = fakeClient() as unknown as Record<string, unknown>
    c.studioSetupProposal = async () => { throw new ApiError(409, 'studio_maker_unavailable', 'x') }
    useHive.setState({ client: c as never })
    submitFails = [new ApiError(409, 'model_drift', 'x')]
    proposeSetup(proposal)
    await confirmSetup()
    await settle()
    expect(useStudioLive.getState().setup?.refusal?.words).toMatch(/^Couldn’t load the updated card\. Nothing was started\. This hive can’t make your own Studio maker yet/)
  })
  it('“Studio starts from your Ask”: the way in opens the Ask (and focuses its field where there is a page)', async () => {
    const { focusAsk } = await import('./store')
    useAskStore.setState({ threadOpen: false } as never)
    focusAsk()
    expect(useAskStore.getState().threadOpen).toBe(true)
  })
})

describe('r1.11: per-person setup state never crosses a sign-in; every R7.3 admission refusal is classified', () => {
  const prepA = { operation_id: 'op_A_turn', title: 'A’s private poster', detail: 'A’s words', scene_id: 'scene_A', max_steps: 12, window_minutes: 60, source_ref: { artifact_id: 'ar_inv_piece', revision: 2, digest: 'sha256:piece' }, studio_swarm: 's_mystudio' }
  const resumeRefusedClient = async (seen: unknown[]) => {
    const { ApiError } = await import('../../api/client')
    const c = fakeClient() as unknown as Record<string, unknown>
    c.studioControl = async (_s: string, b: { action: string }) => { log.push(`host:control:${b.action}`); if (b.action === 'resume') throw new ApiError(409, 'consent_mismatch', 'x'); return {} }
    c.studioSetupProposal = async (_p: string, _s: string, pr: unknown) => { seen.push(pr ?? null); return proposal }
    return c
  }
  it('P1: A’s remembered choice is gone after a sign-in change: B’s resume refresh sends nothing of A’s', async () => {
    const seen: unknown[] = []
    useHive.setState({ client: (await resumeRefusedClient(seen)) as never })
    const { rememberPrep, refresh, resumeSession } = await import('./store')
    rememberPrep(prepA)                                                   // A chose on the app page
    bump()                                                                // the sign-in changes (identity epoch)...
    useAskStore.setState({ bound: { session: 'inv2', principal: 'user:p_b', auth: null } } as never)   // ...to B
    expect(useStudioLive.getState().setup).toBeNull()
    offer(true)                                                           // B's own Ask settings (the sign-in reread them)
    await started()                                                       // B's own session
    ledgerRaw.state = 'paused'
    await refresh()
    await resumeSession()
    await settle()
    expect(seen).toEqual([null])                                          // setup again carried no prep at all
    expect(JSON.stringify(seen)).not.toContain('A’s')
  })
  it('the identity change itself clears the choice (even when the same person signs in again)', async () => {
    const seen: unknown[] = []
    useHive.setState({ client: (await resumeRefusedClient(seen)) as never })
    const { rememberPrep, refresh, resumeSession } = await import('./store')
    rememberPrep(prepA)
    bump()                                                                // a sign-in change (the Ask unbinds)...
    useAskStore.setState({ bound: { session: 'inv3', principal: 'user:p_a', auth: null } } as never)   // ...the same person again
    offer(true)
    await started()
    ledgerRaw.state = 'paused'
    await refresh()
    await resumeSession()
    await settle()
    expect(seen).toEqual([null])
  })
  it('the choice is bound to its person: another principal never reads it (defence in depth, no epoch change)', async () => {
    const seen: unknown[] = []
    useHive.setState({ client: (await resumeRefusedClient(seen)) as never })
    const { rememberPrep, refresh, resumeSession } = await import('./store')
    await started()
    rememberPrep(prepA)
    useAskStore.setState({ bound: { session: 'inv', principal: 'user:p_other', auth: null } } as never)
    offer(true)
    ledgerRaw.state = 'paused'
    await refresh()
    await resumeSession()
    await settle()
    expect(seen).toEqual([null])
  })
  it('control: for the SAME person the remembered choice is used for the resume refresh', async () => {
    const seen: unknown[] = []
    useHive.setState({ client: (await resumeRefusedClient(seen)) as never })
    const { rememberPrep, refresh, resumeSession } = await import('./store')
    await started()
    rememberPrep(prepA)
    ledgerRaw.state = 'paused'
    await refresh()
    await resumeSession()
    await settle()
    expect(seen).toEqual([prepA])
  })
  it('the identity change resets every per-person store field (card, directions, next turns, held words, controls, latch)', async () => {
    await started()
    useStudioLive.setState({ held: [{ id: 'h', text: 'x', refusal: { code: 'c', words: 'w', keepWords: true } }], next: [{ id: 'n', text: 't', context: {} as never, from: null }], finishUsed: true, control: { action: 'pause', state: 'refused', refusal: null } } as never)
    bump()
    const s = useStudioLive.getState()
    expect([s.setup, s.admission, s.ledger, s.held, s.sent, s.next, s.control, s.finishUsed, s.principal]).toEqual([null, null, null, [], [], [], null, false, null])
  })
  it('P2: maker_not_member (the maker was deleted) invalidates the card and sets up again; the old card can’t be resubmitted', async () => {
    const { ApiError } = await import('../../api/client')
    const c = fakeClient() as unknown as Record<string, unknown>
    let previews = 0
    let release!: () => void
    c.studioSetupProposal = async () => { previews++; await new Promise<void>((r) => { release = r }); return { ...proposal, operation_id: 'op_inv9', consent_digest: `sha256:${'d'.repeat(64)}` } }
    useHive.setState({ client: c as never })
    submitFails = [new ApiError(409, 'maker_not_member', 'x')]
    proposeSetup(proposal)
    const first = confirmSetup()
    await until(() => previews === 1)
    expect(useStudioLive.getState().setup?.stale).toBe(true)
    await confirmSetup()
    expect(log.filter((x) => x === 'host:submit').length).toBe(1)        // was 2/2 in r1.10 (the stand-in's repro)
    release()
    await first
    await settle()
    expect(useStudioLive.getState().setup?.state).toBe('needs-reconfirm')
  })
  for (const code of ['maker_kind_unsupported', 'execution_binding_unqualified', 'app_not_attached', 'maker_is_coordinator', 'source_not_bindable', 'own_key_only']) {
    it(`${code}: the card is stale (no Start, nothing resubmitted) with setup words`, async () => {
      const { ApiError } = await import('../../api/client')
      submitFails = [new ApiError(409, code, 'x')]
      proposeSetup(proposal)
      await confirmSetup()
      await settle()
      const s = useStudioLive.getState().setup!
      expect([s.state, s.stale]).toEqual(['refused', true])
      expect(s.refusal?.words).not.toMatch(/can’t resume/)
      await confirmSetup()
      expect(log.filter((x) => x === 'host:submit').length).toBe(1)
    })
  }
  // r1.12: the explicit rule — after ANY refusal of the record or submit, the SAME card is never submitted twice.
  // Every R7.3 admission / record / submit refusal is driven through confirm twice: at most one record and one submit
  // attempt, unless the person explicitly presses Try again on a transient code (which reads a FRESH card first).
  const ALL_R73: [number, string, Record<string, unknown>?][] = [
    [409, 'key_drift'], [409, 'key_drift', { reason: 'not_own_key' }], [409, 'model_drift'], [409, 'role_drift'], [409, 'payer_mismatch'], [409, 'consent_mismatch'],
    [409, 'studio_maker_missing'], [409, 'maker_not_member'], [409, 'maker_not_yours'], [409, 'maker_kind_unsupported'], [409, 'execution_binding_unqualified'],
    [409, 'app_not_attached'], [409, 'maker_is_coordinator'], [409, 'source_not_bindable'], [403, 'person_required'], [403, 'own_key_only'], [402, 'own_key_needed'],
    [409, 'maker_busy'], [409, 'maker_busy', { reason: 'studio_owned' }], [409, 'person_session_live'], [409, 'execution_fenced'], [409, 'intent_in_flight'], [409, 'intent_pending'],
    [409, 'operation_conflict'], [429, 'rate_limited'], [402, 'spend_limit'], [402, 'budget_exhausted'], [402, 'own_key_required'], [402, 'no_key_grant'],
    [400, 'bad_request', { reason: 'turn_too_old' }], [404, 'not_available'], [0, 'network'], [503, 'unavailable'],
  ]
  it('every R7.3 refusal: confirming the refused card again never sends it twice; Start is gone', async () => {
    const { ApiError } = await import('../../api/client')
    for (const [status, code, env] of ALL_R73) {
      resetStudioLiveForTests()
      log = []
      const c = fakeClient() as unknown as Record<string, unknown>
      c.studioSetupProposal = async () => proposal                    // a refresh (drift codes) shows a fresh card
      useHive.setState({ client: c as never })
      submitFails = [new ApiError(status, code, 'x', { envelope: { code, message: 'x', ...(env ?? {}) } })]
      proposeSetup(proposal)
      await confirmSetup()
      await settle()
      const after = useStudioLive.getState().setup
      if (after?.state === 'needs-reconfirm') continue                  // a FRESH card (drift): a new card, not this one
      await confirmSetup()
      await confirmSetup()
      await settle()
      const label = `${status} ${code} ${JSON.stringify(env ?? {})}`
      expect([label, log.filter((x) => x === 'host:record').length, log.filter((x) => x === 'host:submit').length]).toEqual([label, 1, 1])
      expect([label, useStudioLive.getState().setup?.stale]).toEqual([label, true])
    }
  })
  it('a transient refusal: the person’s deliberate Try again reads the current card first, then confirming it sends once more', async () => {
    const { ApiError } = await import('../../api/client')
    const c = fakeClient() as unknown as Record<string, unknown>
    let previews = 0
    c.studioSetupProposal = async () => { previews++; return { ...proposal, operation_id: 'op_inv5', consent_digest: `sha256:${'b'.repeat(64)}` } }
    useHive.setState({ client: c as never })
    submitFails = [new ApiError(409, 'maker_busy', 'x')]
    proposeSetup(proposal)
    await confirmSetup()
    await settle()
    const { refusedCardActions, reviewAgain } = await import('./store')
    expect(refusedCardActions(useStudioLive.getState().setup!.refusal)).toEqual({ ask: false, again: true, pick: false })
    await reviewAgain()
    await settle()
    expect(previews).toBe(1)                                          // the current state was read first
    expect(useStudioLive.getState().setup?.state).toBe('needs-reconfirm')
    await confirmSetup()
    await settle()
    expect(log.filter((x) => x === 'host:submit').length).toBe(2)
  })
  it('turn_too_old: stale, the new words, only "Ask what to draw" (a NEW Ask turn), never a resend', async () => {
    const { ApiError } = await import('../../api/client')
    submitFails = [new ApiError(400, 'bad_request', 'x', { envelope: { code: 'bad_request', message: 'x', reason: 'turn_too_old' } })]
    proposeSetup(proposal)
    await confirmSetup()
    await settle()
    const s = useStudioLive.getState().setup!
    const { refusedCardActions } = await import('./store')
    expect([s.stale, s.refusal?.words]).toEqual([true, 'This Studio request came from an Ask message that’s now too old. Ask what to draw again.'])
    expect(refusedCardActions(s.refusal)).toEqual({ ask: true, again: false, pick: false })
  })
  it('404 not_available at admission: honest ambiguous words (no reason is sent), "Ask what to draw" and "Set up again"', async () => {
    const { ApiError } = await import('../../api/client')
    submitFails = [new ApiError(404, 'not_available', 'x')]
    proposeSetup(proposal)
    await confirmSetup()
    await settle()
    const s = useStudioLive.getState().setup!
    const { refusedCardActions } = await import('./store')
    expect(s.stale).toBe(true)
    expect(s.refusal?.words).toBe('Studio can’t start this right now: Studio may be off here, or the Ask message or space it came from is gone. Nothing was started.')
    expect(refusedCardActions(s.refusal)).toEqual({ ask: true, again: true, pick: false })
  })
})

describe('r1.13: the session draws on the person’s picked SAVED canvas, read exactly; ready only once the receiver mounts', () => {
  const turn = { operation_id: 'op_inv1', title: 'Invented poster', detail: 'invented', max_steps: 12, window_minutes: 60 }
  const ref = { artifact_id: 'ar_inv_piece', revision: 2, digest: 'sha256:piece' }
  const hostCalls = () => log.filter((x) => /host:(record|submit)/.test(x))
  let routes: unknown[] = []
  const withSetup = () => {
    const c = fakeClient() as unknown as Record<string, unknown>
    const seen: unknown[] = []
    c.studioSetupProposal = async (_p: string, _s: string, pr: { scene_id: string; source_ref: unknown; studio_swarm: string }) => { seen.push(pr); return { ...proposal, prep: pr, request: { ...proposal.request, swarm_id: pr.studio_swarm, piece: { scene_id: pr.scene_id, source_ref: pr.source_ref } } } }
    useHive.setState({ client: c as never })
    return { c, seen }
  }
  beforeEach(async () => { routes = []; const { setRouteForTests } = await import('./store'); setRouteForTests((r) => { routes.push(r) }) })
  afterEach(async () => { const { setRouteForTests } = await import('./store'); setRouteForTests(null) })
  it('lists ONLY the person’s own Studio space (setup {} names it), kind studio-source', async () => {
    withSetup()
    const { beginLiveStudio } = await import('./store')
    await beginLiveStudio('omegadesign', turn)
    expect(log.filter((x) => x.startsWith('host:list'))).toEqual(['host:list:s_mystudio:studio-source'])
    expect(useStudioLive.getState().pick?.state).toBe('list')
  })
  it('no saved canvas: "Save a canvas in your Studio space first", an open-Studio way, and NO setup card or host session call', async () => {
    const { seen } = withSetup()
    listed = []
    const { beginLiveStudio, NO_PIECES_WORDS } = await import('./store')
    await beginLiveStudio('omegadesign', turn)
    const p = useStudioLive.getState().pick!
    expect([p.state, p.note, p.swarm]).toEqual(['none', NO_PIECES_WORDS, 's_mystudio'])
    expect(NO_PIECES_WORDS).toBe('Save a canvas in your Studio space first.')
    expect(seen).toEqual([])
    expect(hostCalls()).toEqual([])
    expect(useStudioLive.getState().setup).toBeNull()
  })
  it('app_inactive (R7 before R8.2) on the list or the read: "Studio isn’t ready in your space yet", nothing admitted', async () => {
    const { ApiError } = await import('../../api/client')
    const { c, seen } = withSetup()
    c.swarmArtifacts = async () => { throw new ApiError(409, 'app_inactive', 'x') }
    const { beginLiveStudio, pickPiece, PIECES_UNAVAILABLE_WORDS } = await import('./store')
    await beginLiveStudio('omegadesign', turn)
    expect([useStudioLive.getState().pick?.state, useStudioLive.getState().pick?.note]).toEqual(['unavailable', PIECES_UNAVAILABLE_WORDS])
    c.swarmArtifacts = async () => listed
    c.programView = async () => { throw new ApiError(403, 'forbidden', 'That app isn’t active in this swarm.', { envelope: { code: 'forbidden', message: 'x', refusal_code: 'app_inactive' } }) }
    await beginLiveStudio('omegadesign', turn)
    await pickPiece(ref)
    expect([useStudioLive.getState().pick?.state, useStudioLive.getState().pick?.note]).toEqual(['unavailable', PIECES_UNAVAILABLE_WORDS])
    expect(seen).toEqual([])
    expect(hostCalls()).toEqual([])
  })
  it('pick: the scene id is the VERIFIED source’s current scene id (Studio’s view of that exact ref), the ref is exact', async () => {
    const { seen } = withSetup()
    sceneOf = { ar_inv_piece: 'garden-invitation-7' }
    const { beginLiveStudio, pickPiece } = await import('./store')
    await beginLiveStudio('omegadesign', turn)
    expect(log).toContain('host:list:s_mystudio:studio-source')
    await pickPiece(ref)
    expect(log).toContain('host:view:s_mystudio')
    expect(seen).toEqual([{ ...turn, scene_id: 'garden-invitation-7', source_ref: ref, studio_swarm: 's_mystudio' }])
    expect(useStudioLive.getState().setup?.proposal.request.piece).toEqual({ scene_id: 'garden-invitation-7', source_ref: ref })
  })
  it('a view that answers another reference, or a deck, is never used (no card)', async () => {
    const { c, seen } = withSetup()
    const { beginLiveStudio, pickPiece } = await import('./store')
    c.programView = async () => ({ revision: 'r', items: [{ id: 'editable-source', data: { reference: { ...ref, revision: 3 }, source: { schema: 'omega-studio-source-1', current: { scene: { id: 'x' } } } } }] })
    await beginLiveStudio('omegadesign', turn)
    await pickPiece(ref)
    c.programView = async () => ({ revision: 'r', items: [{ id: 'editable-source', data: { reference: ref, source: { schema: 'omega-scene-deck-1', current: { scene: { id: 'x' } } } } }] })
    await beginLiveStudio('omegadesign', turn)
    await pickPiece(ref)
    expect(seen).toEqual([])
    expect(useStudioLive.getState().pick?.note).toMatch(/isn’t a canvas Studio can draw on live/)
  })
  it('at the call: a canvas no longer listed, or whose scene changed, starts NOTHING (pick again)', async () => {
    withSetup()
    const { beginLiveStudio, pickPiece, PIECE_CHANGED_WORDS, refusedCardActions } = await import('./store')
    await beginLiveStudio('omegadesign', turn)
    await pickPiece(ref)
    listed = [{ ...listed[0], revision: 3, digest: 'sha256:newer' }]          // saved again since the pick
    await confirmSetup()
    await settle()
    expect(hostCalls()).toEqual([])                                     // nothing reached the host
    expect(useStudioLive.getState().setup).not.toBeNull()               // the card is still there (refused), not admitted
    const s = useStudioLive.getState().setup!
    expect([s.stale, s.refusal?.words]).toEqual([true, PIECE_CHANGED_WORDS])
    expect(refusedCardActions(s.refusal)).toEqual({ ask: false, again: false, pick: true })
    expect(hostCalls()).toEqual([])
    resetStudioLiveForTests()
    listed = [{ artifact_id: 'ar_inv_piece', kind: 'studio-source', title: 'x', revision: 2, digest: 'sha256:piece' }]
    withSetup()
    await beginLiveStudio('omegadesign', turn)
    await pickPiece(ref)
    sceneOf = { ar_inv_piece: 'another-scene' }
    await confirmSetup()
    await settle()
    expect(useStudioLive.getState().setup?.refusal?.code).toBe('piece_changed')
    expect(hostCalls()).toEqual([])
  })
  it('after admission: Studio opens on that exact canvas, in the person’s Studio space, in the app’s OWN view; “Opening your piece…” until the receiver mounts', async () => {
    withSetup()
    const { beginLiveStudio, pickPiece, pieceOpening } = await import('./store')
    await beginLiveStudio('omegadesign', turn)
    await pickPiece(ref)
    await confirmSetup()
    await settle()
    expect(routes).toEqual([{ name: 'program', id: 'omegadesign', swarm: 's_mystudio', source: ref, view: 'studio' }])
    expect(pieceOpening(useStudioLive.getState())).toBe(true)        // no frame (e.g. Surface's form view): never ready
    attachFrame(port(1))
    await settle()
    expect(pieceOpening(useStudioLive.getState())).toBe(true)        // a frame alone is not a match
    framePiece(1, 'ss_a', capture(3))                                 // the receiver mounted: its first acknowledged piece
    await settle()
    expect(pieceOpening(useStudioLive.getState())).toBe(false)
  })
  it('unsaved work in Studio while it opens: says so; never re-opens or clears it (one navigation only)', async () => {
    withSetup()
    const { beginLiveStudio, pickPiece, noteFrameDirty } = await import('./store')
    await beginLiveStudio('omegadesign', turn)
    await pickPiece(ref)
    await confirmSetup()
    await settle()
    noteFrameDirty(true)
    await settle()
    expect(useStudioLive.getState().frameDirty).toBe(true)
    expect(routes.length).toBe(1)
  })
  it('the fallbacks open the NATIVE view: "Open Studio where it draws" on the session’s exact admitted canvas; first use in the person’s space', async () => {
    const { openLiveCanvas, openStudioSpace, refresh } = await import('./store')
    await started()
    ledgerRaw.swarm_id = 's_mystudio'
    ledgerRaw.piece = { scene_id: 'garden-invitation-7', source_ref: ref }
    await refresh()
    expect(useStudioLive.getState().ledger?.piece_source).toEqual(ref)
    openLiveCanvas()
    openStudioSpace('omegadesign', 's_mystudio')
    expect(routes).toEqual([
      { name: 'program', id: 'omegadesign', swarm: 's_mystudio', source: ref, view: 'studio' },
      { name: 'program', id: 'omegadesign', swarm: 's_mystudio', view: 'studio' },
    ])
  })
  it('source_not_bindable (host _source): honest words and "Pick a canvas" (never this card again)', async () => {
    const { ApiError } = await import('../../api/client')
    withSetup()
    const { beginLiveStudio, pickPiece, refusedCardActions } = await import('./store')
    await beginLiveStudio('omegadesign', turn)
    await pickPiece(ref)
    submitFails = [new ApiError(409, 'source_not_bindable', 'x')]
    await confirmSetup()
    await settle()
    const s = useStudioLive.getState().setup!
    expect(s.refusal?.words).toMatch(/isn’t a saved canvas in your own Studio space/)
    expect(refusedCardActions(s.refusal)).toEqual({ ask: false, again: false, pick: true })
  })
})

describe('r1.6: host R5 directions', () => {
  it('a steer on a stopping session (409 studio_session_closed) keeps the words with plain words; nothing is shown as sent', async () => {
    const { ApiError } = await import('../../api/client')
    const c = fakeClient() as Record<string, unknown>
    c.askSteer = async () => { throw new ApiError(409, 'studio_session_closed', 'x') }
    useHive.setState({ client: c as never })
    await started()
    const { steerSession } = await import('./store')
    expect(await steerSession('make it warmer')).toBe(false)
    const s = useStudioLive.getState()
    expect(s.sent).toEqual([])
    expect(s.held.map((h) => [h.text, h.refusal.code])).toEqual([['make it warmer', 'studio_session_closed']])
  })
  it('a held session still takes directions (they queue, host R5 decision 3)', async () => {
    await started()
    ledgerRaw.state = 'held'
    const { refresh, steerSession } = await import('./store')
    await refresh()
    expect(await steerSession('later please')).toBe(true)
    expect(log).toContain('host:steer:later please')
  })
  it('a direction Stop cancelled can be asked as new work (its words were never read by the maker)', async () => {
    await started()
    const { alsoQueue, refresh, steerSession } = await import('./store')
    await steerSession('bigger headline', 'typed', { kind: 'none' } as never)
    ;(ledgerRaw.directions as { state: string }[])[0].state = 'cancelled'
    await refresh()
    const id = useStudioLive.getState().sent[0].steer_id
    alsoQueue(id)
    expect(useStudioLive.getState().next.map((n) => n.text)).toEqual(['bigger headline'])
  })
})

describe('r1.1: the capability is checked at every host call (stand-in P1-1, Kimi K-sharpest)', () => {
  it('a cached session after the capability is removed makes zero host calls', async () => {
    const { restoreHeld } = await import('./store')
    offer(false)
    let reads = 0
    const c = fakeClient()
    c.studioSession = async () => { reads++; return ledgerRaw }
    useHive.setState({ client: c as never })   // (a new client is an identity change: it clears the kept session, so keep it after)
    store.set('omegahive.studioLive.session', JSON.stringify({ principal: 'user:p_a', sid: 'ss_a', programId: 'omegadesign', swarmId: 's_x' }))
    restoreHeld()
    await settle()
    expect(reads).toBe(0)
    expect(log).toEqual([])
    const { runtimeForTests } = await import('./store')
    expect(runtimeForTests()).toBeNull()                             // nothing was even set up for it
    offer(true)                                                       // control: offered again, the cached session is read
    resetStudioLiveForTests()
    store.set('omegahive.studioLive.session', JSON.stringify({ principal: 'user:p_a', sid: 'ss_a', programId: 'omegadesign', swarmId: 's_x' }))
    restoreHeld()
    await settle()
    expect(reads).toBe(1)
  })
  it('the capability drops mid-session: receiving closes now, then no upload, outcome, direction or host stop is sent', async () => {
    const { steerSession } = await import('./store')
    await started()
    attachFrame(port(1))
    await settle()
    log = []
    offer(false)
    expect(log).toEqual(['frame1:studio-live-close'])
    expect(useStudioLive.getState().local).toBe('not-offered')
    framePiece(1, 'ss_a', capture(5))
    frameOutcome(1, 'ss_a', report(1, 5))
    await steerSession('bigger', 'typed', null)
    await stopSession()
    await settle()
    expect(log.filter((x) => x.startsWith('host:'))).toEqual([])
  })
  it('a setup card shown while offered cannot record or submit once the capability is gone', async () => {
    proposeSetup(proposal)
    offer(false)
    await confirmSetup()
    expect(log).toEqual([])
    expect(useStudioLive.getState().setup?.state).toBe('refused')
  })
})

describe('r1.1: reconfirmation sends exactly what the card shows (stand-in P1-3)', () => {
  it('after consent_mismatch the request, consent and digest move together; what is sent equals what is shown', async () => {
    const { ApiError } = await import('../../api/client')
    const fresh = { ...proposal.consent, cap_micros: 1_500_000, model: 'other-model', tools: ['palette'], piece: { scene_id: 'sim-poster', source_ref: { artifact_id: 'ar_src', revision: 2, digest: `sha256:${H('5')}` } } }
    const freshDigest = `sha256:${H('f')}`
    submitFails.push(new ApiError(409, 'consent_mismatch', 'x', { envelope: { code: 'consent_mismatch', consent: fresh, consent_digest: freshDigest } }))
    proposeSetup(proposal)
    await confirmSetup()
    const card = useStudioLive.getState().setup!
    expect(card.state).toBe('needs-reconfirm')
    expect(card.proposal.consent.model).toBe('other-model')
    await confirmSetup()
    await settle()
    const sent = recorded.at(-1)!
    expect(sent).toMatchObject({ model: 'other-model', tools: ['palette'], cap_usd: 1.5, consent_digest: freshDigest, piece: fresh.piece })
    expect(useStudioLive.getState().admission?.session_id).toBe('ss_a')   // no mismatch loop
  })
})

describe('r1.1: outcomes bind only to the exact observed snapshot (Design custody clarification)', () => {
  it('observed at generation 10 while the only acknowledged upload is generation 11 (a different snapshot): no outcome POST', async () => {
    await started()
    attachFrame(port(1))
    await settle()
    addStep(1)
    framePiece(1, 'ss_a', { body: '{"undone":11}', scene_ref: { scene_id: 'sim-poster', revision: 11, digest: `sha256:${H('b')}` }, edit_generation: 11, pending_fields: false })
    await settle()
    log = []
    frameOutcome(1, 'ss_a', { ...report(1, 10), piece_after: { scene_id: 'sim-poster', revision: 10, digest: `sha256:${H('a')}` }, piece_before: { scene_id: 'sim-poster', revision: 10, digest: `sha256:${H('a')}` } })
    await settle()
    expect(log.filter((x) => x.startsWith('host:outcome'))).toEqual([])
  })
})

describe('r1.1 remount disposition (owner decision) and studio.recover (frozen with Design, 0355Z)', () => {
  const read = (n: number) => ({ piece_read: { seq: n, body_sha256: H('a'), scene_ref: ref(2), edit_generation: 2 } })
  async function progressedThenReopened() {
    await started()
    attachFrame(port(1))
    await settle()
    for (const n of [1, 2, 3]) addStep(n, read(n))
    const { refresh } = await import('./store')
    await refresh()
    detachFrame(1)
    attachFrame(port(2))
    await settle()
    return refresh
  }
  it('a reopened view after 3 steps forwards no history; its first acknowledged capture brings one studio.recover (k = 3, the upload), then step 4 forwards', async () => {
    const refresh = await progressedThenReopened()
    expect(useStudioLive.getState().remount).toBe('held')
    expect(posts.filter((p) => p.mount === 2 && p.msg.type === 'studio-live-step')).toEqual([])
    log = []
    frameOutcome(2, 'ss_a', { ...report(2, 9), proposal: { artifact_id: 'ar_p', revision: 2, digest: `sha256:${H('2')}` } })   // history: never reported
    framePiece(2, 'ss_a', capture(9))
    await until(() => useStudioLive.getState().remount === 'recovered')
    const rec = posts.filter((p) => p.mount === 2 && p.msg.type === 'studio.recover')
    expect(rec.length).toBe(1)
    expect(rec[0].msg).toMatchObject({ session_id: 'ss_a', receiver_generation: 2, startRevision: 3, upload: { seq: pieceSeq, scene_ref: ref(2), edit_generation: 9 } })
    expect(Object.keys(rec[0].msg).sort()).toEqual(['receiver_generation', 'session_id', 'startRevision', 'type', 'upload'])
    expect(log.filter((x) => x.startsWith('host:outcome'))).toEqual([])
    addStep(4, read(5))
    await refresh()
    const steps = posts.filter((p) => p.mount === 2 && p.msg.type === 'studio-live-step').map((p) => p.msg.n)
    expect(steps).toEqual([4])
    // an identical later acknowledgement is a no-op: no second recover
    framePiece(2, 'ss_a', capture(10))
    await settle()
    expect(posts.filter((p) => p.mount === 2 && p.msg.type === 'studio.recover').length).toBe(1)
  })
  it('no recover after Stop, or while the host has the session paused', async () => {
    await progressedThenReopened()
    ledgerRaw.state = 'paused'
    framePiece(2, 'ss_a', capture(9))
    await settle()
    expect(posts.filter((p) => p.msg.type === 'studio.recover')).toEqual([])
    ledgerRaw.state = 'active'
    await stopSession()
    framePiece(2, 'ss_a', capture(10))
    await settle()
    expect(posts.filter((p) => p.msg.type === 'studio.recover')).toEqual([])
  })
  it('a late acknowledgement for a superseded mount is ignored', async () => {
    await progressedThenReopened()
    let open!: () => void
    pieceGate = new Promise<void>((r) => { open = r })
    framePiece(2, 'ss_a', capture(9))                  // mount 2's upload is in flight…
    await settle()
    detachFrame(2)
    attachFrame(port(3))                               // …a newer mount replaces it
    await settle()
    open()
    pieceGate = null
    await settle()
    expect(posts.filter((p) => p.msg.type === 'studio.recover')).toEqual([])
  })
})

describe('r1.2 lifecycle from the authoritative host state (stand-in P1-1, P1-2)', () => {
  it('active → ended (a Stop from another tab): receiving closes, no steering or recovery, settlement stays visible', async () => {
    const { steerSession, directing, refresh } = await import('./store')
    await started()
    attachFrame(port(1))
    await settle()
    log = []
    ledgerRaw.state = 'ended'
    ledgerRaw.stop = { state: 'ended', in_flight: 0, unknown_usd: 0.04, cancel_ack: 'acknowledged' }
    ledgerRaw.budget = { unknown: 0.04 }
    await refresh()
    expect(log).toContain('frame1:studio-live-close')
    expect(useStudioLive.getState().local).toBe('stopped')
    expect(directing()).toBe(false)
    expect(await steerSession('bigger', 'typed', null)).toBe(false)
    expect(log.filter((x) => x.startsWith('host:steer'))).toEqual([])
    expect(useStudioLive.getState().cards.some((c) => c.kind === 'billing')).toBe(true)   // settlement still shown
  })
  for (const held of ['paused', 'held']) {
    it(`active → ${held}: an explicit pause to the frame, and a previously unseen proposal is NOT forwarded`, async () => {
      const { refresh } = await import('./store')
      await started()
      attachFrame(port(1))
      await settle()
      posts = []
      ledgerRaw.state = held
      addStep(1, { piece_read: { seq: 1, body_sha256: H('a'), scene_ref: ref(2), edit_generation: 2 } })
      await refresh()
      expect(posts.map((p) => p.msg)).toEqual([{ type: 'studio-live-close', session_id: 'ss_a', reason: 'pause' }])
      expect(useStudioLive.getState().local).toBe('host-paused')
      ledgerRaw.state = 'active'                      // the host resumes: receiving opens again and the step goes then
      await refresh()
      await settle()
      expect(posts.filter((p) => p.msg.type === 'studio-live-step').length).toBe(1)
    })
  }
})

describe('r1.2 step eligibility fence', () => {
  it('while active, a proposal on an interrupted (delivery_uncertain) or timed-out step is never forwarded', async () => {
    const { refresh } = await import('./store')
    await started()
    attachFrame(port(1))
    await settle()
    posts = []
    const read = { piece_read: { seq: 1, body_sha256: H('a'), scene_ref: ref(2), edit_generation: 2 } }
    addStep(1, { ...read, state: 'interrupted', reason: 'delivery_uncertain' })
    addStep(2, { ...read, state: 'timed_out' })
    addStep(3, { ...read, state: 'finished' })            // the eligible one
    await refresh()
    expect(posts.filter((p) => p.msg.type === 'studio-live-step').map((p) => p.msg.n)).toEqual([3])
  })
})

describe('Kimi K5: a proposal admitted between the capture and the recover read', () => {
  it('k is the last admitted at that read (4), and the next forwarded is 5', async () => {
    const { refresh } = await import('./store')
    await started()
    attachFrame(port(1))
    await settle()
    const read = (n: number) => ({ piece_read: { seq: n, body_sha256: H('a'), scene_ref: ref(2), edit_generation: 2 } })
    for (const n of [1, 2, 3]) addStep(n, read(n))
    await refresh()
    detachFrame(1)
    attachFrame(port(2))
    await settle()
    framePiece(2, 'ss_a', capture(9))
    addStep(4, read(4))                                 // lands before the recover's ledger read
    await until(() => useStudioLive.getState().remount === 'recovered')
    expect(posts.find((p) => p.msg.type === 'studio.recover')!.msg.startRevision).toBe(4)
    addStep(5, read(6))
    await refresh()
    expect(posts.filter((p) => p.mount === 2 && p.msg.type === 'studio-live-step').map((p) => p.msg.n)).toEqual([5])
  })
})

describe('R5 pin: directions need their own host capability (host R3 has no O1 interception)', () => {
  it('without studio_directions a steer is never sent (it could buy a fresh paid turn); the words are kept', async () => {
    const { steerSession } = await import('./store')
    await started()
    useAskStore.setState({ settings: { swarm_id: null, thread_budget_usd: 5, capabilities: { conductor: false, memory: false, studio_sessions: true, studio_directions: false } } } as never)
    expect(await steerSession('bigger headline', 'typed', null)).toBe(false)
    expect(log.filter((x) => x.startsWith('host:steer'))).toEqual([])
    expect(useStudioLive.getState().held.map((h) => h.text)).toEqual(['bigger headline'])
  })
})

describe('r1.13 (Design phone P2): on a phone the Ask sheet folds once the first step is drawn', () => {
  const drawn = (n: number) => addStep(n, { state: 'settled', outcome: 'applied', reason: null, piece_before: ref(1), piece_after: ref(2), receiver_generation: 1, upload: { seq: 1, body_sha256: H('b'), scene_ref: ref(2), edit_generation: 1 } })
  const phone = (on: boolean) => vi.stubGlobal('window', { ...(globalThis.window ?? {}), matchMedia: (q: string) => ({ matches: on && q === '(max-width: 759px)' }) })
  async function receivingWithThread(pinned = false) {
    await started()
    attachFrame(port(1))
    await settle()
    useAskStore.setState({ threadOpen: true, pinned })
  }
  afterEach(() => { vi.unstubAllGlobals(); vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) }) })
  it('phone, not pinned: folds at the first drawn step, once; reopened with Direct, it stays open', async () => {
    phone(true)
    await receivingWithThread()
    const { refresh } = await import('./store')
    await refresh()
    expect(useAskStore.getState().threadOpen).toBe(true)          // nothing drawn yet: stays
    drawn(1)
    await refresh()
    expect(useStudioLive.getState().cards.some((c) => c.kind === 'drawn')).toBe(true)
    expect(useAskStore.getState().threadOpen).toBe(false)
    useAskStore.getState().setThreadOpen(true)                      // the bar's Direct
    drawn(2)
    await refresh()
    expect(useAskStore.getState().threadOpen).toBe(true)
  })
  it('never when pinned, never on a wide screen, never while a refused step waits on the person', async () => {
    phone(true)
    await receivingWithThread(true)
    drawn(1)
    const { refresh } = await import('./store')
    await refresh()
    expect(useAskStore.getState().threadOpen).toBe(true)

    resetStudioLiveForTests()
    phone(false)
    await receivingWithThread()
    drawn(1)
    await refresh()
    expect(useAskStore.getState().threadOpen).toBe(true)

    resetStudioLiveForTests()
    phone(true)
    ;(ledgerRaw.steps as unknown[]).length = 0
    await receivingWithThread()
    addStep(1, { state: 'settled', outcome: 'refused', reason: 'conflict', piece_after: ref(1), receiver_generation: 1 })
    drawn(2)
    await refresh()
    expect(useStudioLive.getState().cards.some((c) => c.kind === 'refused')).toBe(true)
    expect(useAskStore.getState().threadOpen).toBe(true)
  })
})

describe('r1.14d (walk 2, Design 202940Z): the frame gets the bare body hash; the host keeps its own form', () => {
  // the Studio 0.4.20/0.4.21 frame's upload() guard, verbatim from its native-frame source
  const frameTakes = (u: { body_sha256: unknown }) => typeof u.body_sha256 === 'string' && /^[a-f0-9]{64}$/.test(u.body_sha256)
  it('a step whose host piece_read carries "sha256:<hex>" reaches the frame with the bare hex; the scene digest is untouched', async () => {
    const tuple = { seq: 4, body_sha256: `sha256:${H('a')}`, scene_ref: ref(3), edit_generation: 7 }
    await started()
    attachFrame(port(1))
    await settle()
    addStep(1, { piece_read: tuple })
    const { refresh } = await import('./store')
    await refresh()
    const step = posts.find((p) => p.msg.type === 'studio-live-step')!.msg as { piece_read: { body_sha256: string; seq: number; scene_ref: unknown; edit_generation: number } }
    expect(step.piece_read).toEqual({ seq: 4, body_sha256: H('a'), scene_ref: ref(3), edit_generation: 7 })
    expect(frameTakes(step.piece_read)).toBe(true)
    expect((step.piece_read.scene_ref as { digest: string }).digest).toBe(`sha256:${H('d')}`)   // scene digests are never rewritten
    expect(useStudioLive.getState().ledger?.steps[0].piece_read?.body_sha256).toBe(`sha256:${H('a')}`)   // the ledger keeps the host's form
  })
  it('a reopened view whose acks are the host form gets its ONE studio.recover, with the bare hex (it never stayed held)', async () => {
    hostPrefix = true
    const read = (n: number) => ({ piece_read: { seq: n, body_sha256: `sha256:${H('a')}`, scene_ref: ref(2), edit_generation: 2 } })
    await started()
    attachFrame(port(1))
    await settle()
    for (const n of [1, 2]) addStep(n, read(n))
    const { refresh } = await import('./store')
    await refresh()
    detachFrame(1)
    attachFrame(port(2))
    await settle()
    expect(useStudioLive.getState().remount).toBe('held')
    framePiece(2, 'ss_a', capture(9))
    await until(() => useStudioLive.getState().remount === 'recovered')
    const rec = posts.filter((p) => p.mount === 2 && p.msg.type === 'studio.recover')
    expect(rec.length).toBe(1)
    const up = (rec[0].msg as { upload: { body_sha256: string } }).upload
    expect(frameTakes(up)).toBe(true)
    expect((ledgerRaw.piece as { body_sha256: string }).body_sha256).toBe(`sha256:${up.body_sha256}`)
  })
  it('the outcome sent to the host binds the host’s own upload tuple, prefix and all (custody is never rewritten)', async () => {
    hostPrefix = true
    await started()
    attachFrame(port(1))
    await settle()
    framePiece(1, 'ss_a', capture(9))
    await settle()
    const acked = (ledgerRaw.piece as { seq: number; body_sha256: string })
    expect(acked.body_sha256.startsWith('sha256:')).toBe(true)
    addStep(1, { piece_read: { seq: acked.seq, body_sha256: acked.body_sha256, scene_ref: ref(2), edit_generation: 9 } })
    const { refresh } = await import('./store')
    await refresh()
    frameOutcome(1, 'ss_a', { ...report(1, 9), outcome: 'applied', reason: null, piece_before: ref(2), piece_after: ref(2) } as never)
    await until(() => outcomeBodies.length > 0)
    const body = outcomeBodies[0] as { piece_upload?: { body_sha256: string } }
    expect(body.piece_upload?.body_sha256).toBe(acked.body_sha256)
  })
})


it('owner workspace repair uses the same control id after a lost answer, reads the existing ledger and closes its offer', async () => {
  const { ApiError } = await import('../../api/client')
  const ids: string[] = [], c = fakeClient() as unknown as Record<string, unknown>
  c.studioControl = async (_sid: string, body: { control_id: string; action: string }) => {
    ids.push(body.control_id)
    expect(body.action).toBe('repair_handoff')
    if (ids.length === 1) throw new ApiError(0, 'network', 'invented lost answer')
    ledgerRaw.credential_reason = null
    ledgerRaw.state = 'ended'
    ledgerRaw.stop = { state: 'ended', maker_released: true, release_phase: 'durable' }
    return {}
  }
  useHive.setState({ client: c as never }); await started()
  ledgerRaw.state = 'stopping'; ledgerRaw.credential_reason = 'namespace_conflict'
  ledgerRaw.stop = { state: 'stopping', release_phase: 'installed', maker_released: false }
  const { refresh, repairHandoff } = await import('./store')
  await refresh()
  expect(renderCurrentSession()).toContain('Check workspace and finish stopping')
  await repairHandoff(); await settle()
  expect(renderCurrentSession()).not.toContain('Check workspace and finish stopping')
  expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1])
  expect(useStudioLive.getState().ledger?.state).toBe('ended')
  expect(useStudioLive.getState().ledger?.credential_reason).toBeNull()
  expect(useStudioLive.getState().control).toBeNull()
})
