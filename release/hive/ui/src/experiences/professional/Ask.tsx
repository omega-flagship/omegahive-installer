// Purpose: draw Professional's Ask card: the field, its choices and voice, the conversation when shown, with the
// Ask's size links in its head, and what waits on the person whether or not it is.
import { useId, useRef, type RefObject } from 'react'
import { AskSearch } from '../../features/ask/AskSearch'
import { PanelView } from '../../features/ask/ClassicAsk'
import { AskCards, Thread, ThreadHead } from '../../features/ask/Thread'
import { keepFieldFocus, useAskField, useSeen } from '../../features/ask/useAskField'
import { guardComposing } from '../../features/ask/keys'
import { AnswererInline } from '../../features/ask/AnswererPicker'
import { useAskVoice } from '../../features/ask/useAskVoice'
import { VoiceAnnouncer, VoiceListening, VoiceNoticeView } from '../../features/ask/VoiceParts'
import { useAskStore } from '../../store/ask'
import { current } from './binding'
import { changeAskSize, halfSwitch, useAskSize } from '../../features/ask/askSize'
import type { AskMode } from '../../features/ask/placement'
import { SIZE_WORDS } from '../../features/ask/words'

/**
 * Skin only. App.tsx's single AskHost keeps identity, orchestrator dispatch and app confirmations. Its head holds the
 * Ask's size links (askSize.ts), since its conversation shows only once there is one; at `half` the card is the left
 * half's column and its conversation always shows.
 */
export function ProfessionalAsk({ ctx, inputRef, half = false, mode = 'desktop' }: { ctx: string; inputRef: RefObject<HTMLInputElement | null>; half?: boolean; mode?: AskMode }) {
  const field = useAskField({ experience: 'professional' })
  // Shared choices and voice call these methods directly. Keep the displayed origin,
  // rather than letting an old choice acquire the next person's/session's Ask origin.
  const f: ReturnType<typeof useAskField> = {
    ...field,
    change: (value) => { if (current(ctx)) field.change(value) },
    voiceText: (value) => {
      // The native sign-in cleanup may always empty this outgoing local draft.
      if (!value || current(ctx)) field.voiceText(value)
    },
    valueNow: () => current(ctx) ? field.valueNow() : '',
    setSel: (index) => { if (current(ctx)) field.setSel(index) },
    setPanel: (panel) => { if (current(ctx)) field.setPanel(panel) },
    run: async (act, words) => { if (current(ctx)) await field.run(act, words) },
    take: async (candidate, event) => { if (current(ctx)) await field.take(candidate, event) },
    submit: async (event) => { if (current(ctx)) await field.submit(event) },
    onKeyDown: (event, onEscape) => {
      if (guardComposing(event) || !current(ctx) || event.defaultPrevented) return
      field.onKeyDown(event, onEscape)
    },
  }
  const input = inputRef
  const root = useRef<HTMLDivElement>(null)
  const v = useAskVoice(f, input, root)
  const rows = useAskStore((s) => s.log.length)
  const threadOpen = useAskStore((s) => s.threadOpen)
  const sw = halfSwitch(useAskSize(), mode)
  const showThread = rows > 0 && (threadOpen || half)
  const id = useId()
  const options = f.panel || v.notice ? [] : f.list
  const activeIndex = f.active ? options.indexOf(f.active) : -1
  // what Enter may act on is what is drawn here (enter.ts AskSeen): a voice notice replaces the rows
  useSeen(field.declareSeen, options.length > 0, !!f.panel)
  return (
    <section className="pr-card pr-ask ask-root" aria-labelledby={`${id}-heading`}>
      <div className="pr-card-head"><h2 id={`${id}-heading`}>Ask the hive</h2><span className="pr-ask-sizes">
        <button type="button" className="pr-link" disabled={!current(ctx)} aria-label={sw.label} onClick={() => { if (current(ctx)) changeAskSize(sw.to) }}>{sw.text}</button>
        <button type="button" className="pr-link" disabled={!current(ctx)} aria-label={SIZE_WORDS.collapse.label} onClick={() => { if (current(ctx)) changeAskSize('collapsed') }}>{SIZE_WORDS.collapse.text}</button>
        {!half && <button type="button" className="pr-link" disabled={!rows || !current(ctx)} onClick={() => { if (current(ctx)) useAskStore.getState().setThreadOpen(!threadOpen) }}>{threadOpen ? 'Hide conversation' : 'Conversation'}</button>}
      </span></div>
      <div ref={root}>
        {/* r2.3 (stand-in P1): the form's implicit submission (Enter in the field) never dispatches; Enter is the field's
            own guarded key, and the Ask button sends only on its own click */}
        <form onSubmit={(e) => e.preventDefault()}>
          <div className="pr-ask-line">
            <input ref={input} data-ask-input="" value={f.value} onChange={(e) => f.change(e.target.value)} onKeyDown={(e) => {
              if (guardComposing(e) || !current(ctx) || e.defaultPrevented) return
              if (v.onFieldKey(e)) return
              f.onKeyDown(e)
            }} placeholder="What would you like to do?" aria-label="Ask the hive" role="combobox" aria-expanded={options.length > 0} aria-controls={`${id}-list`} aria-autocomplete="list" aria-activedescendant={activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined} autoComplete="off" disabled={!current(ctx)} />
            <AskSearch look="professional" words={f.valueNow} className="pr-button pr-ask-search" may={() => current(ctx)} disabled={!current(ctx)}>Search</AskSearch>
            <button type="button" className="pr-button" {...v.button} aria-label={v.label} disabled={!current(ctx)}>{v.listening ? 'Stop voice' : 'Voice'}</button>
            <button type="button" className="pr-button pr-primary" onMouseDown={keepFieldFocus} disabled={!f.value.trim() || !current(ctx)} onClick={() => { if (current(ctx)) void f.submit() }}>Ask</button>
          </div>
        </form>
        <VoiceAnnouncer v={v} />
        <VoiceListening v={v} className="pr-notice" toggleClass="pr-link" />
        <VoiceNoticeView v={v} className="pr-notice" buttonClass="pr-button" />
        {options.length > 0 && <ul id={`${id}-list`} className="pr-ask-options" role="listbox" aria-label="What will happen" data-unsaved-ignore="">
          {options.map((c, i) => <li key={c.key} id={`${id}-option-${i}`} role="option" aria-selected={i === activeIndex} aria-label={c.pays ? `${c.parts.map((p) => p.t).join('')}. ${c.pays}` : c.parts.map((p) => p.t).join('')}>
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { if (current(ctx)) void f.take(c) }}><span>{c.parts.map((p) => p.t).join('')}{c.pays && <small className="pr-muted" data-pays="" style={{ display: 'block' }}>{c.pays}</small>}</span><small>{c.tag}</small></button>
          </li>)}
        </ul>}
        <PanelView f={f} />
        <AnswererInline look="professional" chip={f.chip ?? (f.answerer ? { kind: 'planned', name: f.answerer } : null)} answering={f.answering} may={() => current(ctx)} />
        {f.answering && !f.preparing && <p className="pr-muted" role={f.waking ? undefined : 'status'} aria-live={f.waking ? 'off' : undefined}>{f.waking ? `Waking ${f.answerer ?? 'the orchestrator'}…` : `${f.answerer ?? 'The orchestrator'} is answering…`} <button type="button" className="pr-link" onClick={() => { if (current(ctx)) void useAskStore.getState().stop() }}>Stop</button></p>}
        {/* with no conversation drawn (none yet, or hidden), what waits on the person still shows: stopped tasks, minds'
            offers to build in Create, and the Studio setup card or Directing Studio (J3 r4.3 O3) */}
        {!showThread && <AskCards />}
        {showThread && <div className="pr-ask-thread"><ThreadHead variant="letter" onClose={half ? undefined : () => { if (current(ctx)) useAskStore.getState().setThreadOpen(false) }} /><Thread variant="letter" /></div>}
      </div>
    </section>
  )
}
