import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * r1g: every caller of the async look API takes its binding BEFORE its await, so a sign-in change that lands AFTER the
 * callee has finished (its own last check passed, it answered for A) and BEFORE the caller resumes says nothing to the
 * next person. The REAL callee runs; a thin wrapper around it queues the switch in a microtask as it returns, so the
 * switch runs after the callee's final check and before the caller's continuation. One test per caller. The REAL store
 * identity change (identityEpoch testkit), synthetic SimClients, invented looks only.
 */
const mem = new Map<string, string>()
const storage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
}
vi.stubGlobal('localStorage', storage)
vi.stubGlobal('window', { location: { hash: '#/', search: '', pathname: '/' }, localStorage: storage, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} })

import type { UiPrefs } from './uiVariant'
const { escapeToClassic, lookState, previewLook, SEED_VARIANTS } = await import('./uiVariant')
const { loadLookBound } = await import('./lookIdentity')
const { barKeep, galleryKeep, galleryReset, LOOK_OPS } = await import('./lookActions')
const { GENERIC_REFUSAL } = await import('../features/requestExperience/store')
const { escapeAndSay } = await import('../experiences/escapeSay')
const R = await import('../features/requestExperience/store')
const { useAskStore } = await import('../store/ask')
const { useHive } = await import('../store/store')
const { isCurrent, releasePersons, signInAs, switchPerson, testPerson } = await import('../lib/identityEpoch.testkit')

const lookOf = (id: string, experience: string | null = null): UiPrefs => ({ variant: SEED_VARIANTS.find((v) => v.id === id)!, layout: null, apps: null, experience })
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
}

/** Same tab: A (in Still, on Ember Forge) then B (on Deep Sea). Every server call answers at once. */
async function signedInA(name: string) {
  const a = testPerson(`${name}-a`)
  const b = testPerson(`${name}-b`, { sameTab: a })
  const forA = () => isCurrent(a)
  Object.assign(a.client, {
    me: async () => ({ principal: forA() ? 'user:p_inv_act_a' : 'user:p_inv_act_b' }),
    uiPrefs: async () => ({ prefs: forA() ? lookOf('ember-forge', 'still') : lookOf('deep-sea'), updated_at: null }),
    setUiPrefs: async (p: UiPrefs) => ({ prefs: p, updated_at: 'now' }),
    resetUiPrefs: async () => ({ prefs: null, updated_at: null }),
  })
  await signInAs(a)
  await loadLookBound(a.client)
  useAskStore.getState().bind(useHive.getState().session, 'user:p_inv_act_a')
  expect(lookState().saved?.variant?.id).toBe('ember-forge')
  return { a, b }
}

type Person = ReturnType<typeof testPerson>
/** The real callee, answering for A, then (as it returns) a switch to B queued ahead of the caller's continuation. */
function thenSwitch<A extends unknown[], R>(fn: (...args: A) => Promise<R>, a: Person, b: Person, seen: { answer?: unknown }) {
  return async (...args: A): Promise<R> => {
    const r = await fn(...args)
    seen.answer = r
    queueMicrotask(() => void switchPerson(a, b))
    return r
  }
}

beforeEach(() => {
  mem.clear()
  previewLook(null)
  R.openRequest(false)
})
afterEach(() => {
  useAskStore.getState().reset()
  releasePersons()
})

describe('r1g: a switch after the callee answered for A, before the caller resumes, says nothing to B', () => {
  it('the gallery’s Keep this look (ChangeUi)', async () => {
    const { a, b } = await signedInA('gk')
    const said: string[] = []
    const seen: { answer?: unknown } = {}
    await galleryKeep(a.client, lookOf('phosphor'), (t) => void said.push(t.title), { ...LOOK_OPS, keep: thenSwitch(LOOK_OPS.keep, a, b, seen) })
    expect(seen.answer).toBe('kept') // the callee's own last check passed: it answered for A
    await settle()
    expect(isCurrent(b)).toBe(true)
    expect(said).toEqual([])
  })

  it('the gallery’s Reset to default (ChangeUi)', async () => {
    const { a, b } = await signedInA('gr')
    const said: string[] = []
    const seen: { answer?: unknown } = {}
    await galleryReset(a.client, (t) => void said.push(t.title), { ...LOOK_OPS, reset: thenSwitch(LOOK_OPS.reset, a, b, seen) })
    expect(seen.answer).toBe('done')
    await settle()
    expect(isCurrent(b)).toBe(true)
    expect(said).toEqual([])
  })

  it('the preview bar’s Keep (LookPreviewBar)', async () => {
    const { a, b } = await signedInA('bk')
    const said: string[] = []
    const seen: { answer?: unknown } = {}
    const p = lookOf('sakura-night')
    previewLook(p)
    await barKeep(a.client, p, 'Sakura Night', (t) => void said.push(t.title), { ...LOOK_OPS, keep: thenSwitch(LOOK_OPS.keep, a, b, seen) })
    expect(seen.answer).toBe('kept')
    await settle()
    expect(said).toEqual([])
  })

  it('the preview bar’s Keep of a look made from words (LookPreviewBar → Request an experience)', async () => {
    const { a, b } = await signedInA('bkw')
    const said: string[] = []
    const seen: { answer?: unknown } = {}
    R.openRequest(true)
    R.tryWords('calmer')
    const p = lookState().preview!
    await barKeep(a.client, p, p.variant!.name, (t) => void said.push(t.title), { ...LOOK_OPS, keepRequested: thenSwitch(LOOK_OPS.keepRequested, a, b, seen) })
    expect(seen.answer).toEqual({ kind: 'kept', shown: true, saved: true })
    await settle()
    expect(said).toEqual([])
  })

  it.each([
    ['the crash guard (always says)', 'always', false],
    ['the Ω way back (says when kept on this device only)', 'local', true],
  ] as const)('ExperienceHost’s escape: %s', async (_n, when, offline) => {
    const { a, b } = await signedInA(`esc-${when}`)
    if (offline) Object.assign(a.client, { setUiPrefs: async () => Promise.reject(new Error('offline')) })
    const said: string[] = []
    const seen: { answer?: unknown } = {}
    const where = await escapeAndSay('Back to the classic hive', { when, say: (t) => void said.push(t.title), escape: thenSwitch(escapeToClassic, a, b, seen) })
    expect(seen.answer).toBe(offline ? 'local' : 'saved')
    await settle()
    expect(isCurrent(b)).toBe(true)
    expect(where).toBe('stale')
    expect(said).toEqual([])
  })

  it('the request panel’s Keep it (RequestPanel → keepRequested): its writes are bound in the same tick as its check', async () => {
    const { a, b } = await signedInA('rp')
    R.openRequest(true)
    R.tryWords('warmer')
    // the switch lands after the save answered and before keepRequested resumes (the client is its callee here)
    Object.assign(a.client, {
      setUiPrefs: async (p: UiPrefs) => {
        queueMicrotask(() => queueMicrotask(() => void switchPerson(a, b)))
        return { prefs: p, updated_at: 'now' }
      },
    })
    const kept = await R.keepRequested(a.client)
    await settle()
    expect(isCurrent(b)).toBe(true)
    expect(kept).toBe(false)
    expect(R.myLooks('user:p_inv_act_a')).toEqual([])
    expect(R.requestState().kept).toBeNull()
  })

  it('without a switch, each caller still says it to the person who pressed it', async () => {
    const { a } = await signedInA('same')
    const said: string[] = []
    const say = (t: { title: string }) => void said.push(t.title)
    await galleryKeep(a.client, lookOf('phosphor'), say)
    await galleryReset(a.client, say)
    previewLook(lookOf('sakura-night'))
    await barKeep(a.client, lookOf('sakura-night'), 'Sakura Night', say)
    const where = await escapeAndSay('Back to the Classic hive', { when: 'always', say })
    expect(where).toBe('saved')
    // the gallery names what was kept, and the default look by its one name (small things F1, F21, F22)
    expect(said).toEqual(['Phosphor Terminal kept', 'Back to OmegaHive', 'Sakura Night kept', 'Back to the Classic hive'])
  })

  it('[Kimi r1g P2] the gallery’s Keep of a look from words: a refusal is said, as the preview bar says it', async () => {
    await signedInA('gk-refuse')
    const said: { tone: string; title: string; body?: string }[] = []
    const ops = { ...LOOK_OPS, fromWords: () => true, keepRequested: async () => ({ kind: 'refused' as const, reason: 'variant: ink on void is 2.00:1, below 7:1' }) }
    await galleryKeep(null, lookOf('phosphor'), (t) => void said.push(t), ops)
    expect(said).toEqual([{ tone: 'error', title: 'Could not keep this look', body: 'variant: ink on void is 2.00:1, below 7:1' }])
    // and the same with the preview bar, for parity
    const bar: string[] = []
    await barKeep(null, lookOf('phosphor'), 'Phosphor', (t) => void bar.push(t.title), ops)
    expect(bar).toEqual(['Could not keep this look'])
  })

  it.each([
    ['gallery', 'galleryKeep'],
    ['preview bar', 'barKeep'],
  ] as const)('[Kimi r1h P3] %s: a refusal with NO reason still says a plain generic line; superseded and idle say nothing', async (_n, which) => {
    await signedInA(`p3-${which}`)
    const run = async (out: Awaited<ReturnType<typeof LOOK_OPS.keepRequested>>) => {
      const said: { title: string; body?: string }[] = []
      const ops = { ...LOOK_OPS, fromWords: () => true, keepRequested: async () => out }
      if (which === 'galleryKeep') await galleryKeep(null, lookOf('phosphor'), (t) => void said.push(t), ops)
      else await barKeep(null, lookOf('phosphor'), 'Phosphor', (t) => void said.push(t), ops)
      return said
    }
    expect(await run({ kind: 'refused', reason: null })).toEqual([{ tone: 'error', title: 'Could not keep this look', body: GENERIC_REFUSAL }])
    // superseded: a newer request is showing (or the person changed); it speaks for itself
    expect(await run({ kind: 'superseded' })).toEqual([])
    expect(await run({ kind: 'idle' })).toEqual([])
  })

  it('[Kimi r1j #2] the preview bar’s Keep of words that was kept but is NOT on screen says exactly that', async () => {
    await signedInA('kept-hidden')
    const said: { title: string; body?: string }[] = []
    const ops = { ...LOOK_OPS, fromWords: () => true, keepRequested: async () => ({ kind: 'kept' as const, shown: false, saved: true }), lookStatus: () => 'saved' as const }
    await barKeep(null, lookOf('phosphor'), 'Phosphor', (t) => void said.push(t), ops)
    expect(said).toEqual([{ tone: 'success', title: 'Phosphor kept in Your looks', body: 'A newer choice is on screen now.' }])
  })

  it('[r1p/r1q] the preview bar’s Keep of words: what it says about Your looks comes from the look’s status WHEN SAID, never "kept in Your looks" unless saved there', async () => {
    await signedInA('kept-unsaved')
    const said: { title: string; body?: string }[] = []
    for (const [shown, status] of [[true, 'held'], [false, 'held'], [true, 'absent']] as const) {
      // the outcome's captured `saved` deliberately says the opposite: the message must not use it
      const ops = { ...LOOK_OPS, fromWords: () => true, keepRequested: async () => ({ kind: 'kept' as const, shown, saved: true }), lookStatus: () => status }
      await barKeep(null, lookOf('phosphor'), 'Phosphor', (t) => void said.push(t), ops)
    }
    expect(said).toEqual([
      { tone: 'info', title: 'Phosphor kept', body: R.keptLine('Phosphor', true, 'held') },
      { tone: 'info', title: 'Phosphor kept', body: R.keptLine('Phosphor', false, 'held') },
      { tone: 'info', title: 'Phosphor kept', body: 'Kept Phosphor as your look. It isn’t in Your looks.' },
    ])
    expect(said.every((t) => !/kept in Your looks|It’s in Your looks/.test(`${t.title} ${t.body}`))).toBe(true)
  })
})
