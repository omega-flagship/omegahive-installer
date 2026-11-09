/**
 * The plan's questions to the person: gentle cards that never hold the rest of the page (only the piece they are about
 * waits). Each is answered inline, by a suggested answer or in the person's own words; once answered it settles into
 * "You said: …". Presentation only: the answer goes through the page's act.
 */
import { useId, useState } from 'react'
import { guardComposing } from '../ask/keys'
import type { PlanQuestion, PlanView } from './contract'

function aboutWords(q: PlanQuestion, view: PlanView): string {
  if (q.about.kind === 'piece') {
    const id = q.about.piece
    const p = view.pieces.find((x) => x.id === id)
    return p ? `About ${p.title.charAt(0).toLowerCase()}${p.title.slice(1)}. Only that waits; the rest goes on.` : 'Only the piece it is about waits; the rest goes on.'
  }
  if (q.about.kind === 'deploy') return 'Before it is deployed.'
  if (q.about.kind === 'blocked') return 'The plan is waiting on this.'
  return 'About the whole plan.'
}

function Open({ q, view, busy, onAnswer }: { q: PlanQuestion; view: PlanView; busy: boolean; onAnswer: (text: string) => void }) {
  const [text, setText] = useState('')
  const field = useId()
  const send = (t: string) => {
    if (busy || !t.trim()) return
    onAnswer(t.trim())
  }
  return (
    <li className="pq-card" data-open="" aria-busy={busy || undefined}>
      <p className="pq-text">{q.text}</p>
      <p className="pq-about">{aboutWords(q, view)}</p>
      {q.choices.length > 0 && (
        <div className="pq-choices" role="group" aria-label="Suggested answers">
          {q.choices.map((c) => <button key={c} type="button" className="pq-choice" disabled={busy} onClick={() => send(c)}>{c}</button>)}
        </div>
      )}
      <form className="pq-own" onSubmit={(e) => e.preventDefault()}>
        <label className="sr-only" htmlFor={field}>Your answer</label>
        <input id={field} className="pq-input" value={text} maxLength={600} disabled={busy}
          placeholder={q.choices.length ? 'Or say it your way' : 'Your answer'}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => {
            if (guardComposing(e)) return
            if (e.key === 'Enter') { e.preventDefault(); send(text) }
          }} />
        <button type="button" className="pq-send" onClick={() => send(text)} disabled={busy || !text.trim()}>{busy ? 'Sending…' : 'Answer'}</button>
      </form>
    </li>
  )
}

export function QuestionCards({ view, answering, onAnswer }: { view: PlanView; answering: string | null; onAnswer: (q: string, text: string) => void }) {
  const open = view.questions.filter((q) => !q.answered)
  const settled = view.questions.filter((q) => q.answered)
  return (
    <section className="pq" aria-label={open.length ? (open.length === 1 ? 'A question for you' : `${open.length} questions for you`) : 'Your answers'}>
      <ul className="pq-list">
        {open.map((q) => <Open key={q.q} q={q} view={view} busy={answering === q.q} onAnswer={(t) => onAnswer(q.q, t)} />)}
        {settled.map((q) => (
          <li key={q.q} className="pq-card" data-settled="">
            <p className="pq-asked">{q.text}</p>
            <p className="pq-said">You said: {q.answered!.text}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}
