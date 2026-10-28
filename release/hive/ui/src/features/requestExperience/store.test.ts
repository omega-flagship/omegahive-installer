import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * "Request an experience", step 1: preview, Undo and Keep; personal looks per person on this device; an identity
 * change drops another person's unsaved preview at once. The REAL store identity change (identityEpoch testkit),
 * synthetic SimClients and invented principals only.
 */
const mem = new Map<string, string>()
const storage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
}
vi.stubGlobal('localStorage', storage)
vi.stubGlobal('window', { location: { hash: '#/', search: '', pathname: '/' }, localStorage: storage, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} })

import type { UiPrefs } from '../../shell/uiVariant'
const { useHive } = await import('../../store/store')
const { useAskStore } = await import('../../store/ask')
const { keepLook, loadLook, lookState, previewLook, resetLook, restartSaveQueue, DEFAULT_VARIANT, SEED_VARIANTS } = await import('../../shell/uiVariant')
const { releasePersons, signInAs, switchPerson, testPerson } = await import('../../lib/identityEpoch.testkit')
const { bindEpoch } = await import('../../lib/identityEpoch')
const S = await import('./store')

function fakeClient(opts: { refuse?: boolean; hold?: boolean } = {}) {
  let release: () => void = () => undefined
  return {
    saved: [] as unknown[],
    release: () => release(),
    async setUiPrefs(p: unknown) {
      if (opts.hold) await new Promise<void>((r) => (release = r))
      if (opts.refuse) throw new Error('variant: ink on void is 2.00:1, below 7:1')
      this.saved.push(p)
      return { prefs: p, updated_at: 'now' }
    },
  }
}
const bindAs = (principal: string) => useAskStore.getState().bind(useHive.getState().session, principal)

beforeEach(() => {
  mem.clear()
  previewLook(null)
  S.openRequest(false)
})
afterEach(() => {
  restartSaveQueue() // a test that leaves an answer held never holds up the next test's saves
  useAskStore.getState().reset()
  releasePersons()
})

describe('preview, Undo and Keep', () => {
  it('the words preview at once; Undo puts back what was on screen, and keeps the words', () => {
    const before = { variant: DEFAULT_VARIANT, layout: 'dock' as const, apps: null, experience: null }
    previewLook(before)
    S.openRequest(true)
    S.setWords('calmer and warmer, bigger text')
    S.tryWords()
    const shown = lookState().preview!
    expect(shown.variant?.name).toBe('My look: Calmer, warmer, bigger text')
    expect(shown.variant?.density).toBe('roomy')
    expect(shown.layout).toBe('dock')
    S.undoPreview()
    expect(lookState().preview).toBe(before)
    expect(S.requestState().words).toBe('calmer and warmer, bigger text')
    expect(S.requestState().previewing).toBeNull()
  })

  it('a second try starts from the look before the first, not on top of it', () => {
    S.openRequest(true)
    S.tryWords('darker')
    S.tryWords('calmer')
    expect(lookState().preview?.variant?.colors.void).toBe(DEFAULT_VARIANT.colors.void)
    expect(lookState().preview?.variant?.motion).toBe('calm')
    S.undoPreview()
    expect(lookState().preview).toBeNull()
  })

  it('words that need a mind make no preview and call nothing', async () => {
    const c = fakeClient()
    S.openRequest(true)
    const d = S.tryWords('make it a game like a city')
    expect(d.looks).toEqual([])
    expect(d.beyond.length).toBeGreaterThan(0)
    expect(lookState().preview).toBeNull()
    expect(await S.keepRequested(c)).toBe(false)
    expect(c.saved).toEqual([])
  })

  it('Keep saves it as the person’s look, then as one of their looks, marked New', async () => {
    const a = testPerson('keep-a')
    await signInAs(a)
    bindAs('user:p_inv_keep')
    const c = fakeClient()
    S.openRequest(true)
    S.setWords('calmer, warmer, bigger text, like a train timetable')
    S.tryWords()
    expect(await S.keepRequested(c)).toBe(true)
    expect(c.saved).toHaveLength(1)
    expect(lookState().saved?.variant?.name).toBe('My look: Calmer, warmer, bigger text')
    expect(lookState().preview).toBeNull()
    const mine = S.myLooks()
    expect(mine.map((l) => [l.variant.name, l.isNew])).toEqual([['My look: Calmer, warmer, bigger text', true]])
    expect(S.requestState().kept).toBe('My look: Calmer, warmer, bigger text')
    S.markSeen(mine[0].variant.id)
    expect(S.myLooks()[0].isNew).toBe(false)
    S.removeMyLook(mine[0].variant.id)
    expect(S.myLooks()).toEqual([])
  })

  it('a look the host refuses is not kept anywhere, and says why', async () => {
    const a = testPerson('refuse-a')
    await signInAs(a)
    bindAs('user:p_inv_refuse')
    S.openRequest(true)
    S.tryWords('warmer')
    expect(await S.keepRequested(fakeClient({ refuse: true }))).toBe(false)
    expect(S.requestState().error).toMatch(/below 7:1/)
    expect(S.myLooks()).toEqual([])
  })
})

describe('personal looks belong to the signed-in person', () => {
  it('persist per person on this device, and another person sees only their own', async () => {
    const a = testPerson('pa')
    const b = testPerson('pb')
    await signInAs(a)
    bindAs('user:p_inv_a')
    S.openRequest(true)
    S.tryWords('cooler')
    await S.keepRequested(fakeClient())
    expect(S.myLooks().map((l) => l.variant.name)).toEqual(['My look: Cooler'])
    expect(mem.get('omegahive.ui.mylooks.v1')).toContain('user:p_inv_a')

    const done = switchPerson(a, b)
    expect(S.myLooks()).toEqual([]) // nobody bound yet: nothing of A's shows
    await done
    bindAs('user:p_inv_b')
    expect(S.myLooks()).toEqual([])
    expect(S.myLooks('user:p_inv_a').map((l) => l.variant.name)).toEqual(['My look: Cooler']) // still A's, on this device
  })

  it('an identity switch drops the other person’s unsaved preview and words at once', async () => {
    const a = testPerson('sw-a')
    const b = testPerson('sw-b', { sameTab: a })
    await signInAs(a)
    bindAs('user:p_inv_a2')
    S.openRequest(true)
    S.setWords('warmer, a pink accent')
    S.tryWords()
    expect(lookState().preview?.variant?.name).toMatch(/^My look/)

    const done = switchPerson(a, b)
    expect(lookState().preview).toBeNull()
    expect(S.requestState()).toMatchObject({ open: false, words: '', previewing: null, result: null })
    await done
  })

  it.each([['another tab', false], ['the same tab (credential only)', true]] as const)('an earlier gallery preview is NOT restored for the next person (%s; stand-in r1b P1)', async (_n, sameTab) => {
    const a = testPerson(`gp-a-${sameTab}`)
    const b = sameTab ? testPerson(`gp-b-${sameTab}`, { sameTab: a }) : testPerson(`gp-b-${sameTab}`)
    await signInAs(a)
    bindAs('user:p_inv_gp')
    // A previews a gallery look, then asks for another from words
    const galleryPreview = { variant: SEED_VARIANTS.find((v) => v.id === 'ember-forge')!, layout: 'dock' as const, apps: null, experience: null }
    previewLook(galleryPreview)
    S.openRequest(true)
    S.tryWords('warmer, bigger text')
    expect(lookState().preview?.variant?.name).toMatch(/^My look/)

    const done = switchPerson(a, b)
    // nothing of A's is on screen for B: neither the words' look nor the gallery look before it
    expect(lookState().preview).toBeNull()
    expect(S.requestState().previewing).toBeNull()
    await done
    expect(lookState().preview).toBeNull()
    // and so there is nothing for B to keep
    expect(await S.keepRequested(fakeClient())).toBe(false)
  })

  it('a gallery preview alone is cleared by an identity change too', async () => {
    const a = testPerson('gp-only-a')
    const b = testPerson('gp-only-b', { sameTab: a })
    await signInAs(a)
    previewLook({ variant: SEED_VARIANTS[1], layout: null, apps: null, experience: null })
    const done = switchPerson(a, b)
    expect(lookState().preview).toBeNull()
    await done
  })

  it('Undo and close by the same person still bring back what was there before', () => {
    const galleryPreview = { variant: SEED_VARIANTS[1], layout: null, apps: null, experience: null }
    previewLook(galleryPreview)
    S.openRequest(true)
    S.tryWords('calmer')
    S.undoPreview()
    expect(lookState().preview).toBe(galleryPreview)
    S.tryWords('calmer')
    S.openRequest(false)
    expect(lookState().preview).toBe(galleryPreview)
  })

  it('a Keep that lands after the person changed adds nothing to anyone’s looks', async () => {
    const a = testPerson('late-a')
    const b = testPerson('late-b', { sameTab: a })
    await signInAs(a)
    bindAs('user:p_inv_late')
    const c = fakeClient({ hold: true })
    S.openRequest(true)
    S.tryWords('calmer')
    const kept = S.keepRequested(c)
    const done = switchPerson(a, b)
    c.release()
    expect(await kept).toBe(false)
    await done
    expect(S.myLooks('user:p_inv_late')).toEqual([])
    expect(S.myLooks()).toEqual([])
    // nor is it applied on this page as the next person's look
    expect(lookState().saved?.variant?.id).not.toBe('my-calmer')
    expect(lookState().preview).toBeNull()
  })

  it('nobody known: looks last for this page and sign-in only', async () => {
    const a = testPerson('anon-a')
    const b = testPerson('anon-b')
    await signInAs(a)
    S.openRequest(true)
    S.tryWords('darker')
    await S.keepRequested(fakeClient())
    expect(S.myLooks().length).toBe(1)
    expect(mem.get('omegahive.ui.mylooks.v1')).toBeUndefined()
    await switchPerson(a, b)
    expect(S.myLooks()).toEqual([])
  })
})

describe('Kimi r1g on r1g: ids, busy, and the look the panel opened on', () => {
  it('[P2] two looks from the same words never collide: the second gets -2, and both are kept', async () => {
    const a = testPerson('ids-a')
    await signInAs(a)
    bindAs('user:p_inv_ids')
    const c = fakeClient()
    S.openRequest(true)
    S.tryWords('calmer warmer')
    expect(await S.keepRequested(c)).toBe(true)
    S.openRequest(true)
    S.tryWords('calmer, warmer')
    const second = lookState().preview!.variant!.id
    expect(await S.keepRequested(c)).toBe(true)
    const ids = S.myLooks().map((l) => l.variant.id)
    expect(ids).toEqual([second, 'my-calmer-warmer'])
    expect(second).toBe('my-calmer-warmer-2')
  })

  it('[P2] nor with a seed, the saved look or the look on screen', async () => {
    const a = testPerson('ids-b')
    await signInAs(a)
    bindAs('user:p_inv_ids_b')
    // a look kept elsewhere (not in this device's list) is the saved look now
    await keepLook(fakeClient() as unknown as Parameters<typeof keepLook>[0], { variant: { ...DEFAULT_VARIANT, id: 'my-darker', name: 'My look: Darker' }, layout: null, apps: null, experience: null })
    S.openRequest(true)
    S.tryWords('darker')
    expect(lookState().preview!.variant!.id).toBe('my-darker-2')
    for (const seed of SEED_VARIANTS) expect(lookState().preview!.variant!.id).not.toBe(seed.id)
  })

  it('[P4] busy is released for the same request on every path, and a late finish never clears another request’s', async () => {
    const a = testPerson('busy-a')
    const b = testPerson('busy-b', { sameTab: a })
    await signInAs(a)
    bindAs('user:p_inv_busy_a')
    // refused for the same person: released
    S.openRequest(true)
    S.tryWords('calmer')
    expect(await S.keepRequested(fakeClient({ refuse: true }))).toBe(false)
    expect(S.requestState().busy).toBe(false)
    // A's keep is held; the person changes; B starts a request and a keep of their own, also held
    const heldA = fakeClient({ hold: true })
    S.tryWords('warmer')
    const keptA = S.keepRequested(heldA)
    expect(S.requestState().busy).toBe(true)
    await switchPerson(a, b)
    bindAs('user:p_inv_busy_b')
    S.openRequest(true)
    S.tryWords('cooler')
    const heldB = fakeClient({ hold: true })
    const keptB = S.keepRequested(heldB)
    expect(S.requestState().busy).toBe(true)
    heldA.release() // A's answer lands under B
    expect(await keptA).toBe(false)
    expect(S.requestState().busy).toBe(true) // still B's keep in progress: not cleared by A's finish
    heldB.release()
    expect(await keptB).toBe(true)
    expect(S.requestState().busy).toBe(false)
  })

  it('[P5] the base look is the one on screen when the panel OPENED, not a gallery preview picked afterwards', () => {
    previewLook(null)
    S.openRequest(true) // nothing previewed when it opens
    const ember = { variant: SEED_VARIANTS.find((v) => v.id === 'ember-forge')!, layout: 'dock' as const, apps: null, experience: null }
    previewLook(ember) // a gallery look picked while the panel is open
    S.tryWords('calmer')
    const shown = lookState().preview!
    // built on the look at open (the saved look, nothing previewed), not on Ember Forge
    expect(shown.variant?.colors).toEqual((lookState().saved?.variant ?? DEFAULT_VARIANT).colors)
    expect(shown.variant?.colors).not.toEqual(ember.variant.colors)
    expect(shown.layout).toBe(lookState().saved?.layout ?? null)
    S.undoPreview()
    expect(lookState().preview).toBeNull() // back to the look at open
  })
})

/**
 * Stand-in r1h harness: the REAL request store and look store, ONE identity throughout (no switch, so the identity
 * epoch cannot hide anything), and the host's answers held as promises the test releases in the order it chooses.
 */
function hostHarness() {
  const pending: { release: () => void; fail: () => void }[] = []
  const saves: UiPrefs[] = []
  const client = {
    setUiPrefs: (p: UiPrefs) =>
      new Promise<{ prefs: UiPrefs; updated_at: string }>((res, rej) => {
        pending.push({ release: () => (saves.push(p), res({ prefs: p, updated_at: 'now' })), fail: () => rej(new Error('variant: refused by the host (invented)')) })
      }),
  }
  /** the host's stored look: the last call it ACCEPTED, in the order it processed them */
  const host = () => (saves.length ? saves[saves.length - 1] : undefined)
  /** the i-th call the host has received, once the ordered queue has made it (calls are made in turn, not at once) */
  const call = async (i: number) => {
    for (let k = 0; k < 50 && !pending[i]; k++) await new Promise((r) => setTimeout(r, 0))
    return pending[i]
  }
  return { client, saves, host, call, made: () => pending.length, nth: (i: number) => pending[i] }
}
const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('stand-in r1h: request-scoped writes, the effective base, one replaceable id (same identity, held answers)', () => {
  it.each(['rejection', 'success'] as const)('[P4] a late Keep A %s after close/reopen, with Keep B in flight, never touches B’s request', async (how) => {
    const a = testPerson(`p4-${how}`)
    await signInAs(a)
    bindAs(`user:p_inv_p4_${how}`)
    const h = hostHarness()
    S.openRequest(true)
    S.tryWords('calmer')
    const keepA = S.keepRequested(h.client)
    expect(S.requestState().busy).toBe(true)
    // the same person closes and reopens the panel, and keeps another look
    S.openRequest(false)
    S.openRequest(true)
    S.tryWords('warmer')
    const bPreview = S.requestState().previewing
    const keepB = S.keepRequested(h.client)
    const bId = S.requestState().id
    expect(S.requestState().busy).toBe(true)
    // A's answer lands now (B waits its turn in the one ordered save queue)
    const a0 = (await h.call(0))!
    expect(h.made()).toBe(1)
    if (how === 'rejection') a0.fail()
    else a0.release()
    expect(await keepA).toBe(false) // nothing of A's is shown on B's request
    await flush()
    expect(S.requestState()).toMatchObject({ id: bId, busy: true, error: null, kept: null })
    expect(S.requestState().previewing).toBe(bPreview)
    if (how === 'success') expect(S.myLooks().map((l) => l.words)).toContain('calmer') // A's look is still the person's
    // B's own answer settles B
    ;(await h.call(1))!.release()
    expect(await keepB).toBe(true)
    expect(S.requestState()).toMatchObject({ busy: false, error: null, kept: expect.stringMatching(/^My look: Warmer/) })
  })

  it('[P5] the base is the effective look at OPEN: a gallery Keep after opening does not move it', async () => {
    const a = testPerson('p5-keep')
    await signInAs(a)
    const ember = { variant: SEED_VARIANTS.find((v) => v.id === 'ember-forge')!, layout: null, apps: null, experience: null }
    const deep = { variant: SEED_VARIANTS.find((v) => v.id === 'deep-sea')!, layout: null, apps: null, experience: null }
    await keepLook(fakeClient() as unknown as Parameters<typeof keepLook>[0], ember) // saved: Ember Forge
    previewLook(null)
    S.openRequest(true) // opens on Ember Forge (no preview: the saved look is what shows)
    await keepLook(fakeClient() as unknown as Parameters<typeof keepLook>[0], deep) // a gallery Keep after opening
    expect(lookState().saved?.variant?.id).toBe('deep-sea')
    S.tryWords('calmer')
    expect(lookState().preview?.variant?.colors).toEqual(ember.variant.colors)
    S.undoPreview()
    expect(lookState().preview).toBeNull()
  })

  it('[P5] … nor does a saved look that loads late, after opening', async () => {
    const a = testPerson('p5-load')
    await signInAs(a)
    const phosphor = { variant: SEED_VARIANTS.find((v) => v.id === 'phosphor')!, layout: null, apps: null, experience: null }
    const sakura = { variant: SEED_VARIANTS.find((v) => v.id === 'sakura-night')!, layout: null, apps: null, experience: null }
    await keepLook(fakeClient() as unknown as Parameters<typeof keepLook>[0], phosphor)
    previewLook(null)
    S.openRequest(true) // opens on Phosphor
    let answer: (v: { prefs: UiPrefs; updated_at: null }) => void = () => undefined
    const slow = {
      me: async () => ({ principal: 'user:p_inv_p5_load' }),
      uiPrefs: () => new Promise<{ prefs: UiPrefs; updated_at: null }>((r) => (answer = r)),
      setUiPrefs: async (p: UiPrefs) => ({ prefs: p, updated_at: 'now' }),
      resetUiPrefs: async () => ({ prefs: null, updated_at: null }),
    }
    const loading = loadLook(slow as unknown as Parameters<typeof loadLook>[0])
    await flush()
    answer({ prefs: sakura, updated_at: null }) // the saved look arrives late: Sakura Night
    await loading
    expect(lookState().saved?.variant?.id).toBe('sakura-night')
    S.tryWords('calmer')
    expect(lookState().preview?.variant?.colors).toEqual(phosphor.variant.colors)
  })

  it('[P2] try "darker", change its layout, Keep through the gallery, try "darker" again: a NEW id', async () => {
    const a = testPerson('p2-gallery')
    await signInAs(a)
    S.openRequest(true)
    S.tryWords('darker')
    const first = lookState().preview!
    const firstId = first.variant!.id
    // the gallery's layout control makes a new preview of the same look, which the ordinary gallery Keep then keeps
    const docked = { ...first, layout: 'dock' as const }
    previewLook(docked)
    await keepLook(fakeClient() as unknown as Parameters<typeof keepLook>[0], docked)
    expect(lookState().saved?.variant?.id).toBe(firstId)
    S.tryWords('darker')
    const second = lookState().preview!.variant!.id
    expect(second).not.toBe(firstId)
    expect(second).toBe(`${firstId}-2`)
  })

  it('[P2] a re-try still REPLACES its own previous try (the one replaceable entry keeps its id)', () => {
    S.openRequest(true)
    S.tryWords('cooler')
    const firstId = lookState().preview!.variant!.id
    S.tryWords('cooler')
    expect(lookState().preview!.variant!.id).toBe(firstId)
  })
})

/** Kimi r1h, on r1i: the same harness (the REAL stores, ONE identity, host answers held and released in order). */
describe('Kimi r1h: a kept id stays reserved, refusals have a reason, saves land in order, Undo after Keep', () => {
  it('[P2] the same words on the same base after a Keep get a NEW id, and Your looks gains a second entry', async () => {
    const a = testPerson('k-p2')
    await signInAs(a)
    bindAs('user:p_inv_k_p2')
    previewLook(null)
    S.openRequest(true)
    S.tryWords('calmer warmer')
    const firstId = lookState().preview!.variant!.id
    expect(await S.keepRequested(fakeClient())).toBe(true)
    // the same panel, the same words, the same base (the kept look is now the base, so the look is rebuilt on it)
    S.tryWords('calmer warmer')
    const secondId = lookState().preview!.variant!.id
    expect(secondId).not.toBe(firstId)
    expect(await S.keepRequested(fakeClient())).toBe(true)
    const ids = S.myLooks().map((l) => l.variant.id)
    expect(ids).toContain(firstId)
    expect(ids).toContain(secondId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('[P3] a host that answers without keeping (no look echoed, no error) is a refusal with a plain reason, never "kept"', async () => {
    const a = testPerson('k-p3')
    await signInAs(a)
    bindAs('user:p_inv_k_p3')
    S.openRequest(true)
    S.tryWords('cooler')
    const before = lookState().saved
    const okFalse = { setUiPrefs: async () => ({ ok: false }) }
    const out = await S.keepRequestedOutcome(okFalse)
    expect(out).toEqual({ kind: 'refused', reason: S.GENERIC_REFUSAL })
    expect(S.requestState()).toMatchObject({ busy: false, error: S.GENERIC_REFUSAL, kept: null })
    expect(lookState().saved).toBe(before)
    expect(S.myLooks().map((l) => l.words)).not.toContain('cooler')
  })

  it('[P3] a Keep answered after the panel was closed and reopened (same person) is "superseded": nothing to say for it', async () => {
    const a = testPerson('k-p3s')
    await signInAs(a)
    bindAs('user:p_inv_k_p3s')
    const h = hostHarness()
    S.openRequest(true)
    S.tryWords('darker')
    const late = S.keepRequestedOutcome(h.client)
    S.openRequest(false)
    S.openRequest(true)
    ;(await h.call(0))!.fail()
    expect(await late).toEqual({ kind: 'superseded' })
    expect(S.requestState().error).toBeNull()
  })

  it('[P4] bindRequest guards every request write after the await: the start is synchronous on its own request', async () => {
    const a = testPerson('k-p4b')
    await signInAs(a)
    bindAs('user:p_inv_k_p4b')
    const h = hostHarness()
    S.openRequest(true)
    S.tryWords('warmer')
    const id = S.requestState().id
    const keep = S.keepRequestedOutcome(h.client)
    // the only write before the await: busy, on THIS request, in the same tick as the press
    expect(S.requestState()).toMatchObject({ id, busy: true })
    // a second press while it is on its way does nothing
    expect(await S.keepRequestedOutcome(h.client)).toEqual({ kind: 'idle' })
    ;(await h.call(0))!.release()
    expect(await keep).toEqual({ kind: 'kept', shown: true, saved: true })
  })

  it('[P5] after a Keep, the next try starts from the KEPT look and Undo returns to it, even if the saved look changes next', async () => {
    const a = testPerson('k-p5')
    await signInAs(a)
    bindAs('user:p_inv_k_p5')
    previewLook(null)
    S.openRequest(true)
    S.tryWords('darker')
    expect(await S.keepRequested(fakeClient())).toBe(true)
    const kept = lookState().saved!
    // the gallery keeps another look after that
    const deep = { variant: SEED_VARIANTS.find((v) => v.id === 'deep-sea')!, layout: null, apps: null, experience: null }
    await keepLook(fakeClient() as unknown as Parameters<typeof keepLook>[0], deep)
    S.tryWords('calmer')
    expect(lookState().preview?.variant?.colors).toEqual(kept.variant!.colors) // built on the kept look
    S.undoPreview()
    expect(lookState().preview?.variant?.id).toBe(kept.variant!.id) // Undo shows the kept look, not Deep Sea
  })

  it('[P5] after a Keep with nothing else changing, Undo simply shows the saved (kept) look, no preview', async () => {
    const a = testPerson('k-p5b')
    await signInAs(a)
    bindAs('user:p_inv_k_p5b')
    previewLook(null)
    S.openRequest(true)
    S.tryWords('cooler')
    expect(await S.keepRequested(fakeClient())).toBe(true)
    S.tryWords('calmer')
    S.undoPreview()
    expect(lookState().preview).toBeNull()
  })
})

/**
 * Stand-in r1j / Kimi r1j: ONE ordered save queue, results from the host. The REAL stores, one identity, the host's
 * answers held and released by the test. Every test asserts the HOST's final value and the PAGE first, as behaviour:
 * where an older build sent both saves at once, the test releases them in the stand-in's racing order; where the queue
 * holds the second back, it releases them in turn. Either way the assertion is the same outcome.
 */
describe('stand-in r1j / Kimi r1j: one ordered save queue (host and page agree)', () => {
  const ember = () => ({ variant: SEED_VARIANTS.find((v) => v.id === 'ember-forge')!, layout: null, apps: null, experience: null })
  const deep = () => ({ variant: SEED_VARIANTS.find((v) => v.id === 'deep-sea')!, layout: null, apps: null, experience: null })
  const asClient = (c: unknown) => c as Parameters<typeof keepLook>[0]
  /** settle call 0 and call 1 in the racing order when both were sent at once, otherwise in turn */
  async function settle2(h: ReturnType<typeof hostHarness>, first: (c: { release(): void; fail(): void }) => void, second: (c: { release(): void; fail(): void }) => void, race: 'second-first' | 'in-turn') {
    const c0 = (await h.call(0))!
    await flush()
    if (h.made() >= 2 && race === 'second-first') {
      second(h.nth(1)!) // both were sent at once (an older build): the stand-in's racing order
      await flush()
      first(c0)
    } else {
      first(c0)
      second((await h.call(1))!)
    }
    await flush()
  }

  it('[#1] Keep A then Keep B, B answering first if it can: host and page both end on B, and B is never sent before A ends', async () => {
    const a = testPerson('q1')
    await signInAs(a)
    bindAs('user:p_inv_q1')
    const h = hostHarness()
    const A = keepLook(asClient(h.client), ember()).catch((e: Error) => e)
    const B = keepLook(asClient(h.client), deep()).catch((e: Error) => e)
    const c0 = (await h.call(0))!
    await flush()
    const sentAtOnce = h.made()
    if (sentAtOnce >= 2) {
      h.nth(1)!.release() // B first, then A (the race)
      await flush()
      c0.release()
    } else {
      c0.release()
      ;(await h.call(1))!.release()
    }
    await A
    await B
    await flush()
    // soft, so a failure reports the host AND the page AND the sending order together
    expect.soft(h.host()?.variant?.id, 'host').toBe('deep-sea') // the host's final value
    expect.soft(lookState().saved?.variant?.id, 'page').toBe('deep-sea') // the page agrees
    expect.soft(sentAtOnce, 'calls sent before A ended').toBe(1) // B waited for A
  })

  it('[#2] Keep A then Keep B; B refused, A accepted: host, page and device copy all end on A (a refused save drops nothing)', async () => {
    const a = testPerson('q2')
    await signInAs(a)
    bindAs('user:p_inv_q2')
    const h = hostHarness()
    const A = keepLook(asClient(h.client), ember()).catch((e: Error) => e)
    const B = keepLook(asClient(h.client), deep()).catch((e: Error) => e)
    await settle2(h, (c) => c.release(), (c) => c.fail(), 'second-first')
    await A
    await B
    await flush()
    expect.soft(h.host()?.variant?.id, 'host').toBe('ember-forge')
    expect.soft(lookState().saved?.variant?.id, 'page').toBe('ember-forge')
    const copies = [...mem.entries()].filter(([k]) => k.startsWith('omegahive.ui.look') && !k.includes('pending') && !k.includes('owner'))
    expect(copies.length).toBeGreaterThan(0)
    for (const [, v] of copies) expect(v).toContain('ember-forge')
  })

  it('[#3] a request Keep, then a gallery Keep that is refused: kept, and saved, base, from and Undo are the request’s look', async () => {
    const a = testPerson('q3')
    await signInAs(a)
    bindAs('user:p_inv_q3')
    const h = hostHarness()
    previewLook(null)
    S.openRequest(true)
    S.tryWords('warmer')
    const mine = S.requestState().previewing!.prefs
    const req = S.keepRequestedOutcome(h.client)
    const gallery = keepLook(asClient(h.client), deep()).catch((e: Error) => e) // pressed in the gallery meanwhile
    await settle2(h, (c) => c.release(), (c) => c.fail(), 'second-first') // the gallery refused first if it could
    const out = await req
    await gallery
    await flush()
    expect(h.host()?.variant?.id).toBe(mine.variant!.id)
    expect(lookState().saved?.variant?.id).toBe(mine.variant!.id)
    expect(S.requestState().from?.variant?.id).toBe(mine.variant!.id)
    expect(S.requestState().base?.variant?.id).toBe(mine.variant!.id)
    expect(out.kind).toBe('kept')
    S.tryWords('calmer')
    S.undoPreview()
    expect((lookState().preview ?? lookState().saved)?.variant?.id).toBe(mine.variant!.id) // Undo shows the kept look
  })

  it('[progress] A refused, then B accepted: the queue moves on (no deadlock), and B is kept on the host and the page', async () => {
    const a = testPerson('q4')
    await signInAs(a)
    bindAs('user:p_inv_q4')
    const h = hostHarness()
    const A = keepLook(asClient(h.client), ember()).catch((e: Error) => e)
    const B = keepLook(asClient(h.client), deep()).catch((e: Error) => e)
    ;(await h.call(0))!.fail()
    expect(await A).toBeInstanceOf(Error)
    ;(await h.call(1))!.release()
    await B
    expect(h.host()?.variant?.id).toBe('deep-sea')
    expect(lookState().saved?.variant?.id).toBe('deep-sea')
  })

  it('[Kimi r1j #2] accepted but NOT on screen (a Reset pressed while it was on its way): said as exactly that, never "kept … on screen"', async () => {
    const a = testPerson('q6')
    await signInAs(a)
    bindAs('user:p_inv_q6')
    const h = hostHarness()
    Object.assign(h.client, { resetUiPrefs: async () => ({ prefs: null, updated_at: 'now' }) })
    previewLook(null)
    S.openRequest(true)
    S.tryWords('darker')
    const mine = S.requestState().previewing!.prefs
    const req = S.keepRequestedOutcome(h.client)
    const reset = resetLook(asClient(h.client)) // the newest choice, shown at once
    expect(lookState().saved).toBeNull()
    ;(await h.call(0))!.release() // the request's save accepted after the reset was already showing
    const out = await req
    await reset
    await flush()
    expect(lookState().saved).toBeNull() // the page shows the newest choice (the reset)
    expect(out).toEqual({ kind: 'kept', shown: false, saved: true })
    expect(S.requestState()).toMatchObject({ kept: mine.variant!.name, keptShown: false })
    expect(S.myLooks().map((l) => l.variant.id)).toContain(mine.variant!.id) // it is in Your looks
    expect(S.requestState().from?.variant?.id).toBe(mine.variant!.id) // tries start from the look the host accepted
  })

  it('[identity] a save still waiting its turn when the person changes is never sent with the next person’s sign-in', async () => {
    const a = testPerson('q5-a')
    const b = testPerson('q5-b', { sameTab: a })
    await signInAs(a)
    bindAs('user:p_inv_q5')
    const h = hostHarness()
    // bound to the identity as every app caller is (shell/lookIdentity installs bindEpoch as the default binder)
    const first = keepLook(asClient(h.client), ember(), bindEpoch().commit).catch((e: Error) => e)
    const waiting = keepLook(asClient(h.client), deep(), bindEpoch().commit).catch((e: Error) => e)
    const sent = (await h.call(0))!
    await flush()
    const sentBeforeSwitch = h.made()
    await switchPerson(a, b)
    sent.release() // A's first save ends after the change
    if (h.made() >= 2) h.nth(1)!.release() // an older build had already sent it; let it end
    await first
    await waiting
    await flush()
    expect(sentBeforeSwitch).toBe(1) // the waiting one had not been sent
    expect(h.made()).toBe(1) // and was never sent with the next person's sign-in
  })
})

/** Kimi's minor items on r1i+r1j (SHIP on rerun), folded into r1k. The same harness: real stores, held host answers. */
describe('Kimi r1i/r1j minor items', () => {
  const ember = () => ({ variant: SEED_VARIANTS.find((v) => v.id === 'ember-forge')!, layout: null, apps: null, experience: null })
  const asClient = (c: unknown) => c as Parameters<typeof keepLook>[0]
  const copy = () => {
    const copies = [...mem.entries()].filter(([k]) => k.startsWith('omegahive.ui.look') && !k.includes('pending') && !k.includes('owner'))
    return copies.length ? copies.map(([, v]) => v).join('|') : null
  }
  const pending = () => [...mem.entries()].filter(([k, v]) => k.startsWith('omegahive.ui.look.pending') && v === '1').length

  it('[#1] a Keep that completes AFTER a newer Reset is showing: the device copy and the pending flag follow the reset, then the reset’s answer clears its flag', async () => {
    const a = testPerson('m1')
    await signInAs(a)
    bindAs('user:p_inv_m1')
    const h = hostHarness()
    let answerReset: () => void = () => undefined
    Object.assign(h.client, { resetUiPrefs: () => new Promise((r) => (answerReset = () => r({ prefs: null, updated_at: 'now' }))) })
    const keep = keepLook(asClient(h.client), ember())
    const reset = resetLook(asClient(h.client)) // the newest choice, shown at once: no copy, a pending flag
    expect(lookState().saved).toBeNull()
    expect(copy()).toBeNull()
    expect(pending()).toBe(1)
    ;(await h.call(0))!.release() // the older Keep is accepted now, after the reset is showing
    const kept = await keep
    expect(lookState().saved).toBeNull() // the page keeps the newest choice
    expect(copy()).toBeNull() // the device copy is not overwritten by the older Keep
    expect(pending()).toBe(1) // the reset has not been answered yet: its flag stays
    expect(kept?.outcome).toBe('accepted-not-shown')
    await flush()
    answerReset()
    await reset
    await flush()
    expect(pending()).toBe(0) // the reset's own answer clears its flag
    expect(lookState().saved).toBeNull()
  })

  it('[#2] a superseded request Keep that SUCCEEDS late: B untouched, A’s look in Your looks, the page on the last accepted save', async () => {
    const a = testPerson('m2')
    await signInAs(a)
    bindAs('user:p_inv_m2')
    const h = hostHarness()
    S.openRequest(true)
    S.tryWords('calmer')
    const aLook = S.requestState().previewing!.prefs
    const keepA = S.keepRequestedOutcome(h.client)
    S.openRequest(false)
    S.openRequest(true)
    S.tryWords('warmer')
    const bReq = S.requestState()
    const keepB = S.keepRequestedOutcome(h.client)
    ;(await h.call(0))!.release() // A's success lands
    expect(await keepA).toEqual({ kind: 'superseded' })
    await flush()
    expect(S.requestState().id).toBe(bReq.id) // B's request untouched
    expect(S.requestState()).toMatchObject({ busy: true, error: null, kept: null })
    expect(S.requestState().previewing).toBe(bReq.previewing)
    expect(S.myLooks().map((l) => l.variant.id)).toContain(aLook.variant!.id) // A's look is the person's
    expect(lookState().saved?.variant?.id).toBe(aLook.variant!.id) // the page: the last accepted save (A)
    expect(h.host()?.variant?.id).toBe(aLook.variant!.id)
    ;(await h.call(1))!.release()
    expect(await keepB).toEqual({ kind: 'kept', shown: true, saved: true })
    expect(lookState().saved?.variant?.id).toBe(h.host()?.variant?.id) // host and page end on B together
  })

  it('[#3] A→B: B never sees A’s busy flag, result or error, while A’s save is held and when it lands', async () => {
    const a = testPerson('m3-a')
    const b = testPerson('m3-b', { sameTab: a })
    await signInAs(a)
    bindAs('user:p_inv_m3_a')
    const h = hostHarness()
    S.openRequest(true)
    S.tryWords('darker')
    const keepA = S.keepRequestedOutcome(h.client)
    expect(S.requestState().busy).toBe(true)
    const sent = (await h.call(0))!
    await switchPerson(a, b)
    bindAs('user:p_inv_m3_b')
    expect(S.requestState()).toMatchObject({ open: false, busy: false, error: null, kept: null, result: null, previewing: null })
    S.openRequest(true)
    expect(S.requestState().busy).toBe(false) // B can use the panel at once
    sent.fail() // A's save is refused now, under B
    expect(await keepA).toEqual({ kind: 'superseded' })
    await flush()
    expect(S.requestState()).toMatchObject({ open: true, busy: false, error: null, kept: null })
    expect(S.myLooks()).toEqual([])
  })

  it('[#3] A→B→A: back as A, the request starts fresh; A’s old Keep never shows its busy flag, result or error', async () => {
    const a = testPerson('m4-a')
    const b = testPerson('m4-b', { sameTab: a })
    const a2 = testPerson('m4-a', { sameTab: a }) // A again, on the same tab
    await signInAs(a)
    bindAs('user:p_inv_m4_a')
    const h = hostHarness()
    S.openRequest(true)
    S.tryWords('warmer')
    const keepA = S.keepRequestedOutcome(h.client)
    const sent = (await h.call(0))!
    await switchPerson(a, b)
    bindAs('user:p_inv_m4_b')
    await switchPerson(b, a2)
    bindAs('user:p_inv_m4_a')
    expect(S.requestState()).toMatchObject({ open: false, busy: false, error: null, kept: null, previewing: null })
    S.openRequest(true)
    sent.release() // the old Keep (from A's first sign-in) lands now
    expect(await keepA).toEqual({ kind: 'superseded' })
    await flush()
    expect(S.requestState()).toMatchObject({ open: true, busy: false, error: null, kept: null })
  })
})
