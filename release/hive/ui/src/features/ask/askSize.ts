// Purpose: the Ask's size for the person (collapsed, bubble or half, kept in their look settings on the hive), shown on
// the page the moment they change it, and the changes every look's controls make. Where each size goes is the Ask's
// screen, which MeTTa composes (screens/ask.metta, askScreen.ts).
import { useSyncExternalStore } from 'react'
import { bindEpoch, onIdentityChange, type EpochBinding } from '../../lib/identityEpoch'
import { isTimedOut, keepLook, lookState, subscribeLook, type AskSize, type UiPrefs } from '../../shell/uiVariant'
import { useHive } from '../../store/store'
import type { AskMode } from './placement'
import { SIZE_WORDS } from './words'

/** The person's Ask size in their saved look settings: absent means the bubble. */
export const askSizeOf = (p: UiPrefs | null | undefined): AskSize => p?.ask_size ?? 'bubble'

/**
 * The page's own copy of the person's latest choice, shown until the hive's answer to its write settles: keepLook shows
 * a kept look only once the hive accepts it (shell/uiVariant keepLook), which on a tester's remote hive is a visible
 * wait after a press. `seq` is the write that choice issued; only the answer to the last write issued clears it.
 */
let chosen: { size: AskSize; seq: number } | null = null
let issued = 0
/** The size the Ask was collapsed from, which the mark and the summon key open it at again (the bubble after a reload). */
let reopen: Exclude<AskSize, 'collapsed'> = 'bubble'
/** The field takes the cursor once it is drawn: the person opened the Ask from its mark or with the summon key. */
let focusWanted = false
const subs = new Set<() => void>()
const notify = () => subs.forEach((f) => f())

onIdentityChange(() => {
  chosen = null
  reopen = 'bubble'
  focusWanted = false
  notify()
})

/** The size on screen: the person's choice on this page while its write is on its way, else their saved one. */
export const askSizeNow = (): AskSize => chosen?.size ?? askSizeOf(lookState().saved)

function subscribe(cb: () => void): () => void {
  subs.add(cb)
  const off = subscribeLook(cb)
  return () => {
    subs.delete(cb)
    off()
  }
}

/** The Ask's size on screen, redrawn when the person changes it here or their saved look changes. */
export const useAskSize = (): AskSize => useSyncExternalStore(subscribe, askSizeNow, askSizeNow)

/**
 * The person sets the Ask's size: shown at once, then written to their look settings, bound to the principal who set
 * it (a save that lands after a sign-in change writes nothing on this page and answers 'stale'). A hive that cannot
 * store a look keeps the choice on this page ('no-host'). A refused write takes the size back to the saved one and
 * throws, unless a later choice was made meanwhile ('superseded'), whose own answer then decides. A write the hive is
 * slower to answer than keepLook waits is still open ('pending'): the choice stays shown and nothing is said, and the
 * hive's late answer settles it as keepLook reconciles it, kept, or the hive's own look adopted with its notice. A late
 * answer that fails without saying what the hive holds changes nothing kept, so the choice stays on this page until a
 * reload shows the kept size.
 */
export async function setAskSize(client: Parameters<typeof keepLook>[0], to: AskSize, binding: EpochBinding = bindEpoch()): Promise<'saved' | 'same' | 'stale' | 'no-host' | 'superseded' | 'pending'> {
  const from = askSizeNow()
  if (from === to) return 'same'
  if (from !== 'collapsed') reopen = from
  const seq = ++issued
  chosen = { size: to, seq }
  notify()
  if (!client?.setUiPrefs) return 'no-host'
  const base: UiPrefs = lookState().saved ?? { variant: null, layout: null, apps: null, experience: null }
  const settle = () => {
    if (chosen?.seq !== seq) return false
    chosen = null
    notify()
    return true
  }
  try {
    await keepLook(client, { ...base, ask_size: to }, binding.commit)
  } catch (e) {
    if (!binding.current()) return 'stale'
    if (isTimedOut(e)) {
      settleOnLateAnswer(seq)
      return 'pending'
    }
    if (!settle()) return 'superseded'
    throw e
  }
  if (!binding.current()) return 'stale'
  return settle() ? 'saved' : 'superseded'
}

/**
 * The choice of write `seq` stays shown until the kept look next changes, which is the hive's late answer reconciled
 * (keepLook's casSave: kept, or the hive's own look adopted, which says so), unless a later choice replaced it first.
 */
function settleOnLateAnswer(seq: number): void {
  const before = lookState().saved
  const off = subscribeLook(() => {
    if (lookState().saved === before) return
    off()
    if (chosen?.seq !== seq) return
    chosen = null
    notify()
  })
}

/** Open a collapsed Ask at the size it was collapsed from, the cursor going to its field once it is drawn. */
export function openAsk(client: Parameters<typeof keepLook>[0], binding: EpochBinding = bindEpoch()): ReturnType<typeof setAskSize> {
  focusWanted = true
  return setAskSize(client, reopen, binding)
}

/** Whether the field should take the cursor now that the Ask is drawn open; answers true once per opening. */
export function takeFocusWanted(): boolean {
  const w = focusWanted
  focusWanted = false
  return w
}

/**
 * Change the Ask's size, or open a collapsed one ('open'), for the person on this page: shown at once, kept on their
 * hive (askSize.setAskSize). When the hive refuses it, the size goes back and a toast says so.
 */
export function changeAskSize(to: AskSize | 'open'): void {
  const client = useHive.getState().client
  void (to === 'open' ? openAsk(client) : setAskSize(client, to)).catch((e: unknown) =>
    useHive.getState().toast({ tone: 'error', title: SIZE_WORDS.refused, body: e instanceof Error ? e.message : String(e), group: 'ask-size' }),
  )
}

/** The switch between the bubble and the half size for this mode: what pressing it does, in words. */
export function halfSwitch(size: AskSize, mode: AskMode): { to: AskSize; text: string; label: string } {
  const words = mode === 'phone' ? (size === 'half' ? SIZE_WORDS.short : SIZE_WORDS.tall) : size === 'half' ? SIZE_WORDS.bubble : SIZE_WORDS.half
  return { to: size === 'half' ? 'bubble' : 'half', ...words }
}
