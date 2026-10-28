/**
 * The Ask's voice, for any skin: wraps the framework-free AskVoice controller (voice.ts) around one Ask field. The
 * spoken words go into the field (editable, interim words included) and leave only through the field's own submit,
 * exactly as typed words do: the fast path, a request, or a steer while the mind works.
 *
 * Stops on: a second tap, the release of a hold, Esc, Enter (the words are sent as typed), focus or a press leaving
 * the Ask, the window losing focus, the page being hidden, and unmount. A sign-in change drops it at once and empties
 * the field (the earlier person's words are not kept). Nothing is recorded or stored; only two choices are kept in
 * this browser, per person: the opt-in to the browser's speech service, and send-on-pause.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type RefObject } from 'react'
import { useAskStore } from '../../store/ask'
import { guardComposing } from './keys'
import { AskVoice, HOLD_MS, unsupportedWords, voiceSupport, type VoiceLayer, type VoiceState } from './voice'

/** a consent notice carries the sign-in it was shown under (the Ask epoch): a press on it after a change does nothing */
export type VoiceNotice =
  | { kind: 'consent'; vendor: string; epoch: number }
  /** an error; `retry` when pressing Try again can help (a blocked or missing microphone the person may now allow) */
  | { kind: 'say'; text: string; retry?: boolean }
  /** a one-time word about the microphone (Kimi 1), gone with the first words heard */
  | { kind: 'info'; text: string }
  | null

/** shown once in this browser, the first time it listens on this device */
const MIC_TOLD = 'omegahive.ask.voice.mic-told.v1'
export const MIC_ON_DEVICE_WORDS = 'Your browser may ask to use the microphone. On this device the words are made here; nothing is sent anywhere, and the hive gets only the words you choose to send.'

/** The field this drives: the parts of useAskField voice needs. */
export interface VoiceField {
  voiceText(v: string): void
  valueNow(): string
  submit(ev?: { repeat?: boolean; quiet?: boolean }): unknown
}

const KEY = 'omegahive.ask.voice.v1'
/**
 * A person's choices. The opt-in names the maker whose service hears the voice (Kimi 6): consenting to Google's service
 * does not cover Apple's or Microsoft's. An older stored `service: true` named no maker and is not read as consent.
 */
type Choices = { services?: Record<string, true>; pause?: boolean }
/**
 * An unknown person's choices last only for this page AND this sign-in (the Ask epoch): the slot is
 * `unknown#<epoch>`, so another person in the same browser never inherits them, even unidentified (Platform 2026-10-06).
 */
const memory: Record<string, Choices> = {}
const UNKNOWN = 'unknown#'
/**
 * This page's own nonce (Kimi r3 #4): an unknown person's slot is `unknown#<nonce>:<epoch>`, so a recurring epoch number
 * (a store re-created by HMR or an error boundary) never reaches another page-life's slot; and every unknown slot is
 * cleared when the sign-in changes or the bound person becomes nobody (voiceFollowsSignIn).
 */
const PAGE = Math.random().toString(36).slice(2, 10)
const unknownSlot = (epoch: number) => `${UNKNOWN}${PAGE}:${epoch}`
function clearUnknown() {
  for (const k of Object.keys(memory)) if (pageOnly(k)) delete memory[k]
}
const pageOnly = (who: string) => who.startsWith(UNKNOWN)
function readChoices(who: string | null): Choices {
  if (!who) return {}
  if (pageOnly(who)) return memory[who] ?? {}
  try {
    const all = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '{}') as Record<string, Choices>
    const c = all[who]
    if (!c || typeof c !== 'object') return {}
    const services: Record<string, true> = {}
    if (c.services && typeof c.services === 'object') for (const [k, v] of Object.entries(c.services)) if (v === true) services[k] = true
    return { services, pause: c.pause === true }
  } catch {
    return {}
  }
}
function writeChoices(who: string | null, c: Choices) {
  if (!who) return
  if (pageOnly(who)) {
    memory[who] = c
    return
  }
  try {
    const all = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '{}') as Record<string, Choices>
    all[who] = c
    globalThis.localStorage?.setItem(KEY, JSON.stringify(all))
  } catch {
    memory[who] = c
  }
}
const consentedTo = (c: Choices, vendor: string) => c.services?.[vendor] === true
const withConsent = (c: Choices, vendor: string): Choices => ({ ...c, services: { ...c.services, [vendor]: true } })
export const voiceChoices = { read: readChoices, write: writeChoices, key: KEY, consentedTo, withConsent }

/**
 * A sign-in or session change (the Ask thread's epoch moves on every reset, identity or credential change) drops the
 * voice at once, inside the change: nothing heard afterwards writes, and the earlier person's words leave the field.
 *
 * The field's draft leaves too, spoken or typed, whether or not the microphone is on (stand-in r4 P1 #1): `clearField`
 * empties it inside the change. The one exception is the page learning who is signed in for the FIRST time (nobody
 * was bound yet on this page): what was typed meanwhile was typed by the person now named, and is kept.
 */
export function voiceFollowsSignIn(ctl: AskVoice, onDrop: () => void, clearField?: () => void): () => void {
  let epoch = useAskStore.getState().epoch
  let bound = !!useAskStore.getState().bound
  let everBound = bound
  return useAskStore.subscribe((s) => {
    const nobody = bound && !s.bound
    bound = !!s.bound
    const known = everBound
    if (bound) everBound = true
    if (s.epoch === epoch && !nobody) return
    epoch = s.epoch
    // an unknown person's choices never outlive their sign-in
    clearUnknown()
    if (ctl.active) ctl.abort({ clear: known })
    if (known) clearField?.()
    onDrop()
  })
}

/**
 * Whose choices apply NOW, read from the store at the moment of use (never from a ref refreshed by a React effect, which
 * lags a synchronous sign-in change: Review B1, c81986a). The Ask epoch moves on every reset, bind, session or credential
 * change, so it is the sign-in generation; an unknown person gets a page-only slot for that generation.
 */
export function voiceWhoNow(): { key: string; epoch: number } {
  const s = useAskStore.getState()
  return { key: s.bound?.principal ?? unknownSlot(s.epoch), epoch: s.epoch }
}

const pageLang = () => (typeof navigator !== 'undefined' && navigator.language) || document.documentElement.lang || 'en-US'
const modalOpen = () => !!document.querySelector('[aria-modal="true"]:not([data-ask-own])')

export function useAskVoice(f: VoiceField, inputRef: RefObject<HTMLInputElement | null>, rootRef: RefObject<HTMLElement | null>) {
  const principal = useAskStore((s) => s.bound?.principal ?? null)
  const epoch = useAskStore((s) => s.epoch)
  // where this person's choices live: their own key, or a page-only slot for this sign-in when they are not known
  const who = principal ?? unknownSlot(epoch)
  const [support] = useState(() => voiceSupport())
  const [st, setSt] = useState<{ state: VoiceState; layer: VoiceLayer | null }>({ state: 'idle', layer: null })
  const [notice, setNotice] = useState<VoiceNotice>(null)
  const [announced, setAnnounced] = useState('')
  const [seconds, setSeconds] = useState(0)
  // this person's two choices; another person signed in reads theirs
  // read on every render from where they live (never a copy that could outlive a cleared slot: Kimi r3 #4); a write
  // bumps this to draw the change
  const [, setDrawn] = useState(0)
  const choices = readChoices(who)
  const [sendTick, setSendTick] = useState(0)
  const fRef = useRef(f)
  const ctlRef = useRef<AskVoice | null>(null)
  const pressed = useRef<{ at: number; wasActive: boolean } | null>(null)
  /** the pointer of the last press on the mic: touch and pen start on the tap itself (click), a mouse on press */
  const pointer = useRef<string>('')
  /** the press before this click already acted (stopped, or a mouse start): the click must not toggle again */
  const handled = useRef(false)
  /** the page's microphone permission status, when the browser reports one */
  const mic = useRef<PermissionStatus | null>(null)
  /** a send queued for after React draws the last words: the sign-in generation it was queued under */
  const queued = useRef<number | null>(null)

  useEffect(() => {
    fRef.current = f
  })

  useEffect(() => {
    const ctl = new AskVoice({
        support,
        lang: pageLang(),
        getText: () => fRef.current.valueNow(),
        setText: (v) => {
          fRef.current.voiceText(v)
          if (v) setNotice((n) => (n?.kind === 'info' ? null : n))
        },
        // sent after React has drawn the last words, so the field's own submit sees exactly them; only under the same sign-in
        send: () => {
          queued.current = voiceWhoNow().epoch
          setSendTick((n) => n + 1)
        },
        // read at the moment of use, for whoever is signed in now
        autoSend: () => readChoices(voiceWhoNow().key).pause === true,
        consented: () => support.ok && consentedTo(readChoices(voiceWhoNow().key), support.vendor),
        generation: () => {
          const at = voiceWhoNow().epoch
          return () => voiceWhoNow().epoch === at
        },
        onState: (state, layer) => {
          setSt({ state, layer })
          if (state === 'listening') setSeconds(0)
        },
        announce: setAnnounced,
        say: (text, code) => setNotice(text ? { kind: 'say', text, retry: code === 'not-allowed' || code === 'audio-capture' || undefined } : null),
        micDenied: () => mic.current?.state === 'denied',
      })
    ctlRef.current = ctl
    void ctl.probe()
    // the microphone permission, where the browser reports it (Kimi 3): denied at start says so without starting;
    // revoked while listening stops at once. A browser that cannot answer the question is simply not consulted.
    let live = true
    const perms = (globalThis.navigator as Navigator | undefined)?.permissions
    void perms
      ?.query({ name: 'microphone' as PermissionName })
      .then((status) => {
        if (!live) return
        mic.current = status
        status.onchange = () => {
          if (status.state === 'denied') ctl.micRevoked()
        }
      })
      .catch(() => undefined)
    // a language pack may arrive after load: ask again when the language changes
    const onLang = () => ctl.reprobe()
    globalThis.addEventListener?.('languagechange', onLang)
    const off = voiceFollowsSignIn(
      ctl,
      () => {
        queued.current = null
        setNotice(null)
      },
      // the earlier person's draft, spoken or typed, leaves the field inside the change (stand-in r4 P1 #1)
      () => fRef.current.voiceText(''),
    )
    return () => {
      live = false
      if (mic.current) mic.current.onchange = null
      mic.current = null
      globalThis.removeEventListener?.('languagechange', onLang)
      off()
      ctl.abort()
      if (ctlRef.current === ctl) ctlRef.current = null
    }
  }, [support])

  useEffect(() => {
    const at = queued.current
    queued.current = null
    // an automatic send runs only if it is still this sign-in AND the person still wants automatic sends (Review r2)
    const now = voiceWhoNow()
    if (sendTick && at !== null && at === now.epoch && readChoices(now.key).pause === true) void fRef.current.submit({ quiet: true })
  }, [sendTick])

  const listening = st.state === 'listening' || st.state === 'stopping'
  useEffect(() => {
    if (st.state !== 'listening') return
    const t = setInterval(() => setSeconds((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [st.state])

  // stop when attention leaves: hidden page, window blur, focus or a press outside the Ask
  useEffect(() => {
    if (st.state === 'idle') return
    const stop = () => ctlRef.current?.stop()
    const onVis = () => document.visibilityState === 'hidden' && stop()
    const onOut = (e: FocusEvent) => {
      const to = e.relatedTarget as Node | null
      if (to && rootRef.current && !rootRef.current.contains(to)) stop()
    }
    const onPress = (e: Event) => {
      const t = e.target as Node | null
      if (t && rootRef.current && !rootRef.current.contains(t)) stop()
    }
    const root = rootRef.current
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('blur', stop)
    window.addEventListener('pointerdown', onPress, true)
    root?.addEventListener('focusout', onOut)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('blur', stop)
      window.removeEventListener('pointerdown', onPress, true)
      root?.removeEventListener('focusout', onOut)
    }
  }, [st.state, rootRef])

  const start = useCallback(async () => {
    if (!support.ok) {
      setNotice({ kind: 'say', text: unsupportedWords(support.why) })
      return
    }
    const at = voiceWhoNow().epoch
    const ctl = ctlRef.current
    const r = await ctl?.start()
    if (r === 'needs-consent' && voiceWhoNow().epoch === at) setNotice({ kind: 'consent', vendor: support.vendor, epoch: at })
    // the first time this browser listens on this device: say the microphone is in use and nothing leaves (Kimi 1)
    if (r === 'started' && ctl?.layer === 'on-device') {
      try {
        if (!globalThis.localStorage?.getItem(MIC_TOLD)) {
          globalThis.localStorage?.setItem(MIC_TOLD, '1')
          setNotice({ kind: 'info', text: MIC_ON_DEVICE_WORDS })
        }
      } catch {
        // storage refused: say nothing extra; the listening line still names the layer
      }
    }
  }, [support])

  const toggle = useCallback(() => {
    const ctl = ctlRef.current
    if (ctl?.active) ctl.stop()
    else void start()
  }, [start])

  // ⌘/Ctrl+Shift+Space: talk or stop, from anywhere this Ask is on screen (not under a modal)
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.code === 'Space' || e.key === ' ') || !e.shiftKey || !(e.metaKey || e.ctrlKey) || e.altKey) return
      const input = inputRef.current
      if (!input?.isConnected || input.closest('[inert]') || modalOpen()) return
      e.preventDefault()
      e.stopImmediatePropagation()
      input.focus()
      toggle()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [inputRef, toggle])

  // the toggle drawn for this sign-in: a press after a change (an old render's handler) writes nothing
  const setPause = useCallback(
    (on: boolean) => {
      const now = voiceWhoNow()
      if (now.epoch !== epoch) return
      const c = { ...readChoices(now.key), pause: on }
      setDrawn((n) => n + 1)
      writeChoices(now.key, c)
      // the controller hears it at once: off withdraws a pending automatic send (Review r2)
      ctlRef.current?.autoSendChanged(on)
    },
    [epoch],
  )

  /** The person chose the browser's speech service (this press is their gesture: listening starts now). */
  const consent = useCallback(() => {
    const now = voiceWhoNow()
    // the notice was shown to the person signed in then: after any change it authorises nothing
    if (notice?.kind !== 'consent' || notice.epoch !== now.epoch) {
      setNotice(null)
      return
    }
    // the notice named this maker; the consent is to it alone
    const c = withConsent(readChoices(now.key), notice.vendor)
    setDrawn((n) => n + 1)
    writeChoices(now.key, c)
    setNotice(null)
    void start()
  }, [notice, start])

  /**
   * The mic's own handlers. A tap (click) toggles on every pointer: WebKit honours a click as the gesture that may start
   * speech, not a pointerdown (Kimi 4). With a mouse, the press itself starts listening and a press held past HOLD_MS is
   * hold-to-talk (release stops); on touch and pen there is no hold-to-talk.
   */
  const button = {
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      pointer.current = e.pointerType
      handled.current = false
      if (e.button !== 0 || !support.ok) return
      const ctl = ctlRef.current
      // stopping never waits for a click, on any pointer (Kimi r3 #2): a click swallowed by a re-render must not leave
      // the browser listening. The click that follows this press is then a no-op.
      if (ctl?.active) {
        handled.current = true
        pressed.current = null
        ctl.stop()
        return
      }
      // starting: a mouse starts on the press (hold-to-talk); touch and pen start on the tap's click (Kimi 4)
      if (e.pointerType !== 'mouse') return
      handled.current = true
      pressed.current = { at: performance.now(), wasActive: false }
      void start()
      inputRef.current?.focus({ preventScroll: true })
    },
    onPointerUp: () => {
      const p = pressed.current
      pressed.current = null
      if (p && !p.wasActive && performance.now() - p.at >= HOLD_MS) ctlRef.current?.stop()
    },
    onPointerCancel: () => {
      const p = pressed.current
      pressed.current = null
      if (p && !p.wasActive) ctlRef.current?.stop()
    },
    // keep the caret in the field (a press on the mic is not leaving the Ask)
    onMouseDown: (e: MouseEvent) => e.preventDefault(),
    onContextMenu: (e: MouseEvent) => e.preventDefault(),
    onClick: (e: MouseEvent<HTMLButtonElement>) => {
      // a keyboard press (Enter/Space, detail 0) always toggles; a click whose press already acted (any stop, a mouse
      // start) does nothing; otherwise (a tap on touch or pen) it toggles; an unsupported mic explains itself
      const acted = handled.current
      handled.current = false
      pointer.current = ''
      if (e.detail === 0) toggle()
      else if (!acted) toggle()
    },
    'aria-pressed': listening,
    'aria-disabled': !support.ok || undefined,
    'aria-keyshortcuts': 'Control+Shift+Space Meta+Shift+Space',
  }

  /** The field's keys first: Esc stops listening (or closes a voice notice); Enter stops it and sends as typed. */
  const onFieldKey = useCallback(
    (e: KeyboardEvent<HTMLInputElement>): boolean => {
      // an IME's confirming key is the input method's: it neither stops listening nor sends (keys.ts)
      if (guardComposing(e)) return true
      const ctl = ctlRef.current
      if (e.key === 'Escape' && (ctl?.active || notice)) {
        e.preventDefault()
        if (ctl?.active) ctl.stop()
        else setNotice(null)
        return true
      }
      if (e.key === 'Enter' && ctl?.active) ctl.abort()
      return false
    },
    [notice],
  )

  const label = !support.ok ? 'Talk (not available in this browser)' : listening ? 'Stop listening' : 'Talk: tap to start and stop'
  // the microphone is named as in use whichever layer hears it (Kimi 1)
  const layerWords = st.layer === 'on-device' ? 'on this device' : st.layer === 'service' && support.ok ? `sent to ${support.vendor}` : ''
  return {
    support,
    state: st.state,
    layer: st.layer,
    listening,
    layerWords,
    /** the microphone is in use (any layer): the listening line says "Mic on" */
    micOn: st.layer !== null,
    elapsed: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
    notice,
    dismiss: () => setNotice(null),
    /** Try again after a blocked or missing microphone: this press is the gesture the browser may prompt from */
    retry: () => {
      setNotice(null)
      void start()
    },
    consent,
    announced,
    autoSend: choices.pause === true,
    setAutoSend: setPause,
    toggle,
    stop: () => ctlRef.current?.stop(),
    button,
    label,
    onFieldKey,
  }
}

export type AskVoiceUI = ReturnType<typeof useAskVoice>
