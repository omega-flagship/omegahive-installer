import { AnimatePresence, m } from 'framer-motion'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { PanelView } from '../../features/ask/ClassicAsk'
import { useAskField, useSeen } from '../../features/ask/useAskField'
import { guardComposing } from '../../features/ask/keys'
import { AnswererInline } from '../../features/ask/AnswererPicker'
import { useAskVoice } from '../../features/ask/useAskVoice'
import { VoiceAnnouncer, VoiceListening, VoiceNoticeView } from '../../features/ask/VoiceParts'
import { shownMind } from '../../features/ask/words'
import { askOrigin, useAskStore } from '../../store/ask'
import { examples, type IntentAct } from '../../lib/intent'
import { useMediaQuery } from '../../lib/hooks'
import type { Act, World } from './intent'
import { useSprings } from './shared'
import { useDraft } from '../drafts'
import { useStillFieldCaret, useStillFieldPlace, useStillFieldPart } from '../../features/ask/stillField'
import { usePhase, wakeIntoAsk } from '../../shell/phase'

export interface Receipt {
  text: string
  link?: { label: string; run: () => void }
  /** A refusal or failure: said plainly, and it stays until the person changes the field. */
  tone?: 'error'
  /** Keep what was typed (it did not happen, or it was a search). */
  keep?: boolean
  /** In-place search results for what was typed. */
  results?: { key: string; title: string; sub: string; run: () => void }[]
}

/** Still's own acts (its sheets, passages and the reviewed person-typed hive actions); the rest are shared. */
const STILL_ACTS = new Set<IntentAct['do']>(['send', 'open', 'wake', 'sleep', 'goal', 'scroll', 'feature', 'swarm', 'gallery', 'search'])
export const isStillAct = (a: IntentAct): a is Act => STILL_ACTS.has(a.do)

interface Props {
  inputRef: RefObject<HTMLInputElement | null>
  world: World
  /** Do it; return a receipt to show under the field (or null when the result is visible elsewhere). */
  onAct: (a: Act) => Promise<Receipt | null> | Receipt | null
}

/**
 * One field. Type what you want; the line below says exactly what will happen; Enter does it. The understanding is
 * the shared fast path (lib/intent, lifted from here); what nothing local understands goes to the swarm's
 * orchestrator, whose answer is set below like a letter. The field never locks: words typed while it answers steer it.
 */
export function Ask({ inputRef, world, onAct }: Props) {
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const resultsRef = useRef<HTMLUListElement>(null)
  const sp = useSprings()
  const id = useId()
  const stop = useAskStore((s) => s.stop)

  const handler = useCallback(
    async (act: IntentAct): Promise<boolean | 'keep'> => {
      if (!isStillAct(act)) return false
      window.clearTimeout(timer.current)
      const origin = askOrigin()
      try {
        const r = await onAct(act)
        // Review B1: a receipt from before a session or person change is never shown to the next one
        if (!origin.ok()) return true
        setReceipt(r)
        if (r && !r.keep && r.tone !== 'error') timer.current = window.setTimeout(() => setReceipt(null), 8000)
        return r?.keep ? 'keep' : true
      } catch (err) {
        if (!origin.ok()) return true
        // the draft stays; say what happened in plain words
        setReceipt({ tone: 'error', keep: true, text: `That did not go through (${err instanceof Error ? err.message : 'no answer'}). Nothing was cleared; your words are still here.` })
        return 'keep'
      }
    },
    [onAct],
  )
  const part = useStillFieldPart()
  const draft = useDraft('still:ask')
  const onPaper = useStillFieldPlace() === 'paper'
  const f = useAskField({ experience: 'still', onAct: handler, draft, active: onPaper })
  useStillFieldCaret('paper', inputRef)
  // a phone-wide line (still.css's 640px step) holds a shorter placeholder, so it never clips
  const narrow = useMediaQuery('(max-width: 640px)')
  const root = useRef<HTMLDivElement>(null)
  // spoken words replace an open receipt, as typing does
  const v = useAskVoice({ ...f, voiceText: (t: string) => (f.voiceText(t), setReceipt(null)) }, inputRef, root)
  const stopVoice = useRef(v.stop)
  stopVoice.current = v.stop
  const value = f.value
  const tries = useMemo(() => examples(world), [world])
  const top = f.list[0]
  const rest = top?.fill && value && top.fill.toLowerCase().startsWith(value.toLowerCase()) ? top.fill.slice(value.length) : ''
  // while search results are open, they replace the suggestions; typing brings the suggestions back
  const showSugs = !receipt?.results && !f.panel
  const sugs = showSugs ? f.list : []

  const change = (v: string) => {
    f.change(v)
    if (receipt) setReceipt(null)
  }

  const closeResults = () => {
    setReceipt(null)
    inputRef.current?.focus({ preventScroll: true })
  }

  // what Enter may act on is what is drawn here, while this field is the one in use (focused): the suggestion rows,
  // or the policy's panel (enter.ts AskSeen; Kimi r2.1 #1: the floating line is a separate field with its own)
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!onPaper) { setFocused(false); stopVoice.current() }
  }, [onPaper])
  useSeen(f.declareSeen, onPaper && focused && sugs.length > 0, onPaper && focused && !!f.panel)

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // an IME's confirming key is the input method's, never the Ask's (keys.ts)
    if (guardComposing(e) || e.defaultPrevented) return
    if (v.onFieldKey(e)) return
    if (receipt?.results && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      // results are open: nothing hidden may run; ArrowDown goes into the results
      e.preventDefault()
      if (e.key === 'ArrowDown') resultsRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
      return
    }
    if (e.key === 'Escape' && receipt) {
      // first Esc closes what is open under the field (results, a message); the words stay
      e.preventDefault()
      setReceipt(null)
      return
    }
    if (e.key === 'Tab' && !e.shiftKey && rest) {
      e.preventDefault()
      change(f.list[0].fill!)
      return
    }
    f.onKeyDown(e)
  }

  const listId = `${id}-list`
  const activeIndex = f.active ? sugs.indexOf(f.active) : -1
  return (
    <div ref={root} className="st-ask" data-listening={v.listening || undefined} aria-hidden={!onPaper || undefined}>
      {/* Keep the paper's full layout while yielding. Only the input disappears; dormant controls cannot act. */}
      <div inert={!onPaper || undefined}>
      <div className="st-ask-line">
        <AnswererInline look="still" chip={f.chip ?? (f.answerer ? { kind: 'planned', name: f.answerer } : null)} answering={f.answering} />
        <span className="st-ask-mark" aria-hidden>
          ›
        </span>
        <div className="st-ask-field">
          <div className="st-ask-ghost" aria-hidden>
            {value}
            <span>{rest}</span>
          </div>
          {onPaper ? <input
            ref={inputRef}
            className="st-ask-input"
            data-ask-input=""
            data-ui-part={part}
            data-intent="ask.field"
            value={value}
            onChange={(e) => change(e.target.value)}
            onKeyDown={onKey}
            onFocus={() => {
              setFocused(true)
              const phase = usePhase.getState()
              if (phase.phased && phase.phase === 'rest') wakeIntoAsk('type')
            }}
            onBlur={() => setFocused(false)}
            placeholder={
              f.answering
                ? narrow
                  ? 'Add a word, or ask…'
                  : 'Add a word while it writes, or ask anything'
                : narrow
                  ? 'Ask the hive…'
                  : 'What would you like the hive to do?'
            }
            aria-label="What would you like the hive to do?"
            role="combobox"
            aria-expanded={sugs.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-busy={f.busy}
            aria-activedescendant={activeIndex >= 0 ? `${id}-${activeIndex}` : undefined}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="go"
          /> : <span className="st-ask-input" style={{ display: 'block', overflow: 'hidden' }} aria-hidden="true">{value || '\u00a0'}</span>}
        </div>
        {!value && !v.listening && (
          <kbd className="st-ask-key" aria-hidden>
            /
          </kbd>
        )}
        <button type="button" className="st-link st-ask-mic ask-mic" {...v.button} aria-label={v.label} data-voice={v.state}>
          {v.listening ? 'stop' : 'speak'}
        </button>
      </div>
      <VoiceAnnouncer v={v} />
      {v.listening && <VoiceListening v={v} className="st-receipt st-listening" toggleClass="st-link ask-voice-pause" />}
      <VoiceNoticeView v={v} className="st-letter st-panel" buttonClass="ask-choice" />

      {f.answering && !f.preparing && (
        <p className="st-receipt st-writing" role={f.waking ? undefined : 'status'} aria-live={f.waking ? 'off' : undefined}>
          <span>
            {f.waking ? `Waking ${shownMind(f.answerer)}…` : `${shownMind(f.answerer)} is writing${f.step && f.step !== 'sending' ? ` · ${f.step}` : '…'}`}
          </span>
          <button className="st-link" onClick={() => void stop()}>
            Stop
          </button>
        </p>
      )}

      <ul id={listId} role="listbox" aria-label="What this will do" className="st-sugs" data-unsaved-ignore="">
        <AnimatePresence initial={false} mode="popLayout">
          {sugs.map((s, i) => {
            const on = s === f.active
            return (
              <m.li
                key={s.key}
                id={`${id}-${i}`}
                role="option"
                aria-selected={on}
                className="st-sug"
                data-limit={s.limit || undefined}
                layout="position"
                initial={sp.reduced ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: { duration: sp.reduced ? 0 : 0.12 } }}
                transition={{ ...sp.snappy, delay: sp.reduced ? 0 : i * 0.025 }}
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => i !== f.sel && f.setSel(i)}
                onClick={() => void f.take(s)}
              >
                {on && <m.span layoutId="st-sug-hl" className="st-sug-hl" transition={sp.snappy} />}
                <span className="st-sug-tag">{s.tag}</span>
                <span className="st-sug-body">
                  {s.parts.map((p, j) =>
                    p.em ? (
                      <em key={j}>{p.t}</em>
                    ) : p.q ? (
                      <q key={j}>{p.t}</q>
                    ) : p.who ? (
                      <span key={j} className="st-sug-who">
                        {p.t}
                      </span>
                    ) : (
                      <span key={j}>{p.t}</span>
                    ),
                  )}
                  {s.pays && <small className="st-sug-pays" data-pays="">{s.pays}</small>}
                </span>
                {on && (s.act || s.fill) && <span className="st-sug-enter">{s.act ? '↵' : 'tab'}</span>}
              </m.li>
            )
          })}
        </AnimatePresence>
      </ul>

      {f.panel && (
        <div className="st-letter st-panel">
          <PanelView f={f} />
        </div>
      )}

      <AnimatePresence initial={false} mode="wait">
        {receipt ? (
          <m.div
            key="receipt"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={sp.fade}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                closeResults()
              } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                const all = [...(resultsRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
                const i = all.indexOf(document.activeElement as HTMLButtonElement)
                if (i < 0) return
                e.preventDefault()
                if (e.key === 'ArrowUp' && i === 0) inputRef.current?.focus()
                else all[Math.max(0, Math.min(all.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus()
              }
            }}
          >
            <p className="st-receipt" data-tone={receipt.tone} role={receipt.tone === 'error' ? 'alert' : 'status'}>
              <span>{receipt.text}</span>
              {receipt.link && (
                <button className="st-link" onClick={receipt.link.run}>
                  {receipt.link.label}
                </button>
              )}
            </p>
            {!!receipt.results?.length && (
              <ul ref={resultsRef} className="st-results" aria-label={`Found for “${value.trim()}”`}>
                {receipt.results.map((r) => (
                  <li key={r.key}>
                    <button className="st-result" onClick={r.run}>
                      <span className="st-result-title">{r.title}</span>
                      <span className="st-result-sub">{r.sub}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </m.div>
        ) : !value && !f.answering ? (
          <m.div key="tries" className="st-tries" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={sp.fade}>
            <span>Try</span>
            {tries.map((t) => (
              <button
                key={t}
                onClick={() => {
                  change(t)
                  inputRef.current?.focus()
                }}
              >
                “{t.trim()}”
              </button>
            ))}
          </m.div>
        ) : null}
      </AnimatePresence>
      </div>
    </div>
  )
}
