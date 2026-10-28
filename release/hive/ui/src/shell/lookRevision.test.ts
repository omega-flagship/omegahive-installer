import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import route from './fixtures/uiPrefsRoute.65aa421.json'

/**
 * r1m: compare-and-set with the host, and the conflict policy (Surface lead, r1m). A FAKE HOST built from Platform's
 * route at platform/ui-prefs-revision 65aa421: its checks run in the order the fixture records, and the fixture's
 * anchors are asserted against the real source at that commit (when the Platform worktree is present). Requests are
 * HELD and processed when the test releases them (their arrival), under the sign-in they were SENT with. The REAL look
 * store, the identity binder the app installs (shell/lookIdentity), the identity testkit. Each sequence asserts the
 * HOST's final value and the PAGE.
 */
const mem = new Map<string, string>()
/** r1p: one storage key can be made to refuse writes (QuotaExceeded), as a full device would */
const refuseWrites = new Set<string>()
const storage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => {
    if (refuseWrites.has(k)) throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' })
    mem.set(k, String(v))
  },
  removeItem: (k: string) => void mem.delete(k),
}
const stubWindow = () => {
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('window', { location: { hash: '#/', search: '', pathname: '/' }, localStorage: storage, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} })
}
stubWindow()

import type { UiPrefs, UiPrefsResponse, UiPrefsWriteOptions } from './uiVariant'
const { ApiError } = await import('../api/client')
const { uiRevHeaders } = await import('../api/live')
const U = await import('./uiVariant')
const { loadLookBound } = await import('./lookIdentity')
const RQ = await import('../features/requestExperience/store')
const { useAskStore } = await import('../store/ask')
const { useHive } = await import('../store/store')
const { isCurrent, releasePersons, signInAs, switchPerson, testPerson } = await import('../lib/identityEpoch.testkit')
type Person = ReturnType<typeof testPerson>

const look = (id: string, experience: string | null = null): UiPrefs => ({ variant: U.SEED_VARIANTS.find((v) => v.id === id)!, layout: null, apps: null, experience })
const id = (p: UiPrefs | null | undefined) => p?.variant?.id ?? (p ? 'default' : null)
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
}

// ---------------------------------------------------------------- the fake host, in the route's own order

/** The fake's checks, in order: asserted equal to the fixture taken from the real route (below). */
const FAKE_PUT = ['too_large', 'body_json', 'body_object', 'base_rev_header', 'check_prefs', 'compare_and_set'] as const
const FAKE_DELETE = ['base_rev_header', 'compare_and_set'] as const

interface Row {
  prefs: UiPrefs | null
  updated_at: string | null
  rev: number
  epoch: number
}
function fakeHost(people: () => string, opts: { revisions?: boolean; holdGets?: boolean } = {}) {
  const revisions = opts.revisions !== false
  let epoch = 1
  const rows = new Map<string, Row>()
  // ui_prefs._read: never written by this host -> epoch - 1; otherwise rev + (epoch - row.epoch)
  const read = (who: string) => {
    const r = rows.get(who)
    return r ? { prefs: r.prefs, updated_at: r.updated_at, rev: r.rev + (epoch - r.epoch) } : { prefs: null, updated_at: null, rev: epoch - 1 }
  }
  const answer = (r: { prefs: UiPrefs | null; updated_at: string | null; rev: number }): UiPrefsResponse => (revisions ? { ...r } : { prefs: r.prefs, updated_at: r.updated_at })
  // app._ui_base_rev
  const baseRev = (headers: [string, string][]): number | null => {
    const values = headers.filter(([k]) => k.toLowerCase() === route.header).map(([, v]) => v)
    if (!values.length) return null
    const value = values[0].trim()
    if (values.length !== 1 || ![...value].every((ch) => ch.charCodeAt(0) < 128) || !/^\d+$/.test(value) || value.length > route.headerMaxDigits) throw new ApiError(400, 'bad_request', 'X-UI-Base-Rev must be one look revision (a non-negative integer)')
    return Number(value)
  }
  let clock = 0
  function handle(method: 'PUT' | 'DELETE', who: string, headers: [string, string][], body: unknown): UiPrefsResponse {
    const order = method === 'PUT' ? FAKE_PUT : FAKE_DELETE
    let base: number | null = null
    for (const step of order) {
      if (step === 'too_large' || step === 'body_json') continue // the client always sends small JSON
      if (step === 'body_object' && (!body || typeof body !== 'object' || Array.isArray(body))) throw new ApiError(400, 'bad_request', 'expected a JSON object')
      if (step === 'base_rev_header' && revisions) base = baseRev(headers)
      if (step === 'check_prefs' && (body as { invalid?: boolean }).invalid) throw new ApiError(400, 'invalid_ui_variant', 'variant: ink on void is 2.00:1, below 7:1')
      if (step === 'compare_and_set' && base !== null) {
        const cur = read(who)
        if (base !== cur.rev) {
          const error = { code: 'stale_ui_prefs', message: 'look preferences changed since that revision', current: answer(cur) }
          throw new ApiError(409, 'stale_ui_prefs', error.message, { envelope: error, body: { error } })
        }
      }
    }
    const next = { prefs: method === 'PUT' ? (body as UiPrefs) : null, updated_at: method === 'PUT' ? `t${++clock}` : null, rev: read(who).rev + 1, epoch }
    rows.set(who, next)
    return answer({ prefs: next.prefs, updated_at: next.updated_at, rev: next.rev })
  }
  const held: { go: () => void; headers: [string, string][] }[] = []
  const sent: { method: string; base: string | undefined; who: string; headers: [string, string][] }[] = []
  const send = (method: 'PUT' | 'DELETE', o: UiPrefsWriteOptions | undefined, body: unknown) => {
    const who = people() // the sign-in the request is SENT with
    const headers = Object.entries(uiRevHeaders(o)) as [string, string][]
    sent.push({ method, base: headers.find(([k]) => k.toLowerCase() === route.header)?.[1], who, headers })
    return new Promise<UiPrefsResponse>((res, rej) =>
      held.push({
        headers,
        go: () => {
          try {
            res(handle(method, who, headers, body))
          } catch (e) {
            rej(e)
          }
        },
      }),
    )
  }
  const gets: (() => void)[] = []
  const client = {
    me: async () => ({ principal: people() }),
    // a held GET answers what the host holds when it ARRIVES (released), like the writes
    uiPrefs: () =>
      opts.holdGets
        ? new Promise<UiPrefsResponse>((res) => {
            const who = people()
            gets.push(() => res(answer(read(who))))
          })
        : Promise.resolve(answer(read(people()))),
    setUiPrefs: (p: UiPrefs, o?: UiPrefsWriteOptions) => send('PUT', o, p),
    resetUiPrefs: (o?: UiPrefsWriteOptions) => send('DELETE', o, undefined),
  }
  return {
    client,
    sent,
    handle,
    arrive: async (i: number) => {
      for (let k = 0; k < 50 && !held[i]; k++) await new Promise((r) => setTimeout(r, 0))
      expect(held[i], `request ${i} reached the host`).toBeDefined()
      held[i].go()
      await flush()
    },
    made: () => held.length,
    /** release the i-th GET (held only with holdGets) */
    arriveGet: async (i: number) => {
      for (let k = 0; k < 50 && !gets[i]; k++) await new Promise((r) => setTimeout(r, 0))
      expect(gets[i], `GET ${i} reached the host`).toBeDefined()
      gets[i]()
      await flush()
    },
    gets: () => gets.length,
    holdGets: (on: boolean) => void (opts.holdGets = on),
    host: (who: string) => read(who),
    /** another device of the same person writes directly */
    elsewhere: (who: string, prefs: UiPrefs | null) => void handle(prefs ? 'PUT' : 'DELETE', who, [], prefs),
    /** the host restarts: every revision moves on by one (r4 epoch) */
    restart: () => void epoch++,
    /** the host is restored from a backup: its row (and rev) go back */
    restore: (who: string, prefs: UiPrefs | null, rev: number) => void rows.set(who, { prefs, updated_at: 'backup', rev, epoch }),
  }
}

async function signedIn(p: Person, host: ReturnType<typeof fakeHost>) {
  Object.assign(p.client, host.client)
  await signInAs(p)
  await loadLookBound(p.client as never)
  await flush()
}
const asClient = (c: unknown) => c as Parameters<typeof U.keepLook>[0]
const pendingFlags = () => [...mem.entries()].filter(([k, v]) => k.startsWith('omegahive.ui.look.pending') && v === '1').length

beforeEach(() => {
  mem.clear()
  refuseWrites.clear()
  U.previewLook(null)
})
afterEach(() => {
  vi.useRealTimers()
  U.restartSaveQueue()
  releasePersons()
})

// ---------------------------------------------------------------- the fake follows the real route

describe('the fake host follows Platform’s route at 65aa421 (stand-in r1l #5)', () => {
  it('its check order is the fixture’s, step for step', () => {
    expect([...FAKE_PUT]).toEqual(route.put.map((s) => s.step))
    expect([...FAKE_DELETE]).toEqual(route.delete.map((s) => s.step))
  })

  it('the fixture’s anchors are in the real source at that commit, in that order (when the Platform worktree is here)', async () => {
    // @ts-expect-error -- node's child_process has no types in this browser project; vitest runs these tests in node
    const { execFileSync } = await import('node:child_process')
    // @ts-expect-error -- as above
    const { existsSync } = await import('node:fs')
    const repo = '/home/user/OmegaDot/.runtime/sessions/ui-prefs-revision'
    if (!existsSync(repo)) return // elsewhere: the order test above still binds the fake to the recorded fixture
    const src = (f: string): string => execFileSync('git', ['-C', repo, 'show', `${route.commit}:${f}`], { encoding: 'utf8' })
    const app = src('hive/core/app.py')
    const store = src('hive/core/ui_prefs.py')
    const fn = (text: string, start: string, end: string) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)))
    const put = fn(app, 'async def me_ui_put', 'async def me_ui_reset')
    const del = fn(app, 'async def me_ui_reset', '# ---- hive, models')
    const inOrder = (text: string, anchors: string[]) => {
      let at = -1
      for (const a of anchors) {
        const i = text.indexOf(a, at + 1)
        expect(i, a).toBeGreaterThan(at)
        at = i
      }
    }
    inOrder(put, route.put.filter((s) => s.file === 'hive/core/app.py').map((s) => s.anchor))
    inOrder(del, route.delete.filter((s) => s.file === 'hive/core/app.py').map((s) => s.anchor))
    // the store: check_prefs is evaluated (as _write's argument) before _write runs its compare-and-set
    expect(fn(store, '    def put(', '    def reset(')).toContain(route.put[4].anchor)
    expect(fn(store, '    def _write(', '    def put(')).toContain(route.put[5].anchor)
    expect(fn(app, 'def _ui_base_rev', 'def _ui_write')).toContain('base_rev')
    inOrder(fn(app, 'def _ui_base_rev', 'def _ui_write'), route.headerParse.map((s) => s.anchor))
    for (const s of route.revision) expect(store).toContain(s.anchor)
  })

  it('an invalid look AND a malformed revision header: 400 bad_request (the header is parsed before check_prefs)', () => {
    const h = fakeHost(() => 'user:p_inv_order')
    let e: unknown = null
    try {
      h.handle('PUT', 'user:p_inv_order', [['X-UI-Base-Rev', '"3"']], { ...look('ember-forge'), invalid: true })
    } catch (err) {
      e = err
    }
    expect((e as { code?: string }).code).toBe('bad_request')
    for (const bad of [[['X-UI-Base-Rev', '1'], ['x-ui-base-rev', '1']], [['X-UI-Base-Rev', 'W/"1"']], [['X-UI-Base-Rev', '*']], [['X-UI-Base-Rev', '1, 2']], [['X-UI-Base-Rev', '1'.repeat(19)]]] as [string, string][][]) {
      expect(() => h.handle('PUT', 'user:p_inv_order', bad, look('ember-forge'))).toThrow(/X-UI-Base-Rev/)
    }
    expect(h.host('user:p_inv_order').rev).toBe(0) // nothing written
  })
})

// ---------------------------------------------------------------- the client

describe('r1m: compare-and-set, the conflict policy, the offline replay', () => {
  it('[stand-in r1k #1] Keep Ember times out, Deep Sea is kept, then Ember arrives late: refused by the host; host = page = Deep Sea', async () => {
    const a = testPerson('m-cas1')
    const P = 'user:p_inv_m_cas1'
    const h = fakeHost(() => P)
    await signedIn(a, h)
    expect.soft(U.lookHostMode(), 'host mode').toBe('revisions')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const ember = U.keepLook(asClient(h.client), look('ember-forge')).catch((e: Error) => e)
    const deep = U.keepLook(asClient(h.client), look('deep-sea')).catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync(20001)
    expect(await ember).toBeInstanceOf(Error)
    await vi.advanceTimersByTimeAsync(0)
    vi.useRealTimers()
    await h.arrive(1)
    await deep
    await h.arrive(0) // the late Ember: 409 (the host is at 1)
    await flush()
    expect.soft(id(h.host(P).prefs), 'host').toBe('deep-sea')
    expect.soft(id(U.lookState().saved), 'page').toBe('deep-sea')
    expect(U.lookState().conflict ?? null).toBeNull() // Deep Sea is the standing choice: no notice
  })

  it('[stand-in r1k #2] A→B→A with A’s old Ember in flight: host = page = A’s new Deep Sea', async () => {
    const a = testPerson('m-cas2-a')
    const b = testPerson('m-cas2-b', { sameTab: a })
    const a2 = testPerson('m-cas2-a', { sameTab: a })
    const who = () => (isCurrent(b) ? 'user:p_inv_m_cas2_b' : 'user:p_inv_m_cas2_a')
    const h = fakeHost(who)
    await signedIn(a, h)
    const old = U.keepLook(asClient(h.client), look('ember-forge')).catch((e: Error) => e)
    await flush()
    await switchPerson(a, b)
    await flush()
    await switchPerson(b, a2)
    await loadLookBound(a.client as never)
    await flush()
    const fresh = U.keepLook(asClient(h.client), look('deep-sea')).catch((e: Error) => e)
    await h.arrive(1)
    await fresh
    await h.arrive(0)
    await old
    await flush()
    expect.soft(id(h.host('user:p_inv_m_cas2_a').prefs), 'host').toBe('deep-sea')
    expect.soft(id(U.lookState().saved), 'page').toBe('deep-sea')
  })

  it('[#1] A→B: A’s held acceptance (late) and A’s held 409 land under B and never touch B’s revision', async () => {
    const a = testPerson('m-iso-a')
    const b = testPerson('m-iso-b', { sameTab: a })
    const who = () => (isCurrent(b) ? 'user:p_inv_m_iso_b' : 'user:p_inv_m_iso_a')
    const h = fakeHost(who)
    for (let i = 0; i < 5; i++) h.elsewhere('user:p_inv_m_iso_a', look('phosphor')) // A's revision is 5
    await signedIn(a, h)
    expect(U.lookRevision()).toBe(5)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const first = U.keepLook(asClient(h.client), look('ember-forge')).catch((e: Error) => e) // A, base 5: held
    const second = U.keepLook(asClient(h.client), look('deep-sea')).catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync(20001) // the first's time limit: the second is sent too (A, base 5): held
    await vi.advanceTimersByTimeAsync(0)
    vi.useRealTimers()
    expect(h.made()).toBe(2) // both of A's requests are out
    await switchPerson(a, b)
    await loadLookBound(b.client as never)
    await flush()
    expect(U.lookRevision()).toBe(0) // B's own
    await h.arrive(0) // A's first: accepted (A's rev 6), its answer arrives late, under B
    await h.arrive(1) // A's second: 409 (A is at 6, it said 5), under B
    await first
    await second
    await flush()
    expect(h.host('user:p_inv_m_iso_a').rev).toBe(6) // A's account moved on, as it should
    expect(U.lookRevision()).toBe(0) // B's revision untouched by both
    expect(U.lookHostMode()).toBe('revisions')
    expect(U.lookState().conflict ?? null).toBeNull() // and no notice for A's conflict under B
  })

  it('[conflict] another device moved the host on: the page adopts its look, ONE notice, NO automatic re-send; Use mine sends it once', async () => {
    const a = testPerson('m-cas3')
    const P = 'user:p_inv_m_cas3'
    const h = fakeHost(() => P)
    await signedIn(a, h)
    h.elsewhere(P, look('phosphor')) // rev 1, unseen here
    const keep = U.keepLook(asClient(h.client), look('ember-forge')).catch((e: Error) => e)
    await h.arrive(0) // 409
    await flush()
    expect(h.made()).toBe(1) // not sent again by itself
    expect(await keep).toBeInstanceOf(U.NotKept)
    expect.soft(id(h.host(P).prefs), 'host').toBe('phosphor')
    expect.soft(id(U.lookState().saved), 'page').toBe('phosphor')
    expect(U.lookState().conflict).toMatchObject({ name: 'Phosphor Terminal', kind: 'keep' })
    const mine = U.chooseMineAgain(asClient(h.client)) // the person taps Use mine
    await h.arrive(1)
    await mine
    expect(h.sent.map((s) => s.base)).toEqual(['0', '1'])
    expect.soft(id(h.host(P).prefs), 'host').toBe('ember-forge')
    expect.soft(id(U.lookState().saved), 'page').toBe('ember-forge')
    expect(U.lookState().conflict ?? null).toBeNull()
  })

  it('[conflict, moved on] a newer choice is standing: the older is dropped silently (no notice), the newer is kept; host = page', async () => {
    const a = testPerson('m-cas4')
    const P = 'user:p_inv_m_cas4'
    const h = fakeHost(() => P)
    await signedIn(a, h)
    const older = U.keepLook(asClient(h.client), look('ember-forge')).catch((e: Error) => e)
    const newer = U.keepLook(asClient(h.client), look('deep-sea'))
    h.elsewhere(P, look('phosphor'))
    await h.arrive(0) // Ember: 409
    expect(await older).toBeInstanceOf(U.NotKept)
    expect(U.lookState().conflict ?? null).toBeNull()
    await h.arrive(1) // Deep Sea with base 1
    expect((await newer).outcome).toBe('applied')
    expect(h.sent.map((s) => s.base)).toEqual(['0', '1'])
    expect.soft(id(h.host(P).prefs), 'host').toBe('deep-sea')
    expect.soft(id(U.lookState().saved), 'page').toBe('deep-sea')
  })

  it('[conflict twice] Use mine, refused again: the notice again; never a loop (every send came from a tap)', async () => {
    const a = testPerson('m-cas5')
    const P = 'user:p_inv_m_cas5'
    const h = fakeHost(() => P)
    await signedIn(a, h)
    h.elsewhere(P, look('phosphor'))
    const keep = U.keepLook(asClient(h.client), look('ember-forge')).catch((e: Error) => e)
    await h.arrive(0)
    await flush()
    expect(h.made()).toBe(1) // not sent again by itself
    await keep
    const mine = U.chooseMineAgain(asClient(h.client))
    h.elsewhere(P, look('sakura-night')) // the other device again, before Use mine arrives
    await h.arrive(1)
    await mine
    await flush()
    expect(h.made()).toBe(2)
    expect(U.lookState().conflict).toMatchObject({ name: 'Sakura Night' })
    expect.soft(id(h.host(P).prefs), 'host').toBe('sakura-night')
    expect.soft(id(U.lookState().saved), 'page').toBe('sakura-night')
  })

  it('[conflict on reset] adopt the host’s look, the notice; pending cleared; Use mine resets with the new rev', async () => {
    const a = testPerson('m-cas6')
    const P = 'user:p_inv_m_cas6'
    const h = fakeHost(() => P)
    await signedIn(a, h)
    h.elsewhere(P, look('phosphor'))
    const done = U.resetLook(asClient(h.client))
    await h.arrive(0)
    await flush()
    expect(h.made()).toBe(1) // not sent again by itself
    expect(await done).toBe('conflict')
    expect(pendingFlags()).toBe(0)
    expect(id(U.lookState().saved)).toBe('phosphor')
    expect(U.lookState().conflict).toMatchObject({ kind: 'reset' })
    const mine = U.chooseMineAgain(asClient(h.client))
    await h.arrive(1)
    await mine
    expect(h.host(P).prefs).toBeNull()
    expect(U.lookState().saved).toBeNull()
    expect(pendingFlags()).toBe(0)
  })

  it('[conflict on escape] the look is adopted but the classic hive stays on the page; pending stays with the new base; the notice', async () => {
    const a = testPerson('m-cas7')
    const P = 'user:p_inv_m_cas7'
    const h = fakeHost(() => P)
    await signedIn(a, h)
    h.elsewhere(P, look('phosphor', 'still'))
    const out = U.escapeToClassic(asClient(h.client))
    await h.arrive(0)
    await flush()
    expect(h.made()).toBe(1) // not sent again by itself
    expect(await out).toBe('local')
    expect(U.lookState().saved?.experience ?? null).toBeNull() // never thrown back into an experience
    expect(id(U.lookState().saved)).toBe('phosphor')
    expect(pendingFlags()).toBe(1)
    expect(mem.get('omegahive.ui.look.offlinebase:user:p_inv_m_cas7')).toBe('1')
    expect(U.lookState().conflict).toMatchObject({ kind: 'escape' })
  })

  it('[small things r3, stand-in r2 P2] an escape that meets the old gallery\u2019s Cosmos write: Classic never shows or caches Deep Sea', async () => {
    const a = testPerson('st-esc')
    const P = 'user:p_inv_st_esc'
    const h = fakeHost(() => P)
    await signedIn(a, h)
    h.elsewhere(P, look('deep-sea', 'cosmos')) // the companion stored WITH its experience: the old gallery's write
    const out = U.escapeToClassic(asClient(h.client))
    await h.arrive(0)
    await flush()
    expect(await out).toBe('local')
    expect(U.lookState().saved?.experience ?? null).toBeNull()
    expect(id(U.lookState().saved)).toBe('default') // shown: not Deep Sea
    expect(JSON.parse(mem.get(`omegahive.ui.look:${P}`) ?? 'null')?.variant ?? null).toBeNull() // cached: not Deep Sea
    expect(U.lookState().conflict).toMatchObject({ kind: 'escape', name: 'Cosmos' })
  })

  it('[#4] a reset is shown, a newer choice fails, then the reset’s 409 arrives late: the reset is still standing, so the page adopts the host; pending cleared', async () => {
    const a = testPerson('m-cas8')
    const P = 'user:p_inv_m_cas8'
    const h = fakeHost(() => P)
    await signedIn(a, h)
    h.elsewhere(P, look('phosphor')) // the host is at 1; this page saw 0
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const reset = U.resetLook(asClient(h.client)) // shown at once, pending
    const failing = U.keepLook(asClient(h.client), { ...look('ember-forge'), invalid: true } as unknown as UiPrefs).catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync(8001) // the reset's time limit: the queue moves on
    await vi.advanceTimersByTimeAsync(0)
    vi.useRealTimers()
    await h.arrive(1) // the newer choice fails (400)
    expect(((await failing) as { code?: string }).code).toBe('invalid_ui_variant')
    await h.arrive(0) // the reset's 409 arrives late
    await reset
    await flush()
    expect.soft(id(h.host(P).prefs), 'host').toBe('phosphor')
    expect.soft(id(U.lookState().saved), 'page').toBe('phosphor')
    expect(pendingFlags()).toBe(0)
    expect(U.lookState().conflict).toMatchObject({ kind: 'reset' })
  })

  it('[host r4: a hive restart] the look did not change, only the rev: ONE 409, ONE automatic re-send, no notice; host = page; rev never stored', async () => {
    const a = testPerson('m-cas9')
    const P = 'user:p_inv_m_cas9'
    const h = fakeHost(() => P)
    await signedIn(a, h)
    const k1 = U.keepLook(asClient(h.client), look('ember-forge'))
    await h.arrive(0)
    await k1
    h.restart()
    const k2 = U.keepLook(asClient(h.client), look('deep-sea'))
    await h.arrive(1) // 409: the host's look is Ember, as this page knew; only the revision moved
    await h.arrive(2)
    expect((await k2).outcome).toBe('applied')
    expect(h.made()).toBe(3)
    expect(h.sent.map((s) => s.base)).toEqual(['0', '1', '2'])
    expect(U.lookState().conflict ?? null).toBeNull()
    expect.soft(id(h.host(P).prefs), 'host').toBe('deep-sea')
    expect.soft(id(U.lookState().saved), 'page').toBe('deep-sea')
    for (const [k] of mem.entries()) expect(k).not.toMatch(/rev/i)
  })

  it('[ruling: revision-only means DEEP-equal] same variant id but a different layout on the host: a conflict (notice, no re-send), not a silent re-send', async () => {
    const a = testPerson('m-deq')
    const P = 'user:p_inv_m_deq'
    const h = fakeHost(() => P)
    await signedIn(a, h)
    const k1 = U.keepLook(asClient(h.client), look('ember-forge'))
    await h.arrive(0)
    await k1 // the host holds Ember Forge (side rail), as this page knows
    h.elsewhere(P, { ...look('ember-forge'), layout: 'dock' }) // same id, another device docked it
    const k2 = U.keepLook(asClient(h.client), look('deep-sea')).catch((e: Error) => e)
    await h.arrive(1)
    await flush()
    expect(h.made()).toBe(2) // not re-sent: the host's look is NOT the one this page knew
    expect(await k2).toBeInstanceOf(U.NotKept)
    expect(U.lookState().conflict).toMatchObject({ name: 'Ember Forge' })
    expect(U.lookState().saved?.layout).toBe('dock')
  })

  it('[ruling: revision-only, deep-equal] the same look with its keys in another order is still the same look: one silent re-send', async () => {
    const a = testPerson('m-deq2')
    const P = 'user:p_inv_m_deq2'
    const h = fakeHost(() => P)
    await signedIn(a, h)
    const k1 = U.keepLook(asClient(h.client), look('ember-forge'))
    await h.arrive(0)
    await k1
    const same = look('ember-forge')
    const reordered = JSON.parse(JSON.stringify({ experience: same.experience, apps: same.apps, layout: same.layout, variant: Object.fromEntries(Object.entries(same.variant!).reverse()) })) as UiPrefs
    h.restore(P, reordered, h.host(P).rev + 1) // a restart; the stored JSON comes back in another key order
    const k2 = U.keepLook(asClient(h.client), look('deep-sea'))
    await h.arrive(1) // 409, the same look: re-sent once
    await h.arrive(2)
    expect((await k2).outcome).toBe('applied')
    expect(U.lookState().conflict ?? null).toBeNull()
    expect(id(h.host(P).prefs)).toBe('deep-sea')
  })

  it('[Kimi r1k: rev rewind] a host restored from backup (rev below this page’s, a different look): ONE 409, the notice, no storm; Use mine succeeds', async () => {
    const a = testPerson('m-cas10')
    const P = 'user:p_inv_m_cas10'
    const h = fakeHost(() => P)
    await signedIn(a, h)
    const k1 = U.keepLook(asClient(h.client), look('ember-forge'))
    await h.arrive(0)
    await k1
    const k2 = U.keepLook(asClient(h.client), look('deep-sea'))
    await h.arrive(1)
    await k2 // this page's base is 2
    h.restore(P, look('phosphor'), 1)
    const k3 = U.keepLook(asClient(h.client), look('sakura-night')).catch((e: Error) => e)
    await h.arrive(2)
    await flush()
    expect(h.made()).toBe(3) // no storm: not sent again by itself
    expect(await k3).toBeInstanceOf(U.NotKept)
    expect(U.lookRevision()).toBe(1) // current.rev is the truth
    const mine = U.chooseMineAgain(asClient(h.client))
    await h.arrive(3)
    await mine
    expect(h.sent.map((s) => s.base)).toEqual(['0', '1', '2', '1'])
    expect.soft(id(h.host(P).prefs), 'host').toBe('sakura-night')
    expect.soft(id(U.lookState().saved), 'page').toBe('sakura-night')
  })

  it('[400 bad_request / invalid_ui_variant] refused, reported, NOT retried; rev not bumped', async () => {
    const a = testPerson('m-cas11')
    const P = 'user:p_inv_m_cas11'
    const h = fakeHost(() => P)
    await signedIn(a, h)
    const keep = U.keepLook(asClient(h.client), { ...look('ember-forge'), invalid: true } as unknown as UiPrefs).catch((e: Error) => e)
    await h.arrive(0)
    expect(((await keep) as { code?: string }).code).toBe('invalid_ui_variant')
    expect(h.made()).toBe(1)
    expect(h.host(P).rev).toBe(0)
  })

  it('[older host, no rev] no revision header; the ordered queue is all there is (r1k behaviour); host = page', async () => {
    const a = testPerson('m-cas12')
    const P = 'user:p_inv_m_cas12'
    const h = fakeHost(() => P, { revisions: false })
    await signedIn(a, h)
    expect.soft(U.lookHostMode(), 'host mode').toBe('older-host')
    const A = U.keepLook(asClient(h.client), look('ember-forge'))
    const B = U.keepLook(asClient(h.client), look('deep-sea'))
    await h.arrive(0)
    await A
    await h.arrive(1)
    await B
    expect(h.sent.map((s) => s.base)).toEqual([undefined, undefined])
    expect(id(h.host(P).prefs)).toBe('deep-sea')
    expect(id(U.lookState().saved)).toBe('deep-sea')
  })
})

describe('r1m: the offline replay (stand-in r1l #3)', () => {
  /** an escape made while offline: the device copy, the pending flag and its base revision, as the page leaves them */
  const offline = (P: string, prefs: UiPrefs | null, base: number | null) => {
    if (prefs) mem.set(`omegahive.ui.look:${P}`, JSON.stringify(prefs))
    else mem.delete(`omegahive.ui.look:${P}`)
    mem.set(`omegahive.ui.look.pending:${P}`, '1')
    if (base !== null) mem.set(`omegahive.ui.look.offlinebase:${P}`, String(base))
  }

  it('the host is still at the base: GET first, then the offline choice sent conditionally; host = page; pending cleared', async () => {
    const a = testPerson('m-off1')
    const P = 'user:p_inv_m_off1'
    const h = fakeHost(() => P)
    h.elsewhere(P, look('phosphor')) // rev 1, the base the offline choice was made on
    offline(P, look('ember-forge'), 1)
    Object.assign(a.client, h.client)
    await signInAs(a)
    const load = loadLookBound(a.client as never)
    await h.arrive(0)
    await flush()
    expect(h.sent.map((s) => [s.method, s.base])).toEqual([['PUT', '1']]) // read first, then ONE conditional send
    await load
    expect.soft(id(h.host(P).prefs), 'host').toBe('ember-forge')
    expect.soft(id(U.lookState().saved), 'page').toBe('ember-forge')
    expect(pendingFlags()).toBe(0)
  })

  it('the host changed while this device was offline: nothing is sent; the page adopts the host and the notice offers Use mine', async () => {
    const a = testPerson('m-off2')
    const P = 'user:p_inv_m_off2'
    const h = fakeHost(() => P)
    h.elsewhere(P, look('phosphor')) // rev 1
    offline(P, look('ember-forge'), 1)
    h.elsewhere(P, look('deep-sea')) // rev 2: changed meanwhile
    Object.assign(a.client, h.client)
    await signInAs(a)
    const load = loadLookBound(a.client as never)
    await flush()
    expect(h.made()).toBe(0) // nothing sent: the host moved on while this device was offline
    await load
    expect.soft(id(h.host(P).prefs), 'host').toBe('deep-sea')
    expect.soft(id(U.lookState().saved), 'page').toBe('deep-sea')
    expect(pendingFlags()).toBe(0)
    expect(U.lookState().conflict).toMatchObject({ name: 'Deep Sea', mine: { variant: { id: 'ember-forge' } } })
  })

  it('the replay times out, a later Keep is kept, then the replay lands late: refused by the host; host = page = the Keep', async () => {
    const a = testPerson('m-off3')
    const P = 'user:p_inv_m_off3'
    const h = fakeHost(() => P)
    await signedIn(a, h) // signed in and loaded; then this device goes offline, escapes, and comes back
    offline(P, look('ember-forge'), 0)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const load = loadLookBound(a.client as never)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(8001) // the replay's time limit
    await load
    const keep = U.keepLook(asClient(h.client), look('deep-sea'))
    await vi.advanceTimersByTimeAsync(0)
    vi.useRealTimers()
    await h.arrive(1) // the Keep arrives first (base 0): accepted
    await keep
    await h.arrive(0) // the late replay (base 0): 409
    await flush()
    expect.soft(id(h.host(P).prefs), 'host').toBe('deep-sea')
    expect.soft(id(U.lookState().saved), 'page').toBe('deep-sea')
  })

  it('an older host (no rev): the r1k replay, unconditional and in turn', async () => {
    const a = testPerson('m-off4')
    const P = 'user:p_inv_m_off4'
    const h = fakeHost(() => P, { revisions: false })
    offline(P, look('ember-forge'), null)
    Object.assign(a.client, h.client)
    await signInAs(a)
    const load = loadLookBound(a.client as never)
    await h.arrive(0)
    await flush()
    expect(h.sent.map((s) => s.base)).toEqual([undefined])
    await load
    expect(id(h.host(P).prefs)).toBe('ember-forge')
    expect(id(U.lookState().saved)).toBe('ember-forge')
  })
})

describe('r1m: the header', () => {
  it('the live client sends EXACTLY ONE X-UI-Base-Rev, a bare non-negative integer, and none when no rev is known', async () => {
    const seen: Headers[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      seen.push(new Headers(init.headers))
      return new Response(JSON.stringify({ prefs: null, updated_at: null, rev: 3 }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const { LiveClient, UI_REV_HEADER } = await import('../api/live')
    const live = new LiveClient('http://hive.invalid')
    await live.setUiPrefs(look('ember-forge'), { baseRev: 0 })
    await live.setUiPrefs(look('ember-forge'), { baseRev: 7 })
    await live.resetUiPrefs({ baseRev: 12 })
    await live.setUiPrefs(look('ember-forge'))
    await live.resetUiPrefs()
    expect(UI_REV_HEADER).toBe('X-UI-Base-Rev')
    expect(seen.map((h) => h.get('x-ui-base-rev'))).toEqual(['0', '7', '12', null, null])
    for (const h of seen) {
      expect([...h.keys()].filter((k) => k === 'x-ui-base-rev' || k === 'if-match').length).toBeLessThanOrEqual(1)
      const v = h.get('x-ui-base-rev')
      if (v !== null) expect(v).toMatch(/^\d+$/)
    }
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3' as unknown as number, undefined]) expect(uiRevHeaders({ baseRev: bad })).toEqual({})
    vi.unstubAllGlobals()
    stubWindow()
  })
})

describe('r1n: the offline replay is a choice like any other (stand-in r1m; the GET is held too)', () => {
  const offline = (P: string, prefs: UiPrefs | null, base: number | null) => {
    if (prefs) mem.set(`omegahive.ui.look:${P}`, JSON.stringify(prefs))
    else mem.delete(`omegahive.ui.look:${P}`)
    mem.set(`omegahive.ui.look.pending:${P}`, '1')
    if (base !== null) mem.set(`omegahive.ui.look.offlinebase:${P}`, String(base))
  }
  /** signed in and loaded with immediate GETs; then the device's offline state is set and the next GETs are held */
  async function online(name: string, P: string, setup: (h: ReturnType<typeof fakeHost>) => void) {
    const a = testPerson(name)
    const h = fakeHost(() => P)
    setup(h)
    await signedIn(a, h)
    return { a, h }
  }

  it('[stand-in r1m #1] a Keep made during the replay’s GET wins: the replay is discarded (never sent); host = page = the Keep, no notice', async () => {
    const P = 'user:p_inv_n1'
    const { a, h } = await online('n1', P, (h) => h.elsewhere(P, look('phosphor'))) // host at rev 1
    offline(P, look('ember-forge'), 1)
    h.holdGets(true)
    const load = loadLookBound(a.client as never) // the replay: its GET is held
    await flush()
    const keep = U.keepLook(asClient(h.client), look('deep-sea')) // made while the GET is on its way
    await h.arriveGet(0)
    await h.arrive(0) // the Keep's PUT
    await keep
    await flush()
    const writes = h.made()
    if (writes >= 2) await h.arrive(1) // an older build sent the replay too: let it land, then judge
    await load
    await flush()
    expect.soft(writes, 'writes sent').toBe(1) // ONE write: the Keep; the replay never sent
    expect.soft(id(h.host(P).prefs), 'host').toBe('deep-sea')
    expect.soft(id(U.lookState().saved), 'page').toBe('deep-sea')
    expect(U.lookState().conflict ?? null).toBeNull()
  })

  it('[stand-in r1m #2] an Escape made during the replay’s GET is NOT undone, and its pending flag is kept until the host answers it', async () => {
    const P = 'user:p_inv_n2'
    const { a, h } = await online('n2', P, (h) => h.elsewhere(P, look('phosphor', 'still'))) // rev 1
    offline(P, look('ember-forge'), 0) // based on rev 0: the host has moved on
    h.holdGets(true)
    const load = loadLookBound(a.client as never)
    await flush()
    const esc = U.escapeToClassic(asClient(h.client)) // shown at once, pending
    await h.arriveGet(0) // the replay's GET answers: the host moved on, but a newer choice (the escape) stands
    await load
    await flush()
    expect(U.lookState().saved?.experience ?? null).toBeNull() // the escape is not undone
    expect(pendingFlags()).toBe(1) // its flag is kept while its own save is held
    expect(U.lookState().conflict ?? null).toBeNull()
    expect(h.made()).toBe(1) // only the escape's PUT
    await h.arrive(0) // the escape is accepted
    expect(await esc).toBe('saved')
    await flush()
    expect(pendingFlags()).toBe(0)
    expect.soft(h.host(P).prefs?.experience ?? null, 'host').toBeNull()
    expect.soft(U.lookState().saved?.experience ?? null, 'page').toBeNull()
  })

  it('[held GET, nothing newer] the replay still sends, conditionally, with its STORED base; host = page', async () => {
    const P = 'user:p_inv_n3'
    const { a, h } = await online('n3', P, (h) => h.elsewhere(P, look('phosphor'))) // rev 1
    offline(P, look('ember-forge'), 1)
    h.holdGets(true)
    const load = loadLookBound(a.client as never)
    await h.arriveGet(0)
    await h.arrive(0)
    await load
    await flush()
    expect(h.sent.map((s) => [s.method, s.base])).toEqual([['PUT', '1']])
    expect.soft(id(h.host(P).prefs), 'host').toBe('ember-forge')
    expect.soft(id(U.lookState().saved), 'page').toBe('ember-forge')
    expect(pendingFlags()).toBe(0)
  })
})

describe('r1o: a newer choice by the same person supersedes an unsent offline choice (Surface lead ruling)', () => {
  it('[stand-in r1n #1] offline Ember, a Keep of Deep Sea during the replay’s GET, then the Keep meets a conflict: Ember is never written; the notice offers Deep Sea; the device copy holds the host’s look; pending clears only by adoption; Ember stays in Your looks', async () => {
    const P = 'user:p_inv_o1'
    const a = testPerson('o1')
    const h = fakeHost(() => P)
    h.elsewhere(P, look('phosphor')) // rev 1
    await signedIn(a, h)
    useAskStore.getState().bind(useHive.getState().session, P)
    // Ember is one of the person's KEPT looks, and also the unsent offline choice
    const ember = look('ember-forge')
    RQ.addMyLook(P, { variant: ember.variant!, layout: null, words: 'ember', isNew: false })
    mem.set(`omegahive.ui.look:${P}`, JSON.stringify(ember))
    mem.set(`omegahive.ui.look.pending:${P}`, '1')
    mem.set(`omegahive.ui.look.offlinebase:${P}`, '1')
    h.holdGets(true)
    const load = loadLookBound(a.client as never) // the replay: its GET is held
    await flush()
    const keep = U.keepLook(asClient(h.client), look('deep-sea')).catch((e: Error) => e) // the person's newer choice
    await h.arriveGet(0) // the replay is discarded
    // a discarded replay settles at once: it queues no write behind the held Keep (an assertion, not a timeout, if it did)
    const settled = await Promise.race([load.then(() => true), flush().then(() => false)])
    expect(settled, 'the replay queued a write behind the newer choice').toBe(true)
    await flush()
    expect(pendingFlags()).toBe(1) // not cleared by the discard
    h.elsewhere(P, look('phosphor', 'still')) // another device changes the look (rev 2)
    await h.arrive(0) // the Keep's PUT (base 1): 409
    expect(await keep).toBeInstanceOf(U.NotKept)
    await flush()
    expect(h.sent.every((s) => s.method !== 'PUT' || s.base === '1')).toBe(true)
    expect(h.sent).toHaveLength(1) // Ember was never written to the host
    expect(id(h.host(P).prefs)).toBe('phosphor')
    expect(U.lookState().conflict).toMatchObject({ kind: 'keep', mine: { variant: { id: 'deep-sea' } } }) // offers Deep Sea
    expect(JSON.parse(mem.get(`omegahive.ui.look:${P}`) ?? 'null')).toMatchObject({ variant: { id: 'phosphor' }, experience: 'still' }) // the host's look
    expect(pendingFlags()).toBe(0) // cleared by the adoption
    expect(RQ.myLooks(P).map((l) => l.variant.id)).toContain('ember-forge') // still in Your looks
    useAskStore.getState().reset()
  })
})

describe('r1p: host adoption never erases the only copy of a look the person was told was kept (stand-in r1o P1)', () => {
  it('[adoption after a failed persist] a look from words is kept by the host but Your looks cannot be saved; another device moves the host; a later Keep meets the 409 and the page adopts: the look is still listed, marked unsaved, and every line said was honest', async () => {
    const P = 'user:p_inv_p1'
    const a = testPerson('p1')
    const h = fakeHost(() => P)
    await signedIn(a, h)
    useAskStore.getState().bind(useHive.getState().session, P)
    refuseWrites.add('omegahive.ui.mylooks.v1') // this device's storage is full for Your looks
    RQ.openRequest(true)
    RQ.tryWords('warmer')
    const made = RQ.requestState().previewing!.prefs.variant!
    const keep = RQ.keepRequestedOutcome(asClient(h.client))
    await h.arrive(0) // the host keeps it (rev 1)
    const out = await keep
    expect(out).toEqual({ kind: 'kept', shown: true, saved: false })
    expect(RQ.requestState()).toMatchObject({ kept: made.name, keptShown: true, keptId: made.id })
    expect(RQ.lookStatus(made.id, P)).toBe('held')
    const line = RQ.keptLine(made.name, true, RQ.lookStatus(made.id, P))
    expect(line).toMatch(/couldn’t save it/)
    expect(line).not.toMatch(/It’s in Your looks/)
    expect(RQ.myLooks(P).filter((l) => l.unsaved).map((l) => l.variant.id)).toEqual([made.id])
    expect(mem.has('omegahive.ui.mylooks.v1')).toBe(false) // nothing persisted: the session copy is the ONLY copy
    // another device changes the look; this device's next Keep meets the 409 and the page adopts the host's look
    h.elsewhere(P, look('phosphor', 'still'))
    const next = U.keepLook(asClient(h.client), look('deep-sea')).catch((e: Error) => e)
    await h.arrive(1)
    expect(await next).toBeInstanceOf(U.NotKept)
    await flush()
    expect(id(U.lookState().saved)).toBe('phosphor') // adopted
    expect(JSON.parse(mem.get(`omegahive.ui.look:${P}`) ?? 'null')).toMatchObject({ variant: { id: 'phosphor' } }) // the device copy is the host's now
    // the invariant: the look the person was told was kept is still listed, still marked, through adoption ...
    expect(RQ.myLooks(P).map((l) => l.variant.id)).toContain(made.id)
    expect(RQ.myLooks(P).find((l) => l.variant.id === made.id)?.unsaved).toBe(true)
    // ... and through the notice's own action: Use mine (Deep Sea, sent once, accepted)
    expect(U.lookState().conflict).toMatchObject({ kind: 'keep', mine: { variant: { id: 'deep-sea' } } })
    const again = U.chooseMineAgain(asClient(h.client))
    await flush()
    await h.arrive(2)
    await again
    await flush()
    expect(id(U.lookState().saved)).toBe('deep-sea')
    expect(RQ.myLooks(P).map((l) => l.variant.id)).toContain(made.id)
    expect(RQ.lookStatus(made.id, P)).toBe('held') // the line on screen (derived from it) still says it was not saved
    useAskStore.getState().reset()
  })
})
