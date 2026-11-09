/**
 * Still's floating line: when the paper's question box is out of view (scrolled past, or a page or sheet is open over
 * the paper), the Ask condenses into one ruled line with a blinking caret at the bottom margin, in Still's serif.
 * The mind's answers are typeset above it like a letter. Same headless hook as every skin.
 */
import { AnimatePresence, m } from 'framer-motion'
import { useId, useRef, useState, type RefObject } from 'react'
import { guardComposing } from './keys'
import { useReducedMotion } from '../../lib/hooks'
import { useAskStore } from '../../store/ask'
import type { Candidate } from '../../lib/intent'
import { PanelView } from './ClassicAsk'
import type { Placement } from './placement'
import { Thread, ThreadHead } from './Thread'
import { useAskField, useSeen } from './useAskField'
import { useAskVoice } from './useAskVoice'
import { VoiceAnnouncer, VoiceListening, VoiceNoticeView } from './VoiceParts'
import { shownMind } from './words'
import { useDraft } from '../../experiences/drafts'
import { useStillFieldCaret, useStillFieldPart } from './stillField'

const sentence = (c: Candidate) => c.parts.map((p) => p.t).join('')

export function StillLine({ place, inputRef, words }: { place: Placement; inputRef: RefObject<HTMLInputElement | null>; words: string[] }) {
  const part = useStillFieldPart()
  const draft = useDraft('still:ask')
  const f = useAskField({ experience: 'still', draft })
  useStillFieldCaret('floating', inputRef)
  const id = useId()
  const reduced = useReducedMotion()
  const threadOpen = useAskStore((s) => s.threadOpen)
  const setThreadOpen = useAskStore((s) => s.setThreadOpen)
  const stop = useAskStore((s) => s.stop)
  const [focused, setFocused] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const v = useAskVoice(f, inputRef, root)
  const showList = focused && f.list.length > 0 && !f.panel && !v.notice
  // what Enter may act on is what is drawn here (enter.ts AskSeen): a voice notice replaces both
  useSeen(f.declareSeen, showList, focused && !!f.panel && !v.notice)
  const listId = `${id}-list`
  // listening: the caret becomes a breathing ink dot (ask.css)
  const state = v.listening ? 'listening' : f.answering ? 'answering' : focused || f.value ? 'active' : 'resting'
  return (
    <div ref={root} className="ask-still-line" style={{ left: place.left, width: place.width, bottom: `calc(var(--sab) + ${place.bottom}px)` }} data-state={state} data-mode={place.mode}>
      <AnimatePresence>
        {threadOpen && (
          <m.div key="letter" className="ask-letter" role="region" aria-label="Today’s page" initial={reduced ? { opacity: 0 } : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <ThreadHead variant="letter" onClose={() => setThreadOpen(false)} />
            <Thread variant="letter" words={words} />
          </m.div>
        )}
        {(showList || f.panel || v.notice) && (
          <m.div key="pop" className="ask-letter ask-letter-pop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            {v.notice ? (
              <VoiceNoticeView v={v} className="ask-say" buttonClass="ask-choice" />
            ) : f.panel ? (
              <PanelView f={f} />
            ) : (
              <ul id={listId} role="listbox" aria-label="What this will do" className="ask-sugs" data-unsaved-ignore="">
                {f.list.map((c, i) => (
                  <li key={c.key} id={`${id}-${i}`} role="option" aria-selected={c === f.active} aria-label={sentence(c)} className="ask-sug" onMouseDown={(e) => e.preventDefault()} onMouseMove={() => i !== f.sel && f.setSel(i)} onClick={() => void f.take(c)}>
                    <span className="ask-sug-tag">{c.tag}</span>
                    <span className="ask-sug-body">{sentence(c)}{c.pays && <span className="ask-sug-pays" data-pays="">{c.pays}</span>}</span>
                  </li>
                ))}
              </ul>
            )}
          </m.div>
        )}
      </AnimatePresence>
      <VoiceListening v={v} className="ask-still-listening" toggleClass="ask-still-btn ask-voice-pause" />
      <div className="ask-still-rule">
        <span className="ask-still-label" aria-hidden>
          Ask
        </span>
        {v.listening && <span className="ask-still-ink" aria-hidden />}
        <VoiceAnnouncer v={v} />
        {f.answering && !v.listening && (
          <span className="ask-still-step">
            {shownMind(f.thread?.mind.name ?? f.answerer)} is writing{f.step && f.step !== 'sending' ? ` · ${f.step}` : '…'}
          </span>
        )}
        <input
          ref={inputRef}
          className="ask-still-input"
          value={f.value}
          onChange={(e) => f.change(e.target.value)}
          onKeyDown={(e) =>
            guardComposing(e) ||
            v.onFieldKey(e) ||
            f.onKeyDown(e, () => {
              if (threadOpen) setThreadOpen(false)
              else inputRef.current?.blur()
              return true
            })
          }
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={v.listening ? 'Speak; the words appear here' : 'What do you need?'}
          aria-label="What do you need?"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && f.active ? `${id}-${f.list.indexOf(f.active)}` : undefined}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="send"
          data-ask-input=""
          data-ui-part={part}
          data-intent="ask.field"
        />
        <button type="button" className="ask-still-btn ask-mic" {...v.button} aria-label={v.label} data-voice={v.state}>
          {v.listening ? 'Stop' : 'Speak'}
        </button>
        <button type="button" className="ask-still-btn" onClick={() => setThreadOpen(!threadOpen)} aria-expanded={threadOpen}>
          {threadOpen ? 'Fold' : 'Today’s page'}
        </button>
        {f.answering && (
          <button type="button" className="ask-still-btn" onClick={() => void stop()}>
            Stop
          </button>
        )}
      </div>
    </div>
  )
}
