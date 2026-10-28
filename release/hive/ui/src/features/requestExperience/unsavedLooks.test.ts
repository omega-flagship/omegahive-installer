import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import panelSource from './RequestPanel.tsx?raw'
import changeUiSource from '../../shell/ChangeUi.tsx?raw'
import lookActionsSource from '../../shell/lookActions.ts?raw'
import type { MyLook } from './store'

/**
 * r1p (stand-in r1o P1): Your looks when this device cannot save them. A look the person was told was kept is never lost
 * silently: addMyLook says whether it persisted; when it did not, the look is held for this session, marked "Not saved
 * on this device", and the Keep line says so honestly. A failed read is never treated as "no looks" (a write over it
 * would erase other people's looks). The REAL store functions over a storage stub that can throw; invented looks only.
 */
const mem = new Map<string, string>()
const fail: { read: unknown; write: unknown } = { read: null, write: null }
const writes: string[] = []
const storage = {
  getItem: (k: string) => {
    if (fail.read) throw fail.read
    return mem.get(k) ?? null
  },
  setItem: (k: string, v: string) => {
    writes.push(k)
    if (fail.write) throw fail.write
    mem.set(k, String(v))
  },
  removeItem: (k: string) => void mem.delete(k),
}
vi.stubGlobal('localStorage', storage)
vi.stubGlobal('window', { location: { hash: '#/', search: '', pathname: '/' }, localStorage: storage, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} })

const { lookState, previewLook, restartSaveQueue, SEED_VARIANTS } = await import('../../shell/uiVariant')
const S = await import('./store')
const { barKeep } = await import('../../shell/lookActions')
const { useHive } = await import('../../store/store')
const { useAskStore } = await import('../../store/ask')
const { releasePersons, signInAs, switchPerson, testPerson } = await import('../../lib/identityEpoch.testkit')

const KEY = 'omegahive.ui.mylooks.v1'
const mine = (id: string, words = id): MyLook => ({ variant: SEED_VARIANTS.find((v) => v.id === id)!, layout: null, words, isNew: true })
const ids = (who: string) => S.myLooks(who).map((l) => l.variant.id)
const unsavedIds = (who: string) => S.myLooks(who).filter((l) => l.unsaved).map((l) => l.variant.id)
/** a browser's quota error, as thrown by localStorage.setItem when the origin's storage is full */
const quota = () => Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError', code: 22 })

beforeEach(() => {
  mem.clear()
  writes.length = 0
  fail.read = null
  fail.write = null
})
afterEach(() => {
  restartSaveQueue()
  previewLook(null)
  S.openRequest(false)
  useAskStore.getState().reset()
  releasePersons()
})
const bindAs = (principal: string) => useAskStore.getState().bind(useHive.getState().session, principal)

describe('r1p: Your looks when this device cannot save them (stand-in r1o P1)', () => {
  it('[stand-in probe] storage throws on every call: addMyLook says it did NOT persist, and the look is still listed (this session), marked unsaved', () => {
    const P = 'user:p_inv_p_probe'
    fail.read = new Error('SecurityError: storage is disabled')
    fail.write = new Error('SecurityError: storage is disabled')
    const saved = S.addMyLook(P, mine('ember-forge'))
    expect(saved).toBe('held')
    expect(ids(P)).toEqual(['ember-forge'])
    expect(unsavedIds(P)).toEqual(['ember-forge'])
  })

  it('[throws on write] the earlier saved looks stay listed as saved; the new one is held and marked; nothing written', () => {
    const P = 'user:p_inv_p_write'
    expect(S.addMyLook(P, mine('deep-sea'))).toBe('saved') // saved normally first
    fail.write = new Error('setItem refused')
    expect(S.addMyLook(P, mine('ember-forge'))).toBe('held')
    expect(ids(P)).toEqual(['ember-forge', 'deep-sea'])
    expect(unsavedIds(P)).toEqual(['ember-forge'])
    expect(JSON.parse(mem.get(KEY)!)[P].map((l: MyLook) => l.variant.id)).toEqual(['deep-sea']) // the device copy as it was
  })

  it('[throws on read] nothing is written over the unreadable store (other people’s looks are safe); the look is held and marked', () => {
    const P = 'user:p_inv_p_read'
    mem.set(KEY, JSON.stringify({ 'user:p_inv_other': [mine('phosphor')] }))
    const before = mem.get(KEY)
    fail.read = new Error('getItem refused')
    expect(S.addMyLook(P, mine('sakura-night'))).toBe('held')
    expect(writes).toEqual([]) // never a write after a failed read
    expect(mem.get(KEY)).toBe(before)
    expect(ids(P)).toEqual(['sakura-night'])
    expect(unsavedIds(P)).toEqual(['sakura-night'])
  })

  it('[unparseable store] treated as unreadable, not as empty: nothing is written over it', () => {
    const P = 'user:p_inv_p_corrupt'
    mem.set(KEY, '{not json')
    expect(S.addMyLook(P, mine('phosphor'))).toBe('held')
    expect(writes).toEqual([])
    expect(mem.get(KEY)).toBe('{not json')
    expect(unsavedIds(P)).toEqual(['phosphor'])
  })

  it('[storage full: QuotaExceededError] held for this session; when the device can save again, the next save writes them ALL and the marks go', () => {
    const P = 'user:p_inv_p_quota'
    expect(S.addMyLook(P, mine('deep-sea'))).toBe('saved')
    fail.write = quota()
    expect(S.addMyLook(P, mine('ember-forge'))).toBe('held')
    expect(S.addMyLook(P, mine('phosphor'))).toBe('held')
    expect(ids(P)).toEqual(['phosphor', 'ember-forge', 'deep-sea'])
    expect(unsavedIds(P)).toEqual(['phosphor', 'ember-forge'])
    fail.write = null // space was freed
    expect(S.addMyLook(P, mine('sakura-night'))).toBe('saved')
    const stored = JSON.parse(mem.get(KEY)!)[P] as MyLook[]
    expect(stored.map((l) => l.variant.id)).toEqual(['sakura-night', 'phosphor', 'ember-forge', 'deep-sea'])
    expect(stored.some((l) => 'unsaved' in l)).toBe(false) // the session mark is never stored
    expect(unsavedIds(P)).toEqual([])
  })

  it('the Keep line is honest: never "in Your looks" when nothing persisted', () => {
    expect(S.keptLine('My look: Warmer', true, 'saved')).toBe('Kept as My look: Warmer. It’s in Your looks, below.')
    expect(S.keptLine('My look: Warmer', false, 'saved')).toBe('Kept My look: Warmer in Your looks, below. A newer choice is on screen now.')
    const unsaved = S.keptLine('My look: Warmer', true, 'held')
    expect(unsaved).toBe('Kept My look: Warmer for now. This device couldn’t save it, so it will be gone from Your looks after you close the hive or sign out.')
    expect(unsaved).not.toMatch(/It’s in Your looks/)
    expect(S.keptLine('My look: Warmer', false, 'held')).toBe(`${unsaved} A newer choice is on screen now.`)
  })
})

describe('r1p: the message and the mark are bound to the real markup (static; only text changes visually)', () => {
  it('the request panel says keptLine(name, shown, the look’s status NOW), and nothing else, when a look is kept', () => {
    const src = panelSource
    expect(src).toContain('const keptStatus = useLookStatus(r.keptId)')
    expect(src).toContain('{keptLine(r.kept, r.keptShown, keptStatus)}')
    expect(src).not.toMatch(/It’s in Your looks/) // the only wording is the store's
  })
  it('Your looks marks a held look "Not saved on this device"', () => {
    const src = changeUiSource
    expect(src).toMatch(/\{l\.unsaved && \(\s*<span className="text-meta text-ink-3" data-tour="my-look-unsaved">\s*Not saved on this device\s*<\/span>/)
  })
  it('the preview bar’s words come from the look’s status when said (ops.lookStatus inside the commit), never from a captured flag', () => {
    const src = lookActionsSource
    const said = src.slice(src.indexOf('export async function barKeep'))
    expect(said).not.toMatch(/out\.saved/)
    expect(said).toMatch(/binding\.commit\(\(\) => \{\s*const status: LookStatus = ops\.lookStatus\(/)
    expect(said.indexOf("if (status !== 'saved')")).toBeLessThan(said.indexOf('kept in Your looks`')) // decided first
  })
})

describe('r1p: held looks belong to the person who kept them, for this sign-in only (identity epoch)', () => {
  it('[sign-out] A’s held looks are dropped at sign-out, at once; nothing of A’s is shown or stored', async () => {
    const a = testPerson('p-out-a')
    await signInAs(a)
    bindAs('user:p_inv_p_out_a')
    fail.write = quota()
    expect(S.addMyLook('user:p_inv_p_out_a', mine('ember-forge'))).toBe('held')
    expect(S.myLooks().map((l) => l.variant.id)).toEqual(['ember-forge'])
    // A signs out on this tab (the credential goes): the identity change happens inside this call
    const out = { name: 'signed-out', client: a.client, token: () => null }
    const done = switchPerson(a, out)
    expect(S.myLooks()).toEqual([]) // nobody bound
    expect(S.myLooks('user:p_inv_p_out_a')).toEqual([]) // A's held looks are gone, not merely hidden
    await done
    expect(mem.has(KEY)).toBe(false) // never stored
  })

  it('[A→B] A’s held looks are never shown to B, at the switch or after B is bound; B’s own looks are B’s', async () => {
    const a = testPerson('p-ab-a')
    const b = testPerson('p-ab-b')
    await signInAs(a)
    bindAs('user:p_inv_p_ab_a')
    fail.write = quota()
    S.addMyLook('user:p_inv_p_ab_a', mine('ember-forge'))
    expect(S.myLooks().map((l) => l.variant.id)).toEqual(['ember-forge'])
    const done = switchPerson(a, b)
    expect(S.myLooks()).toEqual([]) // at the switch, before B is known
    expect(S.myLooks('user:p_inv_p_ab_a')).toEqual([]) // dropped, not kept for later
    await done
    bindAs('user:p_inv_p_ab_b')
    expect(S.myLooks()).toEqual([])
    fail.write = null
    expect(S.addMyLook('user:p_inv_p_ab_b', mine('deep-sea'))).toBe('saved')
    expect(S.myLooks().map((l) => l.variant.id)).toEqual(['deep-sea'])
    expect(Object.keys(JSON.parse(mem.get(KEY)!))).toEqual(['user:p_inv_p_ab_b']) // nothing of A's reached the device
  })
})

/** a host that keeps every look it is sent (synthetic) */
const host = () => ({ sent: [] as unknown[], async setUiPrefs(p: unknown) { this.sent.push(p); return { prefs: p, updated_at: 'now' } } })
/** 24 distinct invented looks (seed looks under invented ids) */
const many = (n: number, tag: string): MyLook[] =>
  Array.from({ length: n }, (_, i) => ({ ...mine('deep-sea'), variant: { ...SEED_VARIANTS.find((v) => v.id === 'deep-sea')!, id: `${tag}-${i}`, name: `Look ${tag} ${i}` } }))
const storedIds = (who: string) => ((JSON.parse(mem.get(KEY) ?? '{}')[who] ?? []) as MyLook[]).map((l) => l.variant.id)

describe('r1q (stand-in r1p): every save is merge-then-write; the cap never discards; the Keep line is derived', () => {
  it('[stand-in probe P1a] save an old look; reads throw; hold another; reads recover; save again: the old look is still stored (recovery never drops it)', () => {
    const P = 'user:p_inv_q_merge'
    expect(S.addMyLook(P, mine('deep-sea'))).toBe('saved')
    fail.read = new Error('getItem refused')
    expect(S.addMyLook(P, mine('ember-forge'))).toBe('held')
    fail.read = null
    expect(S.addMyLook(P, mine('phosphor'))).toBe('saved')
    expect(storedIds(P).sort()).toEqual(['deep-sea', 'ember-forge', 'phosphor'])
    expect(storedIds(P)[0]).toBe('phosphor') // newest first
    expect(ids(P).sort()).toEqual(['deep-sea', 'ember-forge', 'phosphor'])
    expect(unsavedIds(P)).toEqual([])
  })

  it('[recovery beside another person] the other person’s stored looks are untouched, byte for byte', () => {
    const P = 'user:p_inv_q_mine'
    const O = 'user:p_inv_q_other'
    mem.set(KEY, JSON.stringify({ [O]: [mine('sakura-night'), mine('phosphor')] }))
    const otherBefore = JSON.stringify(JSON.parse(mem.get(KEY)!)[O])
    fail.write = quota()
    expect(S.addMyLook(P, mine('ember-forge'))).toBe('held')
    fail.write = null
    expect(S.addMyLook(P, mine('deep-sea'))).toBe('saved')
    expect(JSON.stringify(JSON.parse(mem.get(KEY)!)[O])).toBe(otherBefore)
    expect(storedIds(P)).toEqual(['deep-sea', 'ember-forge'])
  })

  it('[stand-in probe P1b: the cap, every write failing] 24 held looks; the 25th is REFUSED; all 24 are still listed, the first among them', () => {
    const P = 'user:p_inv_q_cap'
    fail.write = quota()
    const looks = many(24, 'cap')
    for (const l of looks) expect(S.addMyLook(P, l)).toBe('held')
    expect(S.addMyLook(P, mine('ember-forge'))).toBe('full')
    expect(ids(P)).toHaveLength(24)
    expect(ids(P)).toContain('cap-0') // the first is never discarded
    expect(ids(P)).not.toContain('ember-forge')
    expect(S.addMyLook(P, looks[0])).toBe('held') // one already there replaces itself: not "one more"
    expect(ids(P)).toHaveLength(24)
  })

  it('[the cap at Keep] at 24 a Keep is refused with the honest line, BEFORE the host is asked; the look stays on screen; nothing truncated', async () => {
    const a = testPerson('q-capkeep')
    await signInAs(a)
    const P = 'user:p_inv_q_capkeep'
    bindAs(P)
    mem.set(KEY, JSON.stringify({ [P]: many(24, 'k') }))
    S.openRequest(true)
    S.tryWords('warmer')
    const shown = lookState().preview
    const c = host()
    const out = await S.keepRequestedOutcome(c)
    expect(out).toEqual({ kind: 'refused', reason: S.FULL_LINE })
    expect(S.FULL_LINE).toBe('Your looks is full (24). Remove one to keep this.')
    expect(c.sent).toEqual([]) // the host was never asked
    expect(S.requestState()).toMatchObject({ error: S.FULL_LINE, kept: null })
    expect(lookState().preview).toBe(shown) // the look stays on screen as the preview
    expect(storedIds(P)).toHaveLength(24)
  })

  it('[a Remove during failure] stays removed after recovery (a tombstone), and nothing else is dropped', async () => {
    const a = testPerson('q-remove')
    await signInAs(a)
    const P = 'user:p_inv_q_remove'
    bindAs(P)
    expect(S.addMyLook(P, mine('phosphor'))).toBe('saved')
    expect(S.addMyLook(P, mine('deep-sea'))).toBe('saved')
    fail.write = quota()
    S.removeMyLook('phosphor')
    expect(ids(P)).toEqual(['deep-sea']) // removed on screen at once
    expect(storedIds(P)).toContain('phosphor') // the device could not apply it yet
    fail.write = null
    expect(S.addMyLook(P, mine('ember-forge'))).toBe('saved')
    expect(storedIds(P)).toEqual(['ember-forge', 'deep-sea'])
    expect(ids(P)).toEqual(['ember-forge', 'deep-sea'])
  })

  it('[stand-in probe P2] the Keep line is derived: held → "for now"; once a later save persists it, the SAME request’s line says it is in Your looks', async () => {
    const a = testPerson('q-line')
    await signInAs(a)
    const P = 'user:p_inv_q_line'
    bindAs(P)
    fail.write = quota()
    S.openRequest(true)
    S.tryWords('warmer')
    const out = await S.keepRequestedOutcome(host())
    expect(out).toMatchObject({ kind: 'kept', shown: true, saved: false })
    const r = S.requestState()
    expect(S.lookStatus(r.keptId!)).toBe('held')
    expect(S.keptLine(r.kept!, r.keptShown, S.lookStatus(r.keptId!))).toMatch(/for now\. This device couldn’t save it/)
    fail.write = null
    S.markSeen(r.keptId!) // opening it from the gallery saves the list now that the device can
    expect(S.lookStatus(r.keptId!)).toBe('saved')
    expect(S.keptLine(r.kept!, r.keptShown, S.lookStatus(r.keptId!))).toBe(`Kept as ${r.kept}. It’s in Your looks, below.`)
    expect(storedIds(P)).toEqual([r.keptId])
  })

  it('[the full-after-accept race] Your looks fill while the host is keeping it: the host keeps it, nothing is truncated, and BOTH the panel line and the preview bar say it is not in Your looks', async () => {
    const a = testPerson('q-race')
    await signInAs(a)
    const P = 'user:p_inv_q_race'
    bindAs(P)
    S.openRequest(true)
    S.tryWords('warmer')
    const p = S.requestState().previewing!.prefs
    const gate: { release?: () => void } = {}
    const c = {
      async setUiPrefs(x: unknown) {
        await new Promise<void>((r) => (gate.release = r))
        return { prefs: x, updated_at: 'now' }
      },
    }
    const said: { tone: string; title: string; body?: string }[] = []
    const keep = barKeep(c as never, p, p.variant!.name, (t) => void said.push(t)) // the cap check passes: 0 looks
    for (let i = 0; i < 20 && !gate.release; i++) await new Promise((r) => setTimeout(r, 0))
    expect(gate.release, 'the host was asked').toBeDefined()
    for (const l of many(24, 'race')) expect(S.addMyLook(P, l)).toBe('saved') // filled meanwhile (another Keep, say)
    gate.release!()
    await keep
    expect(storedIds(P)).toHaveLength(24) // nothing truncated, and the new look not squeezed in
    expect(ids(P)).not.toContain(p.variant!.id)
    expect(S.lookStatus(p.variant!.id)).toBe('absent')
    expect(lookState().saved?.variant?.id).toBe(p.variant!.id) // the host kept it as the person's look
    const r = S.requestState()
    expect(S.keptLine(r.kept!, r.keptShown, S.lookStatus(r.keptId!))).toBe(`Kept ${p.variant!.name} as your look. It isn’t in Your looks.`)
    expect(said).toEqual([{ tone: 'info', title: `${p.variant!.name} kept`, body: `Kept ${p.variant!.name} as your look. It isn’t in Your looks.` }])
  })

  it('[static] the panel says a refusal as "Could not keep this look: <reason>", so the cap line is shown as written', () => {
    expect(panelSource).toMatch(/Could not keep this look: \{r\.error\}/)
  })
})
