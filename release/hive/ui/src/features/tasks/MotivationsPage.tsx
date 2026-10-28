import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { Person } from '../../api/client'
import type { Goal, Motivation, MotivationStatus, Visibility } from '../../api/types'
import { cx } from '../../lib/cx'
import { shown } from '../../lib/displayName'
import { ago } from '../../lib/format'
import { useNow } from '../../lib/hooks'
import {
  atLeast,
  changeLinks,
  createBody,
  createMotivation,
  createRights,
  creatorLine,
  editMotivation,
  isUnsorted,
  linkable,
  LINK_MEANS,
  normalPeople,
  ownerKind,
  ownerLine,
  PARTIAL_WORDS,
  progressOf,
  radioProps,
  readMotivationTasks,
  saveDraft,
  setMotivationVisibility,
  sortMotivations,
  STATUS_ORDER,
  STATUS_WORDS,
  tasksOf,
  useCountsPartial,
  useMotivationData,
  VISIBILITY_CHOICES,
  VISIBILITY_WORDS,
  visibilityProblem,
  WORDS,
  type Progress,
} from '../../lib/motivations'
import { navigate } from '../../lib/router'
import { useMe } from '../../lib/useAdmin'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { Page } from '../../ui/Page'
import { Button, EmptyState, Skeleton } from '../../ui/primitives'
import { GoalsBoard } from '../goals/GoalsBoard'
import { EVOLVE_ID, EvolveObjectiveCard, EvolveObjectiveDetail } from './EvolveObjective'

/** #/motivations[/id]: the why above the work. A list grouped by whose it is, a way to make one, and one in full. */
export default function MotivationsPage({ id }: { id?: string }) {
  if (id === EVOLVE_ID) return <EvolveObjectiveDetail />
  return id ? <MotivationDetail id={id} /> : <MotivationList />
}

function useNames() {
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const { me } = useMe()
  return { me, ctx: { me, agents, swarms } }
}

// ---------------------------------------------------------------- the list

function MotivationList() {
  const { supported, loaded } = useMotivationData()
  const motivations = useHive((s) => s.motivations)
  const links = useHive((s) => s.taskLinks)
  const goals = useHive((s) => s.goals)
  const swarms = useHive((s) => s.swarms)
  const { me, ctx } = useNames()
  const [making, setMaking] = useState(false)
  const rights = createRights(me, swarms)
  const mayMake = rights.personal.may || rights.teams.length > 0
  const groups = useMemo(() => {
    const all = sortMotivations(Object.values(motivations))
    const mine = all.filter((m) => me && m.owner === me.principal)
    const rest = all.filter((m) => !mine.includes(m))
    return [
      { key: 'mine', label: 'Yours', items: mine },
      { key: 'team', label: 'Swarms', items: rest.filter((m) => ownerKind(m.owner) === 'team') },
      { key: 'mind', label: 'Named by minds', items: rest.filter((m) => ownerKind(m.owner) === 'mind') },
      { key: 'people', label: 'Shared with you', items: rest.filter((m) => ownerKind(m.owner) === 'person') },
    ].filter((g) => g.items.length)
  }, [motivations, me])
  const partial = useHive((s) => s.motivationsPartial || s.taskLinksPartial)
  const unsorted = useMemo(() => Object.values(goals).filter((g) => isUnsorted(links, g.id) && g.status !== 'done' && g.status !== 'cancelled' && g.status !== 'failed').length, [goals, links])

  return (
    <Page
      label={WORDS.motivations}
      eyebrow="The why"
      title={WORDS.motivations}
      info="motivations"
      actions={
        mayMake && supported ? (
          <Button variant="primary" icon="plus" onClick={() => setMaking(true)} className="min-h-10 px-3.5">
            New motivation
          </Button>
        ) : undefined
      }
    >
      <div className="mx-auto w-full max-w-5xl space-y-5 px-3 pb-[calc(var(--sab)+92px)] md:px-6 md:pb-8">
        <p className="max-w-2xl text-[14px] leading-relaxed text-ink-2">
          Motivations are why the work exists: aims held by a person, a swarm or a mind. <button type="button" onClick={() => navigate({ name: 'tasks' })} className="text-accent hover:text-ink">Tasks</button> are the work itself, filed under them; one task can serve several, and counts once.
        </p>
        {making && <CreateMotivation onDone={(m) => (setMaking(false), m && navigate({ name: 'motivations', id: m.id }))} />}
        <EvolveObjectiveCard />
        {!supported ? (
          <EmptyState icon="target" title="Not on this hive yet" body="This hive does not keep motivations yet. Tasks work as before." />
        ) : !loaded ? (
          <div className="grid gap-3 md:grid-cols-2">
            <Skeleton className="h-36 rounded-[20px]" />
            <Skeleton className="h-36 rounded-[20px]" />
          </div>
        ) : groups.length === 0 ? (
          <EmptyState icon="target" title="No motivations yet" body={mayMake ? 'Name the first one: what is all this work for?' : 'None you can see yet. People, swarm owners and minds name them.'} />
        ) : (
          groups.map((g) => (
            <section key={g.key} aria-labelledby={`mot-${g.key}`} className="space-y-2">
              <h2 id={`mot-${g.key}`} className="font-display text-[13px] font-semibold tracking-wide text-ink-3">
                {g.label} <span className="font-mono text-ink-4">{g.items.length}</span>
              </h2>
              <div className="grid gap-3 md:grid-cols-2">
                {g.items.map((m) => (
                  <MotivationCard key={m.id} m={m} progress={progressOf(tasksOf(m.id, links), goals)} partial={partial} ctx={ctx} />
                ))}
              </div>
            </section>
          ))
        )}
        {supported && loaded && partial && (
          <p role="status" className="text-[12.5px] text-ink-3" data-partial>
            The hive did not finish listing everything, so these counts may be short. Tasks it did not reach are not counted as under no motivation.
          </p>
        )}
        {supported && loaded && (
          <button type="button" onClick={() => navigate({ name: 'tasks', motivation: 'none' })} className="flex min-h-11 w-full items-center gap-2 rounded-2xl border border-dashed border-line px-4 text-left text-[13px] text-ink-3 hover:text-ink-2" data-unsorted>
            <Icon name="columns" size={14} />
            {unsorted} live task{unsorted === 1 ? ' is' : 's are'} under no motivation you can see
            {unsorted > 0 && <span className="ml-auto text-accent">Sort these →</span>}
          </button>
        )}
      </div>
    </Page>
  )
}

function MotivationCard({ m, progress, partial, ctx }: { m: Motivation; progress: Progress; partial: boolean; ctx: ReturnType<typeof useNames>['ctx'] }) {
  const now = useNow(60_000)
  return (
    <button
      type="button"
      onClick={() => navigate({ name: 'motivations', id: m.id })}
      data-motivation={m.id}
      className={cx('flex flex-col gap-2 rounded-[20px] border bg-white/[0.03] p-4 text-left transition-colors hover:border-line-2 hover:bg-white/[0.05]', m.status === 'active' ? 'border-line' : 'border-line opacity-80')}
    >
      <div className="flex items-start gap-2">
        <Icon name="target" size={16} className="mt-0.5 shrink-0 text-accent" />
        <h3 className="min-w-0 flex-1 text-[15px] leading-snug font-semibold text-ink">{m.title}</h3>
        <StatusPill status={m.status} />
      </div>
      {m.why && <p className="line-clamp-2 text-[13px] leading-relaxed text-ink-2">{m.why}</p>}
      <ProgressBar p={progress} partial={partial} />
      <p className="text-[11.5px] text-ink-3">
        {ownerLine(m, ctx)} · {creatorLine(m, ctx)} · {ago(m.created_at, now)}
      </p>
    </button>
  )
}

function StatusPill({ status }: { status: MotivationStatus }) {
  const color = status === 'active' ? '#4ade80' : status === 'paused' ? '#f5c06b' : status === 'achieved' ? '#a5b4fc' : '#8a89b3'
  return (
    <span className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ color, background: `${color}1a` }}>
      {STATUS_WORDS[status]}
    </span>
  )
}

/** Tasks under it, each counted once: done of (all but cancelled), so failures show. `partial`: the reads behind these
 *  counts did not finish, so they are said to be possibly short (stand-in P2-4 on 57e64ca). */
function ProgressBar({ p, partial = false }: { p: Progress; partial?: boolean }) {
  if (!p.total)
    return (
      <p className="text-[12px] text-ink-4" data-progress-partial={partial || undefined}>
        {partial ? `No tasks found under it yet; this ${PARTIAL_WORDS}` : 'No tasks you can see under it yet'}
      </p>
    )
  const base = Math.max(1, p.total - p.cancelled)
  const seg = [
    { n: p.done, c: '#4ade80', label: 'done' },
    { n: p.review, c: '#a78bfa', label: 'awaiting review' },
    { n: p.working, c: '#7dd3fc', label: 'in progress' },
    { n: p.open, c: '#a5b4fc', label: 'open' },
    { n: p.failed, c: '#fb7185', label: 'failed' },
  ]
  return (
    <div className="space-y-1" data-progress>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-white/[0.06]" role="img" aria-label={seg.filter((s) => s.n).map((s) => `${s.n} ${s.label}`).join(', ')}>
        {seg.map((s) => (s.n ? <span key={s.label} style={{ width: `${(s.n / base) * 100}%`, background: s.c }} /> : null))}
      </div>
      <p className="text-[12px] text-ink-3">
        {p.done} of {p.total - p.cancelled} task{p.total - p.cancelled === 1 ? '' : 's'} done
        {p.failed ? ` · ${p.failed} failed` : ''}
        {p.review ? ` · ${p.review} awaiting review` : ''}
        {p.cancelled ? ` · ${p.cancelled} cancelled, not counted` : ''}
        {partial && <span data-progress-partial> · {PARTIAL_WORDS}</span>}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------- make one (owner Q6: a person their own; a team's owner or an admin a team's)

function CreateMotivation({ onDone }: { onDone: (m: Motivation | null) => void }) {
  const swarms = useHive((s) => s.swarms)
  const { me } = useMe()
  const rights = createRights(me, swarms)
  const [title, setTitle] = useState('')
  const [why, setWhy] = useState('')
  // whose: 'me' (across teams), 'me:<swarm>' (mine, in one team), 'team:<swarm>'
  // the default follows who this person turns out to be (signed-in state can arrive after the form opens); a pick stays
  const [picked, setWhose] = useState<string | null>(null)
  const whose = picked ?? (rights.personal.may ? 'me' : rights.teams[0] ? `team:${rights.teams[0].id}` : '')
  const team = whose.startsWith('team:')
  const [visibility, setVisibility] = useState<Visibility | null>(null)
  const vis: Visibility = visibility ?? (team ? 'public' : 'private')
  // the people it is shared with, when shared (stand-in P2-3 on 57e64ca: shared is a real choice, never made private)
  const [people, setPeople] = useState<string[]>([])
  const problem = visibilityProblem(vis, people)
  const [busy, setBusy] = useState(false)
  const [why2, setWhy2] = useState<string | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!title.trim() || busy || !whose || problem) return
    setBusy(true)
    setWhy2(null)
    const r = await createMotivation(createBody({ title, why, whose, visibility: vis, sharedWith: people }))
    setBusy(false)
    if (r.ok) onDone(r.value)
    else setWhy2(r.why)
  }
  const field = 'w-full rounded-xl border border-line bg-black/25 px-3 text-[14px] text-ink outline-none placeholder:text-ink-4 focus:border-line-2'
  return (
    <form onSubmit={submit} className="space-y-3 rounded-[20px] border border-line-2 bg-white/[0.04] p-4" aria-label="New motivation" data-create-motivation>
      <label className="block space-y-1">
        <span className="text-[12px] text-ink-3">What is it for?</span>
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Know the variable sky well enough to predict it" className={cx(field, 'min-h-11')} />
      </label>
      <label className="block space-y-1">
        <span className="text-[12px] text-ink-3">Why, in your words (optional)</span>
        <textarea value={why} onChange={(e) => setWhy(e.target.value)} maxLength={4000} rows={3} className={cx(field, 'py-2 leading-relaxed')} />
      </label>
      <div className="flex flex-wrap gap-3">
        <label className="space-y-1">
          <span className="block text-[12px] text-ink-3">Whose is it?</span>
          <select value={whose} onChange={(e) => (setWhose(e.target.value), setVisibility(null))} className={cx(field, 'min-h-10 w-auto')}>
            <option value="me" disabled={!rights.personal.may}>
              Mine, across swarms
            </option>
            {Object.values(swarms)
              .filter((s) => !s.archived_at)
              .map((s) => (
                <option key={`me:${s.id}`} value={`me:${s.id}`} disabled={!rights.personal.may}>
                  Mine, in {shown(s.name)}
                </option>
              ))}
            {rights.teams.map((s) => (
              <option key={`team:${s.id}`} value={`team:${s.id}`}>
                {shown(s.name)}’s, as a swarm
              </option>
            ))}
          </select>
        </label>
        <fieldset className="space-y-1">
          <legend className="text-[12px] text-ink-3">Who can see it</legend>
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Who can see it">
            {VISIBILITY_CHOICES.map((v) => (
              <button key={v} type="button" {...radioProps(v, VISIBILITY_CHOICES, vis, setVisibility)} role="radio" onClick={() => setVisibility(v)} className={cx('min-h-10 rounded-xl border px-3 text-[12.5px]', vis === v ? 'border-line-2 bg-white/[0.08] text-ink' : 'border-line text-ink-3')}>
                {VISIBILITY_WORDS[v][team ? 'team' : 'personal']}
              </button>
            ))}
          </div>
        </fieldset>
      </div>
      {vis === 'shared' && <PeoplePicker value={people} onChange={setPeople} />}
      {vis === 'shared' && problem && <p className="text-[12px] text-ink-3">{problem}</p>}
      {!rights.personal.may && rights.personal.why && <p className="text-[12px] text-ink-3">{rights.personal.why}</p>}
      {why2 && (
        <p role="alert" className="text-[12.5px] text-bad">
          {why2}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={!title.trim() || busy || !whose || !!problem} className="min-h-10">
          {busy ? 'Making…' : 'Make it'}
        </Button>
        <Button type="button" variant="ghost" onClick={() => onDone(null)} className="min-h-10">
          Not now
        </Button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------- one motivation

function MotivationDetail({ id }: { id: string }) {
  const { supported, loaded } = useMotivationData()
  const m = useHive((s) => s.motivations[id])
  const links = useHive((s) => s.taskLinks)
  const goals = useHive((s) => s.goals)
  const linksSeq = useHive((s) => s.linksSeq)
  const { ctx } = useNames()
  const now = useNow(60_000)
  const [read, setRead] = useState<'reading' | 'read' | 'gone'>('reading')
  // whether this view's own read of its tasks finished (false: the counts below may be short)
  const [detailComplete, setDetailComplete] = useState(true)
  const storePartial = useCountsPartial()
  const partial = storePartial || !detailComplete
  // the hive's own answer for this motivation's tasks (GET /api/tasks?motivation=…), again after every link change
  useEffect(() => {
    if (!supported) return
    let alive = true
    // the read takes a generation: refs to a motivation found revoked after it began never come back (stand-in P1-2 on 57e64ca)
    readMotivationTasks(id).then(
      (read) => {
        if (!alive || !read) return
        setDetailComplete(read.complete)
        setRead('read')
      },
      () => alive && setRead('gone'),
    )
    return () => {
      alive = false
    }
  }, [id, supported, linksSeq])

  const ids = useMemo(() => new Set(tasksOf(id, links)), [id, links])
  const progress = useMemo(() => progressOf(ids, goals), [ids, goals])
  const only = useMemo(() => (g: Goal) => ids.has(g.id), [ids])

  if (!supported) return <Missing title="Not on this hive yet" body="This hive does not keep motivations yet." />
  if (!m && (read === 'gone' || (loaded && read === 'read'))) return <Missing title="Not there for you" body="This motivation is not there for you: it may have been made private, or it no longer exists." />
  if (!m)
    return (
      <Page label={WORDS.motivation} eyebrow={WORDS.motivations} title="…">
        <div className="mx-auto max-w-5xl space-y-3 px-3 md:px-6">
          <Skeleton className="h-24 rounded-[20px]" />
          <Skeleton className="h-48 rounded-[20px]" />
        </div>
      </Page>
    )
  return (
    <Page label={m.title} eyebrow={WORDS.motivation} title={m.title} info="motivations" onClose={() => navigate({ name: 'motivations' })}>
      <div className="mx-auto w-full max-w-5xl space-y-5 px-3 pb-[calc(var(--sab)+92px)] md:px-6 md:pb-8" data-motivation-detail={m.id}>
        <section className="space-y-3 rounded-[22px] border border-line bg-white/[0.03] p-4 md:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={m.status} />
            <span className="text-[12px] text-ink-3">
              {ownerLine(m, ctx)} · {creatorLine(m, ctx)} · {ago(m.created_at, now)}
            </span>
          </div>
          <EditableText m={m} />
          <ProgressBar p={progress} partial={partial} />
          <dl className="grid gap-x-6 gap-y-2 text-[12.5px] md:grid-cols-2">
            <div>
              <dt className="text-ink-4">Who can see it</dt>
              <dd className="text-ink-2">
                {VISIBILITY_WORDS[m.visibility][ownerKind(m.owner) === 'person' ? 'personal' : 'team']}
                {m.visibility === 'shared' && m.shared_with?.length ? <span data-shared-with={m.shared_with.join(' ')}>: {m.shared_with.map((p) => p.replace(/^user:/, '')).join(', ')}</span> : ''}
              </dd>
            </div>
            <div>
              <dt className="text-ink-4">Budgets and spend</dt>
              <dd className="text-ink-3">The hive reports these per motivation in its next phase, budgets and spend kept apart. Nothing is estimated here.</dd>
            </div>
          </dl>
          {m.editable && <Controls m={m} />}
        </section>
        <section className="space-y-2" aria-labelledby="mot-tasks-h">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="mot-tasks-h" className="font-display text-[14px] font-semibold text-ink-2">
              Tasks under it{' '}
              <span className="font-mono text-ink-4" title={partial ? PARTIAL_WORDS : undefined} data-count-partial={partial || undefined}>
                {atLeast(ids.size, partial)}
              </span>
            </h2>
            {partial && <span className="text-[12px] text-ink-3">({PARTIAL_WORDS})</span>}
            <button type="button" onClick={() => navigate({ name: 'tasks', motivation: m.id })} className="text-[12.5px] text-accent hover:text-ink">
              Open in Tasks →
            </button>
          </div>
          {m.editable && linkable(m) && <FileTasks m={m} linked={ids} />}
          <GoalsBoard key={m.id} only={only} layout="list" addUnder={m} />
        </section>
      </div>
    </Page>
  )
}

function Missing({ title, body }: { title: string; body: string }) {
  return (
    <Page label={WORDS.motivation} eyebrow={WORDS.motivations} title={WORDS.motivation} onClose={() => navigate({ name: 'motivations' })}>
      <EmptyState icon="target" title={title} body={body} action={<Button onClick={() => navigate({ name: 'motivations' })}>All motivations</Button>} />
    </Page>
  )
}

/** Its why, editable in place by whoever may edit it, against the revision they saw. */
function EditableText({ m }: { m: Motivation }) {
  const [editing, setEditing] = useState(false)
  // the motivation as it was when editing began: Save goes against this revision, never the live one (stand-in P1-2)
  const [seen, setSeen] = useState<Motivation>(m)
  const [title, setTitle] = useState(m.title)
  const [why, setWhy] = useState(m.why)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  if (!editing)
    return (
      <div className="space-y-1">
        {m.why ? <p className="max-w-3xl text-[14.5px] leading-relaxed whitespace-pre-wrap text-ink">{m.why}</p> : <p className="text-[13px] text-ink-4">No why written yet.</p>}
        {m.editable && (
          <button type="button" onClick={() => (setSeen(m), setTitle(m.title), setWhy(m.why), setErr(null), setEditing(true))} className="inline-flex min-h-8 items-center gap-1 text-[12.5px] text-accent hover:text-ink">
            <Icon name="edit" size={12} /> Edit the words
          </button>
        )}
      </div>
    )
  const save = async () => {
    setBusy(true)
    const r = await saveDraft(seen, { title, why })
    setBusy(false)
    if (r.ok) setEditing(false)
    else setErr(r.why)
  }
  const changedMeanwhile = m.id === seen.id && m.rev !== seen.rev
  const field = 'w-full rounded-xl border border-line bg-black/25 px-3 text-[14px] text-ink outline-none focus:border-line-2'
  return (
    <div className="space-y-2">
      <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} aria-label="Title" className={cx(field, 'min-h-10')} />
      <textarea value={why} onChange={(e) => setWhy(e.target.value)} maxLength={4000} rows={4} aria-label="Why" className={cx(field, 'py-2')} />
      {changedMeanwhile && !err && (
        <p role="status" className="text-[12.5px] text-ink-2" data-changed-meanwhile>
          Someone changed this motivation since you began editing. Saving will not overwrite their change: the hive will refuse it, and you can look again first.
        </p>
      )}
      {err && (
        <p role="alert" className="text-[12.5px] text-bad">
          {err}
        </p>
      )}
      <div className="flex gap-2">
        <Button variant="primary" disabled={busy || !title.trim()} onClick={() => void save()} className="min-h-9">
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="ghost" onClick={() => setEditing(false)} className="min-h-9">
          Cancel
        </Button>
      </div>
    </div>
  )
}

/** Status and who can see it, for whoever may edit it. Status never touches a task (it is presentational). */
function Controls({ m }: { m: Motivation }) {
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async (p: Promise<{ ok: boolean; why?: string }>) => {
    setBusy(true)
    setErr(null)
    const r = await p
    setBusy(false)
    if (!r.ok) setErr(r.why ?? 'Not changed.')
  }
  const kind = ownerKind(m.owner) === 'person' ? 'personal' : 'team'
  // choosing or changing the people it is shared with: saved against the motivation as it was when opened
  const [sharing, setSharing] = useState<{ seen: Motivation; people: string[] } | null>(null)
  const openSharing = () => setSharing({ seen: m, people: m.visibility === 'shared' ? normalPeople(m.shared_with ?? []) : [] })
  const saveSharing = async () => {
    if (!sharing) return
    setBusy(true)
    setErr(null)
    const r = await setMotivationVisibility(sharing.seen, 'shared', sharing.people)
    setBusy(false)
    if (r.ok) setSharing(null)
    else setErr(r.why)
  }
  return (
    <div className="flex flex-wrap items-end gap-4 border-t border-line pt-3">
      <div className="space-y-1">
        <span className="block text-[12px] text-ink-4">Status</span>
        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Status">
          {STATUS_ORDER.map((st) => (
            <button key={st} type="button" {...radioProps(st, STATUS_ORDER, m.status, () => undefined, 'focus')} role="radio" disabled={busy} onClick={() => st !== m.status && void run(editMotivation(m, { status: st }))} className={cx('min-h-9 rounded-xl border px-3 text-[12.5px]', m.status === st ? 'border-line-2 bg-white/[0.08] text-ink' : 'border-line text-ink-3 hover:text-ink-2')}>
              {STATUS_WORDS[st]}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-1">
        <span className="block text-[12px] text-ink-4">Who can see it</span>
        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Who can see it">
          {VISIBILITY_CHOICES.map((v) => (
            <button
              key={v}
              type="button"
              {...radioProps(v, VISIBILITY_CHOICES, m.visibility, () => undefined, 'focus')}
              role="radio"
              disabled={busy}
              onClick={() => (v === 'shared' ? openSharing() : v !== m.visibility && void run(setMotivationVisibility(m, v)))}
              className={cx('min-h-9 rounded-xl border px-3 text-[12.5px]', m.visibility === v ? 'border-line-2 bg-white/[0.08] text-ink' : 'border-line text-ink-3 hover:text-ink-2')}
            >
              {VISIBILITY_WORDS[v][kind]}
            </button>
          ))}
          {m.visibility === 'shared' && !sharing && (
            <button type="button" disabled={busy} onClick={openSharing} className="min-h-9 rounded-xl px-2 text-[12.5px] text-accent hover:text-ink" data-edit-people>
              Change who
            </button>
          )}
        </div>
      </div>
      {sharing && (
        <div className="basis-full space-y-2 rounded-[16px] border border-line bg-black/20 p-3" role="group" aria-label="Who it is shared with" data-sharing>
          <PeoplePicker value={sharing.people} onChange={(people) => setSharing({ ...sharing, people })} />
          {visibilityProblem('shared', sharing.people) && <p className="text-[12px] text-ink-3">{visibilityProblem('shared', sharing.people)}</p>}
          <div className="flex gap-2">
            <Button variant="primary" disabled={busy || !!visibilityProblem('shared', sharing.people)} onClick={() => void saveSharing()} className="min-h-9">
              {busy ? 'Saving…' : 'Share with these people'}
            </Button>
            <Button variant="ghost" onClick={() => setSharing(null)} className="min-h-9">
              Cancel
            </Button>
          </div>
        </div>
      )}
      <p className="basis-full text-[11.5px] text-ink-4">Status is for people: it never pauses, cancels or reassigns a task. There is no delete; Retired is the end.</p>
      {err && (
        <p role="alert" className="basis-full text-[12.5px] text-bad">
          {err}
        </p>
      )}
    </div>
  )
}

/** File tasks under it: pick from the tasks in its scope this person can see; their subtasks come along when asked. */
function FileTasks({ m, linked }: { m: Motivation; linked: Set<string> }) {
  const goals = useHive((s) => s.goals)
  const swarms = useHive((s) => s.swarms)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [withSubs, setWithSubs] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const candidates = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return Object.values(goals)
      .filter((g) => !g.parent_id && !linked.has(g.id) && (!m.swarm_id || g.swarm_id === m.swarm_id) && !swarms[g.swarm_id]?.archived_at && (!needle || g.title.toLowerCase().includes(needle)))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, 60)
  }, [goals, linked, m.swarm_id, swarms, q])
  const hasSubs = [...picked].some((id) => Object.values(goals).some((g) => g.parent_id === id))
  const file = async () => {
    setBusy(true)
    setMsg(null)
    const r = await changeLinks(m, 'link', [...picked], hasSubs && withSubs)
    setBusy(false)
    if (r.ok) {
      setMsg({ tone: 'ok', text: `Filed ${r.value.applied.length} task${r.value.applied.length === 1 ? '' : 's'} under it${r.value.unchanged.length ? ` (${r.value.unchanged.length} already were)` : ''}.` })
      setPicked(new Set())
    } else setMsg({ tone: 'bad', text: r.why })
  }
  if (!open)
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button icon="plus" onClick={() => setOpen(true)} className="min-h-9 px-3 text-[13px]">
          File tasks under it
        </Button>
        {msg && <span className={cx('text-[12.5px]', msg.tone === 'ok' ? 'text-good' : 'text-bad')}>{msg.text}</span>}
      </div>
    )
  return (
    <div className="space-y-2 rounded-[18px] border border-line bg-black/20 p-3" role="group" aria-label="File tasks under this motivation">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a task…" aria-label="Find a task" className="min-h-9 w-full rounded-xl border border-line bg-black/25 px-3 text-[13px] text-ink outline-none" />
      <ul className="max-h-60 space-y-px overflow-y-auto">
        {candidates.length === 0 && <li className="px-2 py-2 text-[12.5px] text-ink-3">No other tasks {m.swarm_id ? `in ${shown(swarms[m.swarm_id]?.name) || 'its swarm'}` : ''} to file.</li>}
        {candidates.map((g) => (
          <li key={g.id}>
            <label className="flex min-h-9 items-center gap-2 rounded-lg px-2 text-[13px] text-ink-2 hover:bg-white/[0.05]">
              <input type="checkbox" checked={picked.has(g.id)} onChange={(e) => setPicked((p) => (e.target.checked ? new Set([...p, g.id]) : new Set([...p].filter((x) => x !== g.id))))} />
              <span className="min-w-0 flex-1 truncate">{g.title}</span>
              <span className="text-[11px] text-ink-4">
                {shown(swarms[g.swarm_id]?.name)} · {g.status}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {hasSubs && (
        <label className="flex items-center gap-2 text-[12px] text-ink-3">
          <input type="checkbox" checked={withSubs} onChange={(e) => setWithSubs(e.target.checked)} /> with their subtasks
        </label>
      )}
      <p className="text-[11.5px] text-ink-4">{LINK_MEANS}</p>
      {msg && <p className={cx('text-[12.5px]', msg.tone === 'ok' ? 'text-good' : 'text-bad')}>{msg.text}</p>}
      <div className="flex gap-2">
        <Button variant="primary" disabled={!picked.size || busy} onClick={() => void file()} className="min-h-9">
          {busy ? 'Filing…' : `File ${picked.size || ''} task${picked.size === 1 ? '' : 's'}`}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)} className="min-h-9">
          Done
        </Button>
      </div>
    </div>
  )
}

/** The people a motivation is shared with: everyone signed in to this hive but you, ticked by principal. Anyone already
 *  named stays listed (and ticked) even when the people list cannot be read, so saving never drops them silently. */
function PeoplePicker({ value, onChange }: { value: string[]; onChange: (people: string[]) => void }) {
  const client = useHive((s) => s.client)
  const { me } = useMe()
  const [read, setPeople] = useState<Person[] | null>(null)
  // no people list on this hive: nobody to read (anyone already named is still shown below)
  const people = client?.listPeople ? read : []
  useEffect(() => {
    if (!client?.listPeople) return
    let alive = true
    client.listPeople().then(
      (d) => alive && setPeople(d.people),
      () => alive && setPeople([]),
    )
    return () => {
      alive = false
    }
  }, [client])
  const known = (people ?? []).map((p) => ({ principal: `user:${p.id}`, name: p.name || p.email || p.id })).filter((p) => p.principal !== me?.principal)
  const extra = value.filter((p) => !known.some((k) => k.principal === p)).map((p) => ({ principal: p, name: p.replace(/^user:/, '') }))
  const all = [...known, ...extra]
  return (
    <fieldset className="space-y-1" data-people-picker>
      <legend className="text-[12px] text-ink-3">Shared with</legend>
      {people === null ? (
        <p className="text-[12px] text-ink-4">Reading people…</p>
      ) : all.length === 0 ? (
        <p className="text-[12px] text-ink-4">No one else is on this hive yet. Invite people from People first.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {all.map((p) => {
            const on = value.includes(p.principal)
            return (
              <label key={p.principal} className="flex min-h-9 items-center gap-2 rounded-xl border border-line px-3 text-[13px] text-ink">
                <input type="checkbox" checked={on} data-person={p.principal} onChange={(e) => onChange(normalPeople(e.target.checked ? [...value, p.principal] : value.filter((x) => x !== p.principal)))} />
                {p.name}
              </label>
            )
          })}
        </div>
      )}
    </fieldset>
  )
}
