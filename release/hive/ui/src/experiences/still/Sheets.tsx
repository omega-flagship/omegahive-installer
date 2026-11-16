import { useShownSwarms } from '../../scene/viewer'
import { m } from 'framer-motion'
import { useDraft } from '../drafts'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Invite, Person } from '../../api/client'
import { creatorLine, goalDrift, isUnsorted, openClassic, ownerLine, PARTIAL_WORDS, progressOf, readContext, seenOf, shown, sortMotivations, STATUS_WORDS, taggedFor, tasksOf, useCountsPartial, useHive, useMotivationData, useRoute, type Goal, type GoalSeen, type Tagged } from '../sdk'
import { useMe } from '../../lib/useAdmin'
import type { SheetKind } from './features'
import { changeGoal, checkNoteFor, GOAL_WORD, recheckGoal, type GoalNote } from './goalChange'
import { stillModal } from './containment'
import { shortIds } from './ident'
import { unsupported } from './intent'
import { ago, beliefSentence, beliefTopic, cap, spell } from './language'
import { asWritten, beliefLine, compareSureness, plainText } from '../../lib/beliefSentence'
import { StillMeter } from './StillMeter'
import { AsWritten, Sureness } from '../../ui/Belief'
import { inkOf, isAwake, useNow, useSprings } from './shared'
import { useModalContainment } from '../../ui/useModalContainment'

/**
 * Sheets: the rest of the hive, read like pages of the same paper. Each is a quiet full page over Still with a way
 * back (Esc, or the link at the top), plain sentences, and the classic page one link away for everything else.
 */
export function Sheet({ kind, onClose, onOpenMind, onLaunch }: { kind: SheetKind; onClose: () => void; onOpenMind: (id: string) => void; onLaunch: () => void }) {
  const sp = useSprings()
  const head = useRef<HTMLHeadingElement>(null)
  const page = useRef<HTMLElement>(null)
  // modal only while Still is in front: a shared page or panel opened from here stays usable (close-home r4)
  const modal = stillModal(useRoute().name)
  useModalContainment(page, { active: modal.active, restoreFocus: modal.restoreFocus })
  useEffect(() => {
    const t = window.setTimeout(() => head.current?.focus({ preventScroll: true }), sp.reduced ? 0 : 200)
    return () => window.clearTimeout(t)
  }, [sp.reduced, kind])
  const T: Record<SheetKind, [string, string]> = {
    create: ['A new mind', 'Name it, give it a home and a budget. Its details can be shaped later.'],
    beliefs: ['Swarms and what they believe', 'Each swarm is a group of minds with one purpose; this is what they hold to be true.'],
    goals: ['Tasks', 'The work your swarms have taken on, where each piece stands, and the motivation it serves.'],
    motivations: ['Motivations', 'Why the work exists: aims held by people, swarms and minds. Tasks are filed under them; one task can serve several.'],
    decided: ['What was decided', 'Every answer given to a mind’s request, and the standing rules that answer for you.'],
    activity: ['Live activity', 'What the hive is doing, as it happens, newest first.'],
    usage: ['Usage and spending', 'What each mind has spent, against what it may spend. Read only.'],
    people: ['People', 'Who can use this hive. Read only; invitations live on the people page.'],
  }
  const [title, sub] = T[kind]
  return (
    <m.section
      ref={page}
      className="st-read st-sheet"
      role="dialog"
      aria-modal={modal.ariaModal}
      aria-labelledby="st-sheet-title"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: sp.reduced ? 0 : 0.2 } }}
      transition={sp.fade}
    >
      <div className="still-paper" style={{ position: 'absolute' }} />
      <div className="st-read-bar">
        <div className="st-read-col">
          <div className="st-read-top">
            <button className="st-back" onClick={onClose}>
              <span aria-hidden style={{ fontSize: 20 }}>←</span> Back to the hive
              <kbd className="st-ask-key st-wide" style={{ marginLeft: 6 }}>
                esc
              </kbd>
            </button>
          </div>
        </div>
      </div>
      <div className="st-read-scroll">
        <div className="st-read-col st-sheet-col">
          <header style={{ paddingTop: 'clamp(24px, 6vh, 64px)' }}>
            <h1 id="st-sheet-title" ref={head} tabIndex={-1} className="st-sheet-title">
              {title}
            </h1>
            <p className="st-read-sub">{sub}</p>
          </header>
          <div className="st-sheet-body">
            {kind === 'create' && <CreateMind onDone={(id) => (onClose(), onOpenMind(id))} />}
            {kind === 'beliefs' && <Beliefs onLaunch={onLaunch} />}
            {kind === 'goals' && <Goals />}
            {kind === 'motivations' && <Motivations />}
            {kind === 'decided' && <Decided />}
            {kind === 'activity' && <Activity onOpenMind={(id) => (onClose(), onOpenMind(id))} />}
            {kind === 'usage' && <Usage />}
            {kind === 'people' && <People />}
          </div>
        </div>
      </div>
    </m.section>
  )
}

const More = ({ children, run }: { children: ReactNode; run: () => void }) => (
  <p className="st-sheet-more">
    <button className="st-link" onClick={run}>
      {children}
    </button>
  </p>
)

// ---------------------------------------------------------------- a new mind

function CreateMind({ onDone }: { onDone: (id: string) => void }) {
  const swarms = useHive((s) => s.swarms)
  const models = useHive((s) => s.models)
  const agents = useHive((s) => s.agents)
  const createAgent = useHive((s) => s.createAgent)
  const list = useShownSwarms()
  const tails = useMemo(() => shortIds(list.map((w) => w.id)), [list])
  const dup = (n: string) => list.filter((w) => shown(w.name).toLowerCase() === n.toLowerCase()).length > 1
  const [name, setName] = useDraft('still:new-mind:name')
  const [swarm, setSwarm] = useState(list[0]?.id ?? '')
  const [model, setModel] = useState(() => models.find((x) => x.id.includes('sonnet'))?.id ?? models.find((x) => !x.local)?.id ?? models[0]?.id ?? '')
  const [budget, setBudget] = useState('10')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const n = name.trim()
  const taken = !!n && Object.values(agents).some((a) => a.name.toLowerCase() === n.toLowerCase())
  const dollars = Number(budget)
  const okBudget = budget.trim() !== '' && Number.isFinite(dollars) && dollars >= 0
  const sw = swarms[swarm]
  const md = models.find((x) => x.id === model)
  const ready = !!n && !taken && !!md && okBudget && !busy
  const make = async () => {
    if (!ready) return
    setBusy(true)
    setErr('')
    try {
      const created = await createAgent({ name: n, kind: 'omega', swarm_id: swarm || null, model, hue: Math.floor(Math.random() * 360), budget_usd: dollars, visibility: 'private' })
      const { token, ...agent } = created
      // its key is shown once, in the hive's own reveal window
      useHive.setState({ reveal: { agent, token } })
      onDone(agent.id)
    } catch (e) {
      setErr(`${n} was not made (${e instanceof Error ? e.message : 'no answer'}). Nothing changed; your choices are still here.`)
      setBusy(false)
    }
  }
  return (
    <form
      className="st-form"
      onSubmit={(e) => {
        e.preventDefault()
        void make()
      }}
    >
      <label className="st-field">
        <span>Its name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nova" autoComplete="off" spellCheck={false} aria-invalid={taken} />
        {taken && <em className="st-field-note">A mind is already called {n}. Choose another name.</em>}
      </label>
      <label className="st-field">
        <span>Its swarm</span>
        <select value={swarm} onChange={(e) => setSwarm(e.target.value)}>
          <option value="">No swarm</option>
          {list.map((w) => (
            <option key={w.id} value={w.id}>
              {shown(w.name)}
              {dup(shown(w.name)) ? ` · #${tails.get(w.id)}` : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="st-field">
        <span>It thinks with</span>
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          {models.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label || x.id}
              {x.local ? ' · local' : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="st-field">
        <span>It may spend up to</span>
        <span className="st-money">
          $<input value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" aria-label="Budget in dollars" />
        </span>
      </label>
      <p className="st-preview" aria-live="polite">
        {n && !taken ? (
          <>
            Make a new mind called <em>{n}</em>
            {sw ? (
              <>
                {' '}in <em>{shown(sw.name)}</em>
              </>
            ) : (
              ', in no swarm'
            )}
            . It will think with {md ? (md.label || md.id) : 'no model'}
            {md?.local ? ' (local, free)' : ''} and may spend up to ${okBudget ? dollars : '?'}. Only you can see it at first.
          </>
        ) : (
          'Give it a name to see exactly what will be made.'
        )}
      </p>
      {err && (
        <p className="st-receipt" data-tone="error" role="alert">
          {err}
        </p>
      )}
      <div className="st-actions">
        <button type="submit" className="st-btn st-btn-yes" disabled={!ready}>
          {busy ? `Making ${n}…` : n ? `Make ${n}` : 'Make it'}
        </button>
        <button type="button" className="st-link" onClick={() => openClassic({ name: 'new', swarm: swarm || undefined })}>
          Persona, role and key: the full flow
        </button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------- swarms and beliefs

function Beliefs({ onLaunch }: { onLaunch: () => void }) {
  const swarms = useHive((s) => s.swarms)
  const agents = useHive((s) => s.agents)
  const beliefs = useHive((s) => s.beliefs)
  const loadBeliefs = useHive((s) => s.loadBeliefs)
  const list = useShownSwarms()
  const [sel, setSel] = useState(list[0]?.id ?? '')
  const [failed, setFailed] = useState<string | null>(null)
  const err = failed === sel
  const now = useNow()
  useEffect(() => {
    if (!sel) return
    void loadBeliefs(sel).then(
      () => setFailed((f) => (f === sel ? null : f)),
      () => setFailed(sel),
    )
  }, [sel, loadBeliefs])
  const w = swarms[sel]
  const held = useMemo(() => Object.values(beliefs[sel] ?? {}).sort((a, b) => compareSureness(b.tv, a.tv)).slice(0, 40), [beliefs, sel])
  if (!list.length)
    return (
      <p className="st-quiet">
        There are no swarms yet.{' '}
        <button className="st-link" onClick={onLaunch}>
          Start one
        </button>
        .
      </p>
    )
  const members = w ? w.member_ids.map((id) => agents[id]).filter(Boolean) : []
  return (
    <div>
      <div className="st-tabs" role="tablist" aria-label="Swarms">
        {list.map((x) => (
          <button key={x.id} role="tab" aria-selected={x.id === sel} className="st-tab" onClick={() => setSel(x.id)}>
            <span className="st-dot" data-state="idle" style={{ ['--c' as string]: inkOf(x.hue) }} aria-hidden>
              <i />
            </span>
            {shown(x.name)}
          </button>
        ))}
        <button className="st-tab st-tab-new" onClick={onLaunch}>
          + Start a swarm
        </button>
      </div>
      {w && (
        <p className="st-sheet-lede">
          <em>{shown(w.name)}</em> has {spell(members.length)} {members.length === 1 ? 'mind' : 'minds'}, {members.filter((a) => isAwake(a)).length ? `${spell(members.filter((a) => isAwake(a)).length)} awake` : 'none awake'}.
          {w.description ? ` ${cap(w.description.replace(/\.?$/, '.'))}` : ''}
        </p>
      )}
      {err ? (
        <p className="st-receipt" data-tone="error" role="alert">
          The beliefs of {shown(w?.name)} could not be read just now.
        </p>
      ) : !held.length ? (
        <p className="st-quiet">{shown(w?.name)} holds no beliefs yet.</p>
      ) : (
        <ol className="st-learned">
          {held.map((b, i) => (
            <li key={b.statement}>
              <span className="st-num" aria-hidden>
                {i + 1}
              </span>
              <button className="st-belief" title={beliefLine(b.statement, b.tv)} onClick={() => openClassic({ name: 'swarm', id: b.swarm_id, statement: b.statement })}>
                {beliefSentence(b)}
              </button>
              <span className="st-byline">
                <StillMeter tv={b.tv} />
                <Sureness tv={b.tv} />
                <span aria-hidden>·</span>
                <span>{ago(b.updated_at, now)}</span>
                <AsWritten text={asWritten(b.statement, b.tv)} />
              </span>
            </li>
          ))}
        </ol>
      )}
      {w && <More run={() => openClassic({ name: 'swarm', id: w.id })}>Everything about {shown(w.name)}: its minds, purpose and settings</More>}
    </div>
  )
}

// ---------------------------------------------------------------- goals

type Change = { id: string; to: Goal['status']; label: string }
/** Review D1: an open confirm holds the goal as it showed it, and when it appeared (for fresh activation). */
type Asking = Change & { seen: GoalSeen; shownAt: number }

function Goals() {
  const swarms = useHive((s) => s.swarms)
  const goals = useHive((s) => s.goals)
  const agents = useHive((s) => s.agents)
  const loadGoals = useHive((s) => s.loadGoals)
  const createGoal = useHive((s) => s.createGoal)
  const unsure = useHive((s) => s.goalsUnsure)
  // Motivations above Tasks: the readable motivations each task serves, and a quiet filter by them (or by none)
  useMotivationData()
  const links = useHive((s) => s.taskLinks)
  const motivations = useHive((s) => s.motivations)
  const [mfilter, setMfilter] = useState<string | null>(null)
  const open = useMemo(() => sortMotivations(Object.values(motivations)).filter((x) => x.status === 'active' || x.status === 'paused'), [motivations])
  const list = useShownSwarms()
  const tails = useMemo(() => shortIds(list.map((w) => w.id)), [list])
  const [ask, setAsk] = useState<Asking | null>(null)
  // why a Yes was held, or (with `note`) what a sent change or a check showed. Check again shows while the store holds the goal unconfirmed
  const [refused, setRefused] = useState<{ id: string; text: string; note?: GoalNote } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [target, setTarget] = useState(list[0]?.id ?? '')
  const [title, setTitle] = useDraft('still:task:title')
  const [anyway, setAnyway] = useState(false)
  const [note, setNote] = useState('')
  const now = useNow()
  const key = list.map((w) => w.id).join(',')
  useEffect(() => {
    for (const id of key.split(',').filter(Boolean)) void loadGoals(id).catch(() => undefined)
  }, [key, loadGoals])

  const change = async (c: Asking, ev: { at: number; repeat?: boolean }) => {
    // the Yes counts only as a fresh activation, and only while the goal is still the one this confirm showed (and
    // not unconfirmed after a lost answer); Review B1: the outcome is worded from writeGoal's kind, never a bare false
    try {
      const r = await changeGoal(c, ev, () => (setAsk(null), setRefused(null), setBusy(c.id)))
      if (r.kind === 'held') setRefused({ id: c.id, text: r.why })
      else setRefused(r.note && { id: c.id, text: r.note.text, note: r.note })
    } finally {
      setBusy(null)
    }
  }
  /** "Check again" after a lost answer: a read only; nothing is sent */
  const recheck = async (n: GoalNote) => {
    setBusy(n.id)
    try {
      const again = await recheckGoal(n)
      setRefused({ id: n.id, text: again.text, note: again })
    } finally {
      setBusy(null)
    }
  }
  const lim = unsupported(title, 'goal')
  const post = async () => {
    const t = title.trim()
    if (!t || !swarms[target] || (lim && !anyway)) return
    setNote('')
    const g = await createGoal(target, { title: t[0].toUpperCase() + t.slice(1) })
    if (g) {
      setTitle('')
      setAnyway(false)
      setNote(`${shown(swarms[target].name)} has a new task: “${g.title}”.`)
    } else setNote('The task could not be made. Nothing changed; your words are still here.')
  }
  const offers = (g: Goal): Change[] => {
    const say = (to: Goal['status'], label: string) => ({ id: g.id, to, label })
    if (g.status === 'done' || g.status === 'failed' || g.status === 'cancelled') return [say('open', 'open it again')]
    if (g.status === 'stalled') return [say('open', 'open it again'), say('done', 'mark it done'), say('cancelled', 'cancel it')]
    return [say('done', 'mark it done'), say('failed', 'mark it failed'), say('cancelled', 'cancel it')]
  }
  const dup = (id: string) => list.filter((w) => shown(w.name).toLowerCase() === shown(swarms[id]?.name).toLowerCase()).length > 1

  return (
    <div>
      {list.length > 0 && (
        <form
          className="st-form st-form-inline"
          onSubmit={(e) => {
            e.preventDefault()
            void post()
          }}
        >
          <label className="st-field">
            <span>A new task for</span>
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              {list.map((w) => (
                <option key={w.id} value={w.id}>
                  {shown(w.name)}
                  {dup(w.id) ? ` · #${tails.get(w.id)}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="st-field st-grow">
            <span>What it is</span>
            <input value={title} onChange={(e) => (setTitle(e.target.value), setAnyway(false))} placeholder="Map the north shore" spellCheck={false} />
          </label>
          {lim && !anyway ? (
            <p className="st-gate-note">
              I can’t make a task wait for a time or a condition yet. “{lim}” would only be words in its title, and it would start now.{' '}
              <button type="button" className="st-link" onClick={() => setAnyway(true)}>
                Make it now anyway, word for word
              </button>
            </p>
          ) : (
            <button type="submit" className="st-btn st-btn-yes st-btn-sm" disabled={!title.trim()}>
              Give it
            </button>
          )}
          {note && (
            <p className="st-receipt" role="status">
              {note}
            </p>
          )}
        </form>
      )}
      {open.length > 0 && (
        <p className="st-goal-acts st-motivation-filter" role="group" aria-label="Which tasks">
          <span className="st-quiet st-small">Showing </span>
          <button className="st-inline-btn" aria-pressed={!mfilter} onClick={() => setMfilter(null)}>
            all
          </button>
          {open.map((x) => (
            <button key={x.id} className="st-inline-btn" aria-pressed={mfilter === x.id} onClick={() => setMfilter(x.id)}>
              for “{x.title}”
            </button>
          ))}
          <button className="st-inline-btn" aria-pressed={mfilter === 'none'} onClick={() => setMfilter('none')}>
            under no motivation
          </button>
        </p>
      )}
      {list.map((w) => {
        const mine = Object.values(goals)
          .filter((g) => g.swarm_id === w.id)
          .filter((g) => !mfilter || (mfilter === 'none' ? isUnsorted(links, g.id) : (links[g.id] ?? []).some((l) => l.id === mfilter)))
          .sort((a, b) => Number(['done', 'cancelled', 'failed'].includes(a.status)) - Number(['done', 'cancelled', 'failed'].includes(b.status)) || b.updated_at.localeCompare(a.updated_at))
        return (
          <section key={w.id} className="st-goal-group" aria-label={`Tasks of ${shown(w.name)}`}>
            <h2 className="st-kicker">{shown(w.name)}</h2>
            {!mine.length ? (
              <p className="st-quiet st-small">{mfilter ? 'None here.' : 'No tasks yet.'}</p>
            ) : (
              <ul className="st-goals">
                {mine.map((g) => {
                  const holder = g.claimed_by ? agents[g.claimed_by] : null
                  const asking = ask?.id === g.id ? ask : null
                  const drift = asking ? goalDrift(asking.seen, g, asking.to) : null
                  const why = drift ?? (refused?.id === g.id ? refused.text : null)
                  return (
                    <li key={g.id} data-status={g.status}>
                      <p className="st-goal-title">{g.title}</p>
                      <p className="st-goal-meta">
                        <span data-tone={g.status === 'stalled' || g.status === 'failed' ? 'warn' : undefined}>{cap(GOAL_WORD[g.status])}</span>
                        {holder ? ` · ${shown(holder.name)} has it` : ''} · {ago(g.updated_at, now)}
                      </p>
                      {(links[g.id] ?? []).length > 0 && (
                        <p className="st-goal-meta st-small" data-motivations>
                          For {(links[g.id] ?? []).map((l) => `“${l.title}”`).join(' and ')}
                        </p>
                      )}
                      {asking ? (
                        <p className="st-confirm" role="group" aria-label="Confirm">
                          {cap(asking.label)}: “{asking.seen.title}”?{' '}
                          <button
                            className="st-inline-btn st-solid"
                            aria-disabled={!!drift}
                            onKeyDown={(e) => {
                              // a held Enter or Space never answers
                              if (e.repeat && (e.key === 'Enter' || e.key === ' ')) {
                                e.preventDefault()
                                void change(asking, { at: performance.now(), repeat: true })
                              }
                            }}
                            onClick={() => void change(asking, { at: performance.now() })}
                          >
                            Yes, {asking.label}
                          </button>
                          <button className="st-inline-btn" onClick={() => (setAsk(null), setRefused(null))}>
                            Keep it
                          </button>
                          {why && (
                            <span className="st-gate-note" role="status">
                              {' '}
                              {why}
                            </span>
                          )}
                        </p>
                      ) : (
                        <p className="st-goal-acts">
                          {busy === g.id ? (
                            <span className="st-quiet st-small">Changing…</span>
                          ) : (
                            offers(g).map((c) => (
                              <button key={c.to} className="st-inline-btn" onClick={() => (setAsk({ ...c, seen: seenOf(g), shownAt: performance.now() }), setRefused(null))}>
                                {c.label}
                              </button>
                            ))
                          )}
                          {refused?.id === g.id && (
                            <span className="st-gate-note" role="status">
                              {' '}
                              {refused.text}
                            </span>
                          )}
                          {unsure[g.id] && busy !== g.id && (
                            <>
                              {' '}
                              <button className="st-inline-btn" onClick={() => void recheck(refused?.id === g.id && refused.note ? refused.note : checkNoteFor(g))}>
                                Check again
                              </button>
                            </>
                          )}
                        </p>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        )
      })}
      <More run={() => openClassic(mfilter ? { name: 'tasks', motivation: mfilter } : { name: 'tasks' })}>Tasks: priorities, details, results, and filing tasks under motivations</More>
    </div>
  )
}

// ---------------------------------------------------------------- motivations: the why above the tasks

/** Read on paper: each motivation, whose it is and who named it, how its tasks stand (each counted once). Changing
 *  one, or filing tasks under it, happens on its classic page. */
function Motivations() {
  const { supported, loaded } = useMotivationData()
  const motivations = useHive((s) => s.motivations)
  const links = useHive((s) => s.taskLinks)
  const goals = useHive((s) => s.goals)
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const { me } = useMe()
  const now = useNow()
  const ctx = { me, agents, swarms }
  const list = useMemo(() => sortMotivations(Object.values(motivations)), [motivations])
  // a read that did not finish: every count here may be short (stand-in P2-4 on 57e64ca)
  const partial = useCountsPartial()
  if (!supported) return <p className="st-quiet">This hive does not keep motivations yet. Tasks work as before.</p>
  if (!loaded) return <p className="st-quiet">Reading…</p>
  return (
    <div>
      {!list.length && <p className="st-quiet">No motivations you can see yet. People, swarm owners and minds name them.</p>}
      <ul className="st-goals">
        {list.map((x) => {
          const ids = tasksOf(x.id, links)
          const p = progressOf(ids, goals)
          return (
            <li key={x.id} data-status={x.status} data-motivation={x.id}>
              <p className="st-goal-title">{x.title}</p>
              {x.why && <p className="st-read-sub st-small">{x.why}</p>}
              <p className="st-goal-meta">
                <span data-tone={x.status === 'paused' ? 'warn' : undefined}>{STATUS_WORDS[x.status]}</span> · {cap(ownerLine(x, ctx))} · {creatorLine(x, ctx)} · {ago(x.created_at, now)}
              </p>
              <p className="st-goal-meta st-small">
                {p.total ? `${p.done} of ${p.total - p.cancelled} task${p.total - p.cancelled === 1 ? '' : 's'} done${p.failed ? `, ${p.failed} failed` : ''}${p.working ? `, ${p.working} being worked on` : ''}` : 'No tasks you can see under it yet.'}
                {partial ? ` (${PARTIAL_WORDS})` : ''}
              </p>
              {ids.length > 0 && (
                <p className="st-goal-meta st-small">
                  {ids
                    .slice(0, 4)
                    .map((id) => goals[id]?.title)
                    .filter(Boolean)
                    .map((t) => `“${t}”`)
                    .join(', ')}
                  {ids.length > 4 ? ` and ${ids.length - 4} more` : ''}
                </p>
              )}
              <p className="st-goal-acts">
                <button className="st-inline-btn" onClick={() => openClassic({ name: 'tasks', motivation: x.id })}>
                  see its tasks
                </button>
                <button className="st-inline-btn" onClick={() => openClassic({ name: 'motivations', id: x.id })}>
                  {x.editable ? 'change it, or file tasks under it' : 'open it'}
                </button>
              </p>
            </li>
          )
        })}
      </ul>
      <More run={() => openClassic({ name: 'motivations' })}>All motivations: make one, change one, file tasks under them</More>
    </div>
  )
}

// ---------------------------------------------------------------- decided and the rules

function Decided() {
  const approvals = useHive((s) => s.approvals)
  const policy = useHive((s) => s.policy)
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const [err, setErr] = useState(false)
  const now = useNow()
  useEffect(() => {
    const h = useHive.getState()
    void h.loadApprovals().catch(() => undefined)
    void h.loadPolicy().catch(() => setErr(true))
  }, [])
  const decided = useMemo(
    () =>
      Object.values(approvals)
        .filter((a) => a.status !== 'pending')
        .sort((a, b) => (b.decided_at ?? b.created_at).localeCompare(a.decided_at ?? a.created_at))
        .slice(0, 40),
    [approvals],
  )
  const who = (by: string | null) => (by ? by.replace(/^user:/, '') : null)
  const word = { approved: 'allowed', used: 'allowed (and used)', denied: 'refused', expired: 'went unanswered', pending: 'waiting' } as const
  const scope = (sc: string) => {
    if (sc === 'hive') return 'Every mind'
    const [k, id] = sc.split(':')
    if (k === 'swarm') return `Minds in ${shown(swarms[id]?.name) || 'a swarm'}`
    return shown(agents[id]?.name) || 'One mind'
  }
  const mode = { allow: 'may use', ask: 'must ask before using', deny: 'may never use' } as const
  return (
    <div>
      <h2 className="st-kicker">Answers</h2>
      {!decided.length ? (
        <p className="st-quiet">Nothing has been decided yet.</p>
      ) : (
        <ul className="st-plain">
          {decided.map((a) => (
            <li key={a.id}>
              <span className="st-dot" data-state={a.status === 'denied' || a.status === 'expired' ? 'asleep' : 'idle'} style={{ ['--c' as string]: a.status === 'denied' ? 'var(--red)' : inkOf(agents[a.agent_id]?.hue ?? 30) }} aria-hidden>
                <i />
              </span>
              <span>
                <em>{shown(agents[a.agent_id]?.name) || 'A mind'}</em> asked to use <code>{a.skill}</code>: {word[a.status]}
                {who(a.decided_by) && a.status !== 'expired' ? ` by ${who(a.decided_by)}` : ''}. <span className="st-when">{ago(a.decided_at ?? a.created_at, now)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <h2 className="st-kicker" style={{ marginTop: 48 }}>
        Standing rules
      </h2>
      {err && !policy ? (
        <p className="st-receipt" data-tone="error" role="alert">
          The rules could not be read just now.
        </p>
      ) : !policy ? (
        <p className="st-quiet">Reading the rules…</p>
      ) : !policy.length ? (
        <p className="st-quiet">No rules: every gated skill asks a person.</p>
      ) : (
        <ul className="st-plain">
          {[...policy]
            .sort((a, b) => a.scope.localeCompare(b.scope))
            .map((r) => (
              <li key={r.id}>
                <span className="st-dot" data-state={r.mode === 'allow' ? 'idle' : 'asleep'} style={{ ['--c' as string]: r.mode === 'deny' ? 'var(--red)' : 'var(--ink-2)' }} aria-hidden>
                  <i />
                </span>
                <span>
                  {scope(r.scope)} {mode[r.mode]} <code>{r.skill}</code>
                  {r.mode === 'allow' ? ' without asking' : ''}.{r.note ? <span className="st-when"> {r.note}</span> : null}
                </span>
              </li>
            ))}
        </ul>
      )}
      <More run={() => openClassic({ name: 'approvals', tab: 'rules' })}>Change the rules</More>
    </div>
  )
}

// ---------------------------------------------------------------- live activity

function Activity({ onOpenMind }: { onOpenMind: (id: string) => void }) {
  const activity = useHive((s) => s.activity)
  const agents = useHive((s) => s.agents)
  const now = useNow(10_000)
  const list = activity.slice(0, 60)
  if (!list.length) return <p className="st-quiet">The hive is quiet. Things will appear here as they happen.</p>
  return (
    <ul className="st-plain" aria-live="polite" aria-relevant="additions">
      {list.map((ev) => {
        const a = ev.agent_id ? agents[ev.agent_id] : null
        return (
          <li key={ev.id}>
            <span className="st-dot" data-state={ev.kind === 'error' ? 'asleep' : 'idle'} style={{ ['--c' as string]: ev.kind === 'error' ? 'var(--red)' : inkOf(a?.hue ?? 30) }} aria-hidden>
              <i />
            </span>
            <span>
              {a ? (
                <button className="st-name st-serif" style={{ fontSize: 'inherit', color: 'var(--ink)' }} onClick={() => onOpenMind(a.id)}>
                  {shown(a.name)}
                </button>
              ) : (
                'The hive'
              )}{' '}
              {plainText(ev.text)}
              {ev.statement ? <span className="st-stmt"> ({beliefTopic(ev.statement)})</span> : null}. <span className="st-when">{ago(ev.at, now)}</span>
              {ev.statement ? <AsWritten text={ev.statement} /> : null}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

// ---------------------------------------------------------------- usage

function Usage() {
  const agents = useHive((s) => s.agents)
  const usage = useHive((s) => s.usage)
  const list = useMemo(() => Object.values(agents).sort((a, b) => b.spent_usd - a.spent_usd), [agents])
  const total = list.reduce((t, a) => t + a.spent_usd, 0)
  const budget = list.reduce((t, a) => t + (a.budget_usd || 0), 0)
  const tokens = useMemo(() => {
    const m = new Map<string, number>()
    for (const u of usage) m.set(u.agent_id, (m.get(u.agent_id) ?? 0) + u.prompt_tokens + u.completion_tokens)
    return m
  }, [usage])
  const near = list.filter((a) => a.budget_usd && a.spent_usd / a.budget_usd > 0.85)
  const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} million` : n >= 1e3 ? `${Math.round(n / 1e3)} thousand` : String(n))
  return (
    <div>
      <p className="st-sheet-lede">
        The hive has spent <strong>${total.toFixed(2)}</strong>
        {budget ? ` of the $${budget.toFixed(0)} its minds may spend` : ''}.
        {list[0] && list[0].spent_usd > 0 ? ` Most of it by ${shown(list[0].name)} ($${list[0].spent_usd.toFixed(2)}).` : ''}
        {near.length ? ` ${near.map((a) => shown(a.name)).join(', ')} ${near.length === 1 ? 'is' : 'are'} close to the limit.` : ''}
      </p>
      <ul className="st-usage">
        {list.map((a) => {
          const frac = a.budget_usd ? Math.min(1, a.spent_usd / a.budget_usd) : 0
          const t = tokens.get(a.id) ?? 0
          return (
            <li key={a.id}>
              <span className="st-usage-name">
                <span className="st-dot" data-state="idle" style={{ ['--c' as string]: inkOf(a.hue) }} aria-hidden>
                  <i />
                </span>
                {shown(a.name)}
              </span>
              <span className="st-usage-bar" aria-hidden>
                <i style={{ transform: `scaleX(${a.budget_usd ? Math.max(0.02, frac) : 0})` }} data-near={frac > 0.85 || undefined} />
              </span>
              <span className="st-usage-num">
                ${a.spent_usd.toFixed(2)}
                <span className="st-when">{a.budget_usd ? ` of $${a.budget_usd}` : ' · no limit'}</span>
              </span>
              {t > 0 && <span className="st-usage-tok">{k(t)} tokens this visit</span>}
            </li>
          )
        })}
      </ul>
      <More run={() => openClassic({ name: 'usage' })}>Spending over time, limits, and settling unknown-cost calls</More>
    </div>
  )
}

// ---------------------------------------------------------------- people

type PeopleRead = { people: Person[]; invites: Invite[] } | 'loading' | 'none' | 'admins' | 'error'

function People() {
  const client = useHive((s) => s.client)
  // Surface K1 audit: the list (or the refusal) belongs to the client it was read through
  const [read, setRead] = useState<Tagged<PeopleRead> | null>(null)
  const state: PeopleRead = taggedFor(read, readContext(client)) ?? 'loading'
  const now = useNow()
  useEffect(() => {
    if (!client?.listPeople) return
    let live = true
    const ctx = readContext(client)
    client.listPeople().then(
      (r) => live && setRead({ ctx, value: { people: r.people, invites: r.invites } }),
      (e: unknown) => live && setRead({ ctx, value: /403|forbidden|admin/i.test(e instanceof Error ? e.message : String(e)) ? 'admins' : 'error' }),
    )
    return () => {
      live = false
    }
  }, [client])
  const go = () => openClassic({ name: 'people' })
  if (!client?.listPeople || state === 'none')
    return (
      <p className="st-quiet">
        This hive does not list its people here. <button className="st-link" onClick={go}>Open the people page</button>.
      </p>
    )
  if (state === 'loading') return <p className="st-quiet">Reading who is here…</p>
  if (state === 'admins') return <p className="st-quiet">Only an admin of this hive can see who is in it.</p>
  if (state === 'error')
    return (
      <p className="st-receipt" data-tone="error" role="alert">
        The member list could not be read just now. <button className="st-link" onClick={go}>Try the people page</button>
      </p>
    )
  const waiting = state.invites.filter((i) => i.status === 'pending')
  return (
    <div>
      <ul className="st-plain">
        {state.people.map((p) => (
          <li key={p.id}>
            <span className="st-dot" data-state={p.disabled ? 'asleep' : 'idle'} style={{ ['--c' as string]: 'var(--ink-2)' }} aria-hidden>
              <i />
            </span>
            <span>
              <em>{p.name || p.email}</em>
              {p.role === 'admin' ? ', an admin' : ''}
              {p.disabled ? ', switched off' : p.last_seen_at ? `, last here ${ago(p.last_seen_at, now)}` : ', not here yet'}. <span className="st-when">{p.email}</span>
            </span>
          </li>
        ))}
        {waiting.map((i) => (
          <li key={i.id}>
            <span className="st-dot" data-state="asleep" style={{ ['--c' as string]: 'var(--ink-3)' }} aria-hidden>
              <i />
            </span>
            <span>
              <em>{i.name || i.email}</em> is invited and has not accepted yet. <span className="st-when">{i.email}</span>
            </span>
          </li>
        ))}
      </ul>
      <More run={go}>Invite someone, or change who can use the hive</More>
    </div>
  )
}
