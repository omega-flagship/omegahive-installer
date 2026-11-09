import { useEffect, useRef, useState } from 'react'
import { useAskStore } from '../store/ask'
import type { AskEvent } from '../api/ask'

/**
 * The Ask's own Omega: what your mind is doing, from the Ask's real frames (read only, never written), shown by its
 * mark in the language of the look it is in. Which effect each activity has in each look is MeTTa's
 * (omega-mark.metta `ask-shows`, evaluated by PeTTa into brand/rules.json `ask`). Decoration only: the words say it.
 */
export type AskActivity = 'typing' | 'thinking' | 'answering' | 'finding' | 'writing' | 'making' | 'building' | 'waiting' | 'approved' | 'failed' | 'changed'

/** The activity one frame means, or null (pure). An act's kind is resolved through MeTTa's `ask-act` table. */
export function activityOf(e: AskEvent, acts: Record<string, string>): AskActivity | null {
  switch (e.phase) {
    case 'accepted': case 'thinking': return 'thinking'
    case 'answer': return 'answering'
    case 'act': return e.act.kind === 'unreadable' ? null : ((acts[e.act.kind] as AskActivity | undefined) ?? 'thinking')
    case 'dispatched': return /build|code/i.test(e.intent_kind) ? 'building' : /make|create|draft|write/i.test(e.intent_kind) ? 'making' : 'finding'
    case 'action-needs-confirm': return 'waiting'
    case 'ui-change': return 'changed'
    case 'refused': return 'failed'
    case 'done': return e.outcome && e.outcome !== 'complete' && e.outcome !== 'cancelled' ? 'failed' : null
    default: return null
  }
}

/** The confirmations you have approved on a turn (store/ask confirmAct records them as outcomes) that are not yet in
 *  `seen`; adds them to it (pure apart from `seen`). The Ask's frames carry no approval of their own: this is its source. */
export function freshApprovals(outcomes: Record<number, { kind?: string; state?: string }>, seen: Set<number>): number[] {
  const out: number[] = []
  for (const [seq, o] of Object.entries(outcomes)) if (o.kind === 'confirm' && o.state === 'confirmed' && !seen.has(+seq)) { seen.add(+seq); out.push(+seq) }
  return out
}

interface AskRules { shows: Record<string, Record<string, string>>; acts: Record<string, string>; behaves?: Record<string, Record<string, string>> }
let rules: Promise<AskRules | null> | null = null
const loadRules = () => (rules ??= fetch(`${import.meta.env.BASE_URL}brand/rules.json`).then((r) => r.json()).then((j: { ask?: AskRules }) => j.ask ?? null).catch(() => null))

/** `pulse`: a one-off (a material's behaviour, or else a style's particles); `hold`: a behaviour held while a state lasts. */
export interface AskMarkSignal { presence: 'idle' | 'listening' | 'speaking'; level: number; pulse: { kind: 'behave' | 'style'; name: string; key: string } | null; hold: string | null }

/** The signal for the Ask's living mark in `env` (an experience id), while `typing` says the person is writing to it. */
export function useAskMark(env: string, typing: boolean): AskMarkSignal {
  const [ask, setAsk] = useState<AskRules | null>(null)
  const [pulse, setPulse] = useState<AskMarkSignal['pulse']>(null)
  const [speakingUntil, setSpeakingUntil] = useState(0)
  // a cursor into the open turn: frames already read, and approvals already shown (no rescan of the history)
  const seen = useRef<{ op: string | null; n: number; approved: Set<number> }>({ op: null, n: 0, approved: new Set() })
  const open = useAskStore((s) => (s.open ? s.turns[s.open] : undefined))
  const waiting = useAskStore((s) => s.confirm !== null)
  useEffect(() => { let live = true; void loadRules().then((r) => { if (live) setAsk(r) }); return () => { live = false } }, [])
  useEffect(() => {
    if (!open || !ask) return
    if (seen.current.op !== open.op) seen.current = { op: open.op, n: 0, approved: new Set() }
    const shows = ask.shows[env] ?? ask.shows.brand ?? {}, behaves = ask.behaves?.[env] ?? {}
    const show = (a: AskActivity, key: string) => {
      const style = shows[a]
      if (style === 'speaking') setSpeakingUntil(performance.now() + 700)
      else if (a === 'waiting' || a === 'typing') return                                      // held states, below
      else if (behaves[a]) setPulse({ kind: 'behave', name: behaves[a], key })                // the material's own behaviour
      else if (style && style !== 'listening') setPulse({ kind: 'style', name: style, key })
    }
    // you approved: the Ask records a confirmed outcome on the turn (store/ask confirmAct)
    for (const seq of freshApprovals(open.outcomes, seen.current.approved)) show('approved', `${open.op}:ok:${seq}`)
    const fresh = open.events.slice(seen.current.n)
    if (!fresh.length) return
    seen.current.n = open.events.length
    for (const e of fresh) {
      const a = activityOf(e, ask.acts); if (a) show(a, `${open.op}:${e.seq}`)                   // keyed by turn and seq: equal seqs across turns still pulse
    }
  }, [open, ask, env])
  const speaking = speakingUntil > performance.now()
  useEffect(() => { if (!speaking) return; const t = window.setTimeout(() => setSpeakingUntil(0), Math.max(0, speakingUntil - performance.now())); return () => window.clearTimeout(t) }, [speaking, speakingUntil])
  const behaves = ask?.behaves?.[env] ?? {}
  const hold = speaking ? behaves.answering ?? null : waiting ? behaves.waiting ?? null : typing ? behaves.typing ?? null : null
  return { presence: speaking ? 'speaking' : typing || waiting ? 'listening' : 'idle', level: speaking ? .7 : 1, pulse, hold }
}
