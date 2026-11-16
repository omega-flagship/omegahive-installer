// Purpose: verify the Ask's three sizes: that an absent setting is the bubble, that a whole-preference write keeps the
// person's size as it keeps their landing, and that a change shows at once, is kept on the hive, goes back with a word
// when the hive refuses it, and stays shown while a slow hive's answer is late. Where each size goes is the Ask's
// screen (askScreen.test.ts).
import { describe, expect, it, vi } from 'vitest'

// INVENTED data, no network: a page's window as the look settings read it
vi.stubGlobal('window', { location: { hash: '#/', search: '', pathname: '/' }, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } })
const { useHive } = await import('../../store/store')
const { askSizeNow, askSizeOf, openAsk, setAskSize, takeFocusWanted } = await import('./askSize')
const { carryOwn, lookState } = await import('../../shell/uiVariant')
type UiPrefs = import('../../shell/uiVariant').UiPrefs

const base: UiPrefs = { variant: null, layout: null, apps: null, experience: null }

/** A hive that keeps each look it is sent once the test releases its answer, or refuses it. */
function hive() {
  const pending: { prefs: UiPrefs; ok: () => void; no: (e: Error) => void }[] = []
  let rev = 0
  const client = {
    setUiPrefs: (prefs: UiPrefs) => new Promise((resolve, reject) => {
      pending.push({ prefs, ok: () => resolve({ prefs, rev: ++rev }), no: reject })
    }),
  }
  return { client: client as never, pending }
}
/** keepLook sends on its turn in its one ordered queue, a tick after the press: wait until the hive has `n` writes. */
const sent = (h: ReturnType<typeof hive>, n: number) => vi.waitFor(() => expect(h.pending.length).toBe(n))

describe('the Ask’s size (Jon, 16 Nov: collapsed to the Omega, the centre bubble, or the left half)', () => {
  it('absent is the bubble; a whole-preference write keeps the person’s size unless it sets one', () => {
    expect(askSizeOf(null)).toBe('bubble')
    expect(askSizeOf({ ...base, ask_size: 'half' })).toBe('half')
    const mine: UiPrefs = { ...base, landing: 'pro', ask_size: 'collapsed' }
    expect(carryOwn({ ...base, layout: 'rail' }, mine)).toMatchObject({ layout: 'rail', landing: 'pro', ask_size: 'collapsed' })
    expect(carryOwn({ ...base, ask_size: 'half' }, mine).ask_size).toBe('half')
  })

  it('a change shows at once, before the hive answers, and stays once the hive keeps it', async () => {
    const h = hive()
    const p = setAskSize(h.client, 'half')
    expect(askSizeNow()).toBe('half')
    await sent(h, 1)
    expect(h.pending[0].prefs.ask_size).toBe('half')
    h.pending[0].ok()
    expect(await p).toBe('saved')
    expect(lookState().saved?.ask_size).toBe('half')
    expect(askSizeNow()).toBe('half')
    expect(await setAskSize(h.client, 'half')).toBe('same')
  })

  it('a refused write goes back to the kept size and says why; a later choice is never undone by an earlier answer', async () => {
    const h = hive()
    const refused = setAskSize(h.client, 'collapsed')
    expect(askSizeNow()).toBe('collapsed')
    await sent(h, 1)
    h.pending[0].no(new Error('This hive is read-only'))
    await expect(refused).rejects.toThrow('This hive is read-only')
    expect(askSizeNow()).toBe('half')
    // two presses before the hive answers: the first answer leaves the second choice on screen
    const first = setAskSize(h.client, 'bubble')
    const second = setAskSize(h.client, 'collapsed')
    expect(askSizeNow()).toBe('collapsed')
    await sent(h, 2)
    h.pending[1].ok()
    expect(await first).toBe('superseded')
    expect(askSizeNow()).toBe('collapsed')
    await sent(h, 3)
    h.pending[2].ok()
    expect(await second).toBe('saved')
    expect(askSizeNow()).toBe('collapsed')
  })

  it('a write the hive answers after keepLook stops waiting stays shown and is never told as refused; the late answer settles it', async () => {
    // a loaded gate hive kept the half size after keepLook's 20 s, and the page had already said "didn't keep it"
    vi.useFakeTimers()
    try {
      const h = hive()
      const kept = askSizeNow()
      // never the half size: the next test starts by choosing it, and the size is the page's one state
      const to = kept === 'bubble' ? 'collapsed' : 'bubble'
      const p = setAskSize(h.client, to)
      await sent(h, 1)
      await vi.advanceTimersByTimeAsync(21_000)
      expect(await p).toBe('pending')
      expect(askSizeNow()).toBe(to)
      expect(lookState().saved?.ask_size ?? 'bubble').toBe(kept)
      // the hive's answer arrives late: keepLook reconciles it, and the kept size is the person's choice
      h.pending[0].ok()
      await vi.waitFor(() => expect(lookState().saved?.ask_size).toBe(to))
      expect(askSizeNow()).toBe(to)
    } finally {
      vi.useRealTimers()
    }
  })

  it('opened from its mark, the Ask comes back at the size it was collapsed from, and its field takes the cursor once', async () => {
    const h = hive()
    const toHalf = setAskSize(h.client, 'half')
    await sent(h, 1)
    h.pending[0].ok()
    await toHalf
    const collapse = setAskSize(h.client, 'collapsed')
    await sent(h, 2)
    h.pending[1].ok()
    await collapse
    expect(takeFocusWanted()).toBe(false)
    const open = openAsk(h.client)
    expect(askSizeNow()).toBe('half')
    expect(takeFocusWanted()).toBe(true)
    expect(takeFocusWanted()).toBe(false)
    await sent(h, 3)
    h.pending[2].ok()
    expect(await open).toBe('saved')
  })

  it('a hive that cannot store a look keeps the size on this page; a sign-in change forgets it', async () => {
    expect(await setAskSize(null, 'bubble')).toBe('no-host')
    expect(askSizeNow()).toBe('bubble')
    // someone else signs in: this page's choice and the size to reopen at are theirs no longer
    useHive.setState({ inits: useHive.getState().inits + 1 })
    expect(askSizeNow()).toBe(askSizeOf(lookState().saved))
  })
})
