/**
 * The floating Ask. Classic's look: a lavender glass capsule floating bottom-centre, faint constellation points drifting
 * in its rim; it widens when active, an aurora line traces the rim while the orchestrator answers. The thread rises
 * above it on desktop (or pins beside the page), is a bottom sheet on a phone and a right-half side sheet in landscape.
 * The same component draws the other experiences' floating looks (skins.ts): Cosmos's transmission console, Flux's
 * liquid capsule, Construct's terminal line and Canvas's note card; only words, marks and CSS differ.
 * Behaviour is the shared headless hook (useAskField); this file is only the look and the placement.
 */
import { AnimatePresence, m } from 'framer-motion'
import { useEffect, useId, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { guardComposing } from './keys'
import { useReducedMotion } from '../../lib/hooks'
import { useAskStore } from '../../store/ask'
import { useModalContainment } from '../../ui/useModalContainment'
import type { Placement } from './placement'
import { Thread, ThreadHead } from './Thread'
import { keepFieldFocus, useAskField, useFocusWithin, useSeen } from './useAskField'
import { useAskVoice } from './useAskVoice'
import { MicIcon, VoiceAnnouncer, VoiceListening, VoiceNoticeView } from './VoiceParts'
import { money, shownMind } from './words'
import type { Candidate } from '../../lib/intent'
import { useAskBridge } from './bridge'
import { SKIN_WORDS, type FloatingLook } from './skins'
import { navigate } from '../../lib/router'
import { AnswererChipButton, AnswererPicker } from './AnswererPicker'
import { holdPopFlag, MIND_PANEL_BODY, POP_ROOM_VAR, popRoom, usePopDismiss } from './popDismiss'

const parts = (c: Candidate) =>
  c.parts.map((p, j) =>
    p.em ? (
      <em key={j}>{p.t}</em>
    ) : p.q ? (
      <q key={j}>{p.t}</q>
    ) : p.who ? (
      <span key={j} className="ask-sug-who">
        {p.t}
      </span>
    ) : (
      <span key={j}>{p.t}</span>
    ),
  )
const sentence = (c: Candidate) => c.parts.map((p) => p.t).join('')

type SheetHeight = 'peek' | 'half' | 'full'

/** Classic's capsule. */
export function ClassicAsk(p: { place: Placement; experience: string; inputRef: RefObject<HTMLInputElement | null>; displayedOriginCurrent?: () => boolean }) {
  return <FloatingAsk {...p} look="capsule" />
}

/** The mark at the field's start, in each look's own grammar. */
function Mark({ look }: { look: FloatingLook }) {
  if (look === 'transmission')
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
        <circle cx="12" cy="12" r="2.4" fill="currentColor" />
        <path d="M7.2 7.2a6.8 6.8 0 0 0 0 9.6M16.8 7.2a6.8 6.8 0 0 1 0 9.6M4.4 4.4a10.7 10.7 0 0 0 0 15.2M19.6 4.4a10.7 10.7 0 0 1 0 15.2" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
      </svg>
    )
  if (look === 'liquid')
    return (
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
        <path d="M12 3.2c3.4 4.3 5.6 7.4 5.6 10.4a5.6 5.6 0 0 1-11.2 0c0-3 2.2-6.1 5.6-10.4z" fill="currentColor" />
      </svg>
    )
  if (look === 'terminal') return <>❯</>
  if (look === 'note')
    return (
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
        <path d="M4.5 19.5l1.1-4.4L15.8 4.9a2 2 0 0 1 2.8 0l.5.5a2 2 0 0 1 0 2.8L8.9 18.4z" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinejoin="round" />
        <path d="M14 6.7l3.3 3.3M4.5 19.5l4.4-1.1" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
      </svg>
    )
  return <>✦</>
}

export function FloatingAsk({ place, experience, inputRef, look, displayedOriginCurrent }: { place: Placement; experience: string; inputRef: RefObject<HTMLInputElement | null>; look: FloatingLook; displayedOriginCurrent?: () => boolean }) {
  const words = SKIN_WORDS[look]
  const field = useAskField({ experience })
  const mayAct = () => !displayedOriginCurrent || displayedOriginCurrent()
  // A retained fallback choice must not capture a later Ask origin on invocation.
  // This invalidates the displayed origin locally; the native host remains authority.
  const f: ReturnType<typeof useAskField> = displayedOriginCurrent ? {
    ...field,
    change: (value) => { if (mayAct()) field.change(value) },
    voiceText: (value) => { if (!value || mayAct()) field.voiceText(value) },
    valueNow: () => mayAct() ? field.valueNow() : '',
    setSel: (index) => { if (mayAct()) field.setSel(index) },
    setPanel: (panel) => { if (mayAct()) field.setPanel(panel) },
    run: async (act, words) => { if (mayAct()) await field.run(act, words) },
    take: async (candidate, event) => { if (mayAct()) await field.take(candidate, event) },
    submit: async (event) => { if (mayAct()) await field.submit(event) },
    onKeyDown: (event, onEscape) => {
      if (guardComposing(event) || !mayAct() || event.defaultPrevented) return
      field.onKeyDown(event, onEscape)
    },
  } : field
  // j0-fixes r1.6 (stand-ins r1.4/r1.5 P1, Kimi r1.5): "Answering: you" is the hook's ONE recipient decision, by
  // identity (useAskField answeringYou): never the previous turn, never a name
  const answeringYou = f.answeringYou
  const id = useId()
  const reduced = useReducedMotion()
  const threadOpen = useAskStore((s) => s.threadOpen)
  const setThreadOpen = useAskStore((s) => s.setThreadOpen)
  const pinned = useAskStore((s) => s.pinned)
  const rows = useAskStore((s) => s.log.length)
  // the person's own mind answered the latest turn (Platform P2 acting_as): the chip opens You › <mind>
  const stop = useAskStore((s) => s.stop)
  // ask-send-r1: the Ask is in use while focus is anywhere within its capsule (field, Ask button, mic, rows)
  const within = useFocusWithin()
  const focused = within.focused
  const [sheet, setSheet] = useState<SheetHeight>('half')
  /** "Choose who answers" is open above the field (answerer.ts) */
  const [choosing, setChoosing] = useState(false)
  const capsule = useRef<HTMLDivElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  // voice: the browser's own speech recognition, words into this field (useAskVoice, voice.ts)
  const voice = useAskVoice(f, inputRef, capsule)
  const v: ReturnType<typeof useAskVoice> = displayedOriginCurrent ? {
    ...voice,
    retry: () => { if (mayAct()) voice.retry() },
    consent: () => { if (mayAct()) voice.consent() },
    toggle: () => { if (mayAct()) voice.toggle() },
    setAutoSend: (on) => { if (mayAct()) voice.setAutoSend(on) },
    onFieldKey: (event) => {
      if (guardComposing(event) || !mayAct() || event.defaultPrevented) return false
      return voice.onFieldKey(event)
    },
    button: {
      ...voice.button,
      onPointerDown: (event) => { if (mayAct()) voice.button.onPointerDown(event) },
      onClick: (event) => { if (mayAct()) voice.button.onClick(event) },
    },
    // Native pointer-up/cancel/stop and dismissal may still clean outgoing capture.
  } : voice
  const listening = v.listening
  const glassRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  // the answerer picker closes like the policy's panel does (useAskField): Esc anywhere, words typed outside the Ask
  usePopDismiss(choosing, () => setChoosing(false))

  // Flux: the capsule is liquid glass (the shader refracts through it), and each new row in the thread pours into it
  // as a ripple. Presentation only, through the experience's bridge; nothing here reaches into the experience.
  const bridge = useAskBridge(experience)
  useEffect(() => {
    const el = glassRef.current
    if (!el || look !== 'liquid' || !bridge?.glass) return
    return bridge.glass(el, 30)
  }, [look, bridge])
  useEffect(() => {
    if (look !== 'liquid' || !rows || reduced) return
    const r = glassRef.current?.getBoundingClientRect()
    if (r) bridge?.ripple?.(r.left + r.width * 0.5, r.top + r.height * 0.5, 0.7)
  }, [rows, look, bridge, reduced])

  const fullSheet = place.mode === 'phone' && threadOpen && sheet === 'full'
  useModalContainment(sheetRef, { active: fullSheet, also: [capsule as RefObject<HTMLElement | null>], restoreFocus: false })

  const state = listening ? 'listening' : f.answering ? 'answering' : focused || f.value ? 'active' : 'resting'
  const listId = `${id}-list`
  const showList = focused && f.list.length > 0 && !f.panel && !v.notice
  const pinnedSide = place.mode === 'desktop' && pinned && threadOpen
  const popOpen = showList || !!f.panel || !!v.notice || (choosing && !!f.chip && !threadOpen)
  // what Enter may act on is what the pop shows (enter.ts AskSeen): a voice notice, then the answerer picker, replace
  // the panel and the rows, in that order (the pop's own order below)
  const picking = choosing && !!f.chip && !threadOpen
  const rowsSeen = showList && !picking
  useSeen(field.declareSeen, rowsSeen, focused && !!f.panel && !v.notice && !picking)
  // mind-chat r1: what opens under the field never covers a mind's chat. While it is open and shares a column with an
  // open mind panel, the panel's content ends above it (popDismiss.popRoom → ui/Sheet --ask-pop-room); measured from
  // layout (the dock's top and the layer's height), never from the layer's entrance transform.
  useEffect(() => {
    const root = document.documentElement
    if (!popOpen) {
      root.style.removeProperty(POP_ROOM_VAR)
      return
    }
    const release = holdPopFlag()
    const measure = () => {
      const dock = capsule.current
      const pop = popRef.current
      const body = document.querySelector(MIND_PANEL_BODY)
      if (!dock || !pop) return
      const d = dock.getBoundingClientRect()
      const top = d.top - 8 - pop.offsetHeight
      const b = body?.getBoundingClientRect()
      const room = popRoom({ left: d.left, right: d.right, top }, b && b.width > 0 ? { left: b.left, right: b.right, top: b.top, bottom: b.bottom } : null, window.innerHeight)
      if (room > 0) root.style.setProperty(POP_ROOM_VAR, `${room}px`)
      else root.style.removeProperty(POP_ROOM_VAR)
    }
    measure()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (popRef.current) ro?.observe(popRef.current)
    if (capsule.current) ro?.observe(capsule.current)
    const t = window.setInterval(measure, 500)
    window.addEventListener('resize', measure)
    return () => {
      ro?.disconnect()
      window.clearInterval(t)
      window.removeEventListener('resize', measure)
      root.style.removeProperty(POP_ROOM_VAR)
      release()
    }
  }, [popOpen])
  const spend = f.thread ? `${money(f.thread.spent_usd)} / ${money(f.thread.budget_usd)}` : null

  const onEscape = () => {
    if (!mayAct()) return false
    if (threadOpen && !pinned) {
      setThreadOpen(false)
      return true
    }
    inputRef.current?.blur()
    return true
  }

  // ---- the thread, placed for the screen
  const threadBody = (
    <>
      <ThreadHead variant={words.thread} pinnable={place.mode === 'desktop'} onClose={() => { if (mayAct()) setThreadOpen(false) }} />
      <Thread variant={words.thread} />
    </>
  )
  let thread: React.ReactNode = null
  if (threadOpen) {
    if (place.mode === 'phone') {
      thread = (
        <m.div
          key="sheet"
          ref={sheetRef}
          className="ask-panel ask-sheet"
          data-height={sheet}
          data-ask-own=""
          role={fullSheet ? 'dialog' : 'region'}
          aria-modal={fullSheet || undefined}
          aria-label="Ask thread"
          initial={reduced ? { opacity: 0 } : { y: 40, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={reduced ? { opacity: 0 } : { y: 40, opacity: 0 }}
          transition={reduced ? { duration: 0.12 } : { type: 'spring', stiffness: 380, damping: 36 }}
          style={{ bottom: `calc(var(--sab) + ${place.bottom + 60}px)` }}
        >
          <button type="button" className="ask-grip" onClick={() => setSheet((h) => (h === 'peek' ? 'half' : h === 'half' ? 'full' : 'peek'))} aria-label={sheet === 'full' ? 'Make the thread smaller' : 'Make the thread taller'}>
            <span aria-hidden />
          </button>
          {threadBody}
        </m.div>
      )
    } else if (place.mode === 'landscape') {
      thread = (
        <m.div key="side" className="ask-panel ask-side" role="region" aria-label="Ask thread" initial={reduced ? { opacity: 0 } : { x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={reduced ? { opacity: 0 } : { x: 40, opacity: 0 }} transition={reduced ? { duration: 0.12 } : { type: 'spring', stiffness: 380, damping: 36 }}>
          {threadBody}
        </m.div>
      )
    } else if (pinnedSide) {
      thread = (
        <m.div key="pinned" className="ask-panel ask-pinned" role="region" aria-label="Ask thread" initial={reduced ? { opacity: 0 } : { x: 30, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ opacity: 0 }}>
          {threadBody}
        </m.div>
      )
    } else {
      thread = (
        <m.div
          key="rise"
          className="ask-panel ask-rise"
          role="region"
          aria-label="Ask thread"
          initial={reduced ? { opacity: 0 } : { y: 14, opacity: 0, scale: 0.98 }}
          animate={{ y: 0, opacity: 1, scale: 1 }}
          exit={reduced ? { opacity: 0 } : { y: 10, opacity: 0, scale: 0.98 }}
          transition={reduced ? { duration: 0.12 } : { type: 'spring', stiffness: 420, damping: 36 }}
          style={{ left: place.left + place.width / 2, bottom: `calc(var(--sab) + ${place.bottom + 64}px)` }}
        >
          {threadBody}
        </m.div>
      )
    }
  }

  const style: CSSProperties = { left: place.left, width: place.width, bottom: `calc(var(--sab) + ${place.bottom}px)` }

  return (
    <>
      <AnimatePresence>{thread}</AnimatePresence>

      <div ref={capsule} className="ask-dock" style={style} data-mode={place.mode} data-state={state} data-look={look} data-xc-keep-clear="" data-ask-capsule="" {...within.bind}>
        {/* what opens under the field: suggestions, or the policy's choices, question or plain limit */}
        <AnimatePresence>
          {popOpen && (
            <m.div key="pop" ref={popRef} className="ask-pop" initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduced ? 0 : 6 }} transition={reduced ? { duration: 0.1 } : { type: 'spring', stiffness: 520, damping: 38 }}>
              {v.notice ? (
                <VoiceNoticeView v={v} className="ask-say" buttonClass="ask-choice" />
              ) : choosing && f.chip && !threadOpen ? (
                <div className="ask-say" role="group" aria-label="Choose who answers">
                  <p>Who answers what you ask: choose a swarm, and its coordinator replies. It is kept as your default.</p>
                  <AnswererPicker btnClass="ask-choice" onDone={() => setChoosing(false)} />
                </div>
              ) : f.panel ? (
                <PanelView f={f} />
              ) : (
                <ul id={listId} role="listbox" aria-label="What this will do" className="ask-sugs" data-unsaved-ignore="">
                  {f.list.map((c, i) => (
                    <li
                      key={c.key}
                      id={`${id}-${i}`}
                      role="option"
                      aria-selected={c === f.active}
                      aria-label={c.pays ? `${sentence(c)}. ${c.pays}` : sentence(c)}
                      className="ask-sug"
                      data-tag={c.tag}
                      data-limit={c.limit || undefined}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseMove={() => i !== f.sel && f.setSel(i)}
                      onClick={() => void f.take(c)}
                    >
                      <span className="ask-sug-tag">{c.tag}</span>
                      <span className="ask-sug-body">{parts(c)}{c.pays && <span className="ask-sug-pays" data-pays="">{c.pays}</span>}</span>
                      {c === f.active && <span className="ask-sug-enter" aria-hidden>{c.act ? '↵' : 'tab'}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </m.div>
          )}
        </AnimatePresence>

        {/* while the thread is open it has the floor (a refusal there carries the same picker): never over it */}
        {f.chip && !f.answering && !threadOpen && (
          <div className="ask-answerer-row">
            <AnswererChipButton chip={f.chip} open={choosing} onToggle={() => { if (mayAct()) setChoosing((c) => !c) }} />
          </div>
        )}
        <div ref={glassRef} className="ask-capsule" data-state={state}>
          <span className="ask-aurora" aria-hidden />
          <span className="ask-stars" aria-hidden />
          <span className="ask-mark" aria-hidden>
            <Mark look={look} />
          </span>
          <div className="ask-field">
            <VoiceAnnouncer v={v} />
            {listening ? (
              <VoiceListening v={v} className="ask-listening" toggleClass="ask-voice-pause" />
            ) : f.answering ? (
              <span className="ask-step" aria-live="off">
                {words.step(shownMind(f.thread?.mind.name ?? f.answerer), f.step, f.step === 'sending')}
              </span>
            ) : null}
            <input
              ref={inputRef}
              className="ask-input"
              value={f.value}
              onChange={(e) => f.change(e.target.value)}
              onKeyDown={(e) => {
                // an IME's confirming key is the input method's, in every floating skin (keys.ts)
                if (guardComposing(e)) return
                if (displayedOriginCurrent && (!mayAct() || e.defaultPrevented)) return
                if (!v.onFieldKey(e)) f.onKeyDown(e, onEscape)
              }}
              placeholder={listening ? 'Speak; your words appear here' : f.answering ? words.answeringPlaceholder : place.mode === 'desktop' ? words.placeholder : words.placeholderShort}
              aria-label={words.label}
              role="combobox"
              aria-expanded={showList}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={showList && f.active ? `${id}-${f.list.indexOf(f.active)}` : undefined}
              aria-describedby={`${id}-scope`}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="send"
              data-ask-input=""
              disabled={displayedOriginCurrent ? !mayAct() : undefined}
            />
          </div>
          <span id={`${id}-scope`} className="ask-chips">
            <span className="ask-chip" title="Where you are asking from">
              {f.where}
            </span>
            {answeringYou ? (
              <button type="button" className="ask-chip ask-chip-mind" title="Your personal mind answers: open it" onClick={() => navigate({ name: 'me', view: 'mind' })} data-mind-chip="">
                Answering: you
                {spend ? ` · ${spend}` : ''}
              </button>
            ) : (
              (f.answerer || spend) && (
                <span className="ask-chip ask-chip-mind" title="Who answers: the swarm's orchestrator">
                  {f.answerer ? shownMind(f.answerer) : ''}
                  {spend ? ` · ${spend}` : ''}
                </span>
              )
            )}
          </span>
          <button type="button" className="ask-icon" onClick={() => { if (mayAct()) setThreadOpen(!threadOpen) }} aria-expanded={threadOpen} aria-label={threadOpen ? 'Hide the thread' : `Show the thread${rows ? ` (${rows} rows)` : ''}`}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
              <path d="M4 6h16M4 12h11M4 18h7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
            </svg>
            {rows > 0 && !threadOpen && <span className="ask-dot" aria-hidden />}
          </button>
          <button type="button" className="ask-icon ask-mic" {...v.button} disabled={displayedOriginCurrent ? !mayAct() : undefined} aria-label={v.label} title={v.support.ok ? 'Talk: tap to start and stop (with a mouse, hold to talk) · Ctrl/⌘ Shift Space' : v.label} data-voice={v.state}>
            <MicIcon />
          </button>
          {f.answering ? (
            <button type="button" className="ask-icon ask-go" data-stop="" onClick={() => { if (mayAct()) void stop() }} aria-label="Stop the answer">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
                <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
              </svg>
            </button>
          ) : (
            <button type="button" className="ask-icon ask-go" onMouseDown={keepFieldFocus} onClick={() => void f.submit()} disabled={!f.value.trim() || !mayAct()} aria-label="Ask">
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
                <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </>
  )
}

/** The policy's answer when Enter does not simply run something. */
export function PanelView({ f }: { f: ReturnType<typeof useAskField> }) {
  const p = f.panel
  if (!p) return null
  // mind-chat r1: always a visible way to close it (Esc and typing elsewhere close it too: popDismiss)
  return (
    <div className="ask-pop-panel" data-ask-panel={p.kind}>
      <button type="button" className="ask-pop-close" onClick={() => f.setPanel(null)} aria-label="Close this" title="Close (Esc)">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
          <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
      <PanelBody f={f} p={p} />
    </div>
  )
}

function PanelBody({ f, p }: { f: ReturnType<typeof useAskField>; p: NonNullable<ReturnType<typeof useAskField>['panel']> }) {
  const you = f.value.trim()
  if (p.kind === 'say')
    return (
      <p className="ask-say" role={p.tone === 'warn' ? 'alert' : 'status'} data-tone={p.tone}>
        {p.text}
      </p>
    )
  if (p.kind === 'limit')
    return (
      <div className="ask-say" role="status">
        <p>{p.c.parts.map((x) => x.t).join('')}</p>
        {p.safe && (
          <button type="button" className="ask-choice" onClick={() => void f.take(p.safe)}>
            {sentence(p.safe)}
          </button>
        )}
      </div>
    )
  if (p.kind === 'clarify')
    return (
      <div className="ask-say" role="group" aria-label={p.c.clarify!.question}>
        <p>{p.c.clarify!.question}</p>
        <div className="ask-chips-row">
          {p.c.clarify!.chips.map((c, i) => (
            <button key={c.key} type="button" className="ask-choice" data-default={i === 0 || undefined} onClick={() => c.act && void f.run(c.act, you)}>
              {c.label}
              {c.who && <span className="ask-sug-who"> ({c.who})</span>}
            </button>
          ))}
        </div>
      </div>
    )
  if (p.kind === 'choose')
    return (
      <div className="ask-say" role="group" aria-label="Did you mean">
        <p>Did you mean…</p>
        {p.options.map((c) => (
          <button key={c.key} type="button" className="ask-choice" onClick={() => void f.take(c)}>
            {sentence(c)}
          </button>
        ))}
        {f.answerer !== undefined && (
          <button type="button" className="ask-choice" data-quiet="" onClick={() => void f.run({ do: 'mind', text: you }, you)}>
            None of these: ask {shownMind(f.answerer)}
          </button>
        )}
      </div>
    )
  return (
    <div className="ask-say" role="status">
      <p>I can’t do that here yet, and no swarm orchestrator is set to answer.</p>
      {p.near.map((c) => (
        <button key={c.key} type="button" className="ask-choice" onClick={() => void f.take(c)}>
          {sentence(c)}
        </button>
      ))}
    </div>
  )
}
