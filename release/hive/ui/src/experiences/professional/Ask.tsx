import { useId, useRef, type RefObject } from 'react'
import { PanelView } from '../../features/ask/ClassicAsk'
import { Thread, ThreadHead } from '../../features/ask/Thread'
import { keepFieldFocus, useAskField, useSeen } from '../../features/ask/useAskField'
import { guardComposing } from '../../features/ask/keys'
import { AnswererInline } from '../../features/ask/AnswererPicker'
import { useAskVoice } from '../../features/ask/useAskVoice'
import { VoiceAnnouncer, VoiceListening, VoiceNoticeView } from '../../features/ask/VoiceParts'
import { useAskStore } from '../../store/ask'
import { current } from './binding'
import { DirectingStudio } from '../../features/studioLive/DirectingStudio'

/** Skin only. App.tsx's single AskHost keeps identity, orchestrator dispatch and app confirmations. */
export function ProfessionalAsk({ ctx, inputRef }: { ctx: string; inputRef: RefObject<HTMLInputElement | null> }) {
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
  const id = useId()
  const options = f.panel || v.notice ? [] : f.list
  const activeIndex = f.active ? options.indexOf(f.active) : -1
  // what Enter may act on is what is drawn here (enter.ts AskSeen): a voice notice replaces the rows
  useSeen(field.declareSeen, options.length > 0, !!f.panel)
  return (
    <section className="pr-card pr-ask ask-root" aria-labelledby={`${id}-heading`}>
      <div className="pr-card-head"><h2 id={`${id}-heading`}>Ask the hive</h2><button type="button" className="pr-link" disabled={!rows || !current(ctx)} onClick={() => { if (current(ctx)) useAskStore.getState().setThreadOpen(!threadOpen) }}>{threadOpen ? 'Hide conversation' : 'Conversation'}</button></div>
      <div ref={root}>
        {/* r2.3 (stand-in P1): the form's implicit submission (Enter in the field) never dispatches; Enter is the field's
            own guarded key, and the Ask button sends only on its own click */}
        <form onSubmit={(e) => e.preventDefault()}>
          <div className="pr-ask-line">
            <input ref={input} value={f.value} onChange={(e) => f.change(e.target.value)} onKeyDown={(e) => {
              if (guardComposing(e) || !current(ctx) || e.defaultPrevented) return
              if (v.onFieldKey(e)) return
              f.onKeyDown(e)
            }} placeholder="What would you like to do?" aria-label="Ask the hive" role="combobox" aria-expanded={options.length > 0} aria-controls={`${id}-list`} aria-autocomplete="list" aria-activedescendant={activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined} autoComplete="off" disabled={!current(ctx)} />
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
        <AnswererInline chip={f.chip} answering={f.answering} may={() => current(ctx)} />
        {f.answering && <p className="pr-muted" role="status">{f.answerer ?? 'The orchestrator'} is answering… <button type="button" className="pr-link" onClick={() => { if (current(ctx)) void useAskStore.getState().stop() }}>Stop</button></p>}
        {/* J3 r4.3 O3: the Studio setup card / Directing Studio shows even before the thread has rows */}
        {!(rows > 0 && threadOpen) && <DirectingStudio />}
        {rows > 0 && threadOpen && <div className="pr-ask-thread"><ThreadHead variant="letter" onClose={() => { if (current(ctx)) useAskStore.getState().setThreadOpen(false) }} /><Thread variant="letter" /></div>}
      </div>
    </section>
  )
}
