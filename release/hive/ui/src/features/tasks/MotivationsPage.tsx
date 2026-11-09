import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { Person } from '../../api/client'
import type { Goal, Visibility } from '../../api/types'
import { experienceById } from '../../experiences/registry'
import { cx } from '../../lib/cx'
import { shown } from '../../lib/displayName'
import { useNow } from '../../lib/hooks'
import {
  changeLinks,
  createBody,
  createMotivation,
  editMotivation,
  normalPeople,
  readMotivationTasks,
  saveDraft,
  setMotivationVisibility,
  useCountsPartial,
  useMotivationData,
  VISIBILITY_CHOICES,
  WORDS,
} from '../../lib/motivations'
import { navigate } from '../../lib/router'
import { useMe } from '../../lib/useAdmin'
import { Screen, type ScreenItem } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { useLook } from '../../shell/uiVariant'
import { useHive } from '../../store/store'
import { Page } from '../../ui/Page'
import { GoalsBoard } from '../goals/GoalsBoard'
import { EVOLVE_ID, EvolveObjectiveCard, EvolveObjectiveDetail } from './EvolveObjective'
import {
  chooserPress,
  createChoice,
  motivationScreen,
  motivationsScreen,
  NEW_DRAFT,
  NEW_FILE,
  type CreateDraft,
  type FileDraft,
  type PeopleRead,
  type SharingDraft,
  type WordsDraft,
} from './motivationsData'
import { useEvolveObjective } from './useEvolveObjective'

/**
 * #/motivations[/id]: the why above the work. A list grouped by whose it is, a way to make one, and one in full, with
 * the tasks filed under it. Every screen here is atoms (motivations.metta) that MeTTa composes for the look being worn:
 * which parts show, in what order, with which block. This page reads the hive, states the facts (motivationsData.ts),
 * offers the few parts it still draws itself as islands, and carries out a press.
 */
export default function MotivationsPage({ id }: { id?: string }) {
  if (id === EVOLVE_ID) return <EvolveObjectiveDetail />
  return id ? <MotivationDetail key={id} id={id} /> : <MotivationList />
}

const PAGE_BODY = 'mx-auto w-full max-w-5xl px-3 pb-[calc(var(--sab)+92px)] md:px-6 md:pb-8'
const FIELD = 'w-full rounded-xl border border-line bg-shade/25 px-3 text-[14px] text-ink outline-none placeholder:text-ink-4 focus:border-line-2'
const isVisibility = (v: string): v is Visibility => (VISIBILITY_CHOICES as readonly string[]).includes(v)
/** The id of the stack item a press came from (Screen.tsx scopedHost puts it first). */
const scopeOf = (item: ScreenItem) => (Array.isArray(item.scope) ? String(item.scope[0] ?? '') : '')

function useScreenLook() {
  return experienceById(useLook().current?.experience).id
}

/** Everyone signed in to this hive, read while a people box is open (null until the first read lands). */
function usePeople(active: boolean): PeopleRead {
  const client = useHive((s) => s.client)
  const [read, setRead] = useState<Person[] | null>(null)
  useEffect(() => {
    if (!active || !client?.listPeople) return
    let alive = true
    client.listPeople().then(
      (d) => alive && setRead(d.people),
      () => alive && setRead([]),
    )
    return () => {
      alive = false
    }
  }, [active, client])
  const canList = !!client?.listPeople
  return useMemo(() => ({ read, canList }), [read, canList])
}

// ---------------------------------------------------------------- the list

function MotivationList() {
  const { supported, loaded } = useMotivationData()
  const motivations = useHive((s) => s.motivations)
  const links = useHive((s) => s.taskLinks)
  const goals = useHive((s) => s.goals)
  const swarms = useHive((s) => s.swarms)
  const agents = useHive((s) => s.agents)
  const partial = useCountsPartial()
  const { me } = useMe()
  const now = useNow(60_000)
  const evolve = useEvolveObjective()
  const [making, setMaking] = useState(false)
  const [draft, setDraft] = useState<CreateDraft>(NEW_DRAFT)
  const people = usePeople(making)
  const compose = useCompose(useScreenLook())
  const { plan, data } = useMemo(() => {
    const s = motivationsScreen({ motivations, links, goals, me, agents, swarms, supported, loaded, partial, making, draft, people, evolveShown: evolve.state !== 'none', now }, compose)
    return { ...s, plan: compose('motivations', s.facts) }
  }, [motivations, links, goals, me, agents, swarms, supported, loaded, partial, making, draft, people, evolve.state, now, compose])

  const choice = createChoice(draft, me, swarms)
  const make = async () => {
    if (choice.held) return
    setDraft((d) => ({ ...d, busy: true, error: null }))
    const r = await createMotivation(createBody({ title: draft.title, why: draft.why, whose: choice.whose, visibility: choice.visibility, sharedWith: draft.people }))
    if (r.ok) {
      setMaking(false)
      setDraft(NEW_DRAFT)
      navigate({ name: 'motivations', id: r.value.id })
    } else setDraft((d) => ({ ...d, busy: false, error: r.why }))
  }
  const islands = {
    'create-words': <CreateWords draft={draft} setDraft={setDraft} whose={choice.whose} onSubmit={() => void make()} />,
    'evolve-objective': <EvolveObjectiveCard o={evolve} />,
  }

  return (
    <Page label={WORDS.motivations} eyebrow="The why" title={WORDS.motivations} info="motivations">
      <div className={PAGE_BODY}>
        <Screen plan={plan} host={{
          data,
          framed: true,
          islands,
          onInput: (bind, value) => { if (bind === 'new.visibility' && isVisibility(value)) setDraft((d) => ({ ...d, visibility: value })) },
          onOpen: (target, item) => {
            if (target === 'tasks') navigate({ name: 'tasks' })
            else if (target === 'unsorted') navigate({ name: 'tasks', motivation: 'none' })
            else if (target === 'motivation' && scopeOf(item)) navigate({ name: 'motivations', id: scopeOf(item) })
          },
          onAction: (action, item, value) => {
            if (action === 'new-motivation') {
              setDraft(NEW_DRAFT)
              setMaking(true)
            } else if (action === 'cancel-new') setMaking(false)
            else if (action === 'make-motivation') void make()
            else if (action === 'pick-new-person') {
              const who = String(item.id)
              setDraft((d) => ({ ...d, people: normalPeople(value ? [...d.people, who] : d.people.filter((x) => x !== who)) }))
            }
          },
        }} />
      </div>
    </Page>
  )
}

/**
 * What a new motivation is for, why (several lines), and whose it is: a person their own (across swarms or in one),
 * or a swarm's, for its owner or an admin. A choice this person may not take is shown but cannot be picked. Enter in
 * the title makes it, as the Make it button does (the screen draws the button and the rest of the form).
 */
function CreateWords({ draft, setDraft, whose, onSubmit }: { draft: CreateDraft; setDraft: (f: (d: CreateDraft) => CreateDraft) => void; whose: string; onSubmit: () => void }) {
  const swarms = useHive((s) => s.swarms)
  const { me } = useMe()
  const { rights } = createChoice(draft, me, swarms)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    onSubmit()
  }
  return (
    <form onSubmit={submit} className="space-y-3" aria-label="New motivation" data-create-motivation>
      <label className="block space-y-1">
        <span className="text-[12px] text-ink-3">What is it for?</span>
        <input autoFocus value={draft.title} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} maxLength={200} placeholder="Know the variable sky well enough to predict it" className={cx(FIELD, 'min-h-11')} />
      </label>
      <label className="block space-y-1">
        <span className="text-[12px] text-ink-3">Why, in your words (optional)</span>
        <textarea value={draft.why} onChange={(e) => setDraft((d) => ({ ...d, why: e.target.value }))} maxLength={4000} rows={3} className={cx(FIELD, 'py-2 leading-relaxed')} />
      </label>
      <label className="block space-y-1">
        <span className="block text-[12px] text-ink-3">Whose is it?</span>
        <select value={whose} onChange={(e) => setDraft((d) => ({ ...d, picked: e.target.value, visibility: null }))} className={cx(FIELD, 'min-h-10 w-auto')}>
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
    </form>
  )
}

// ---------------------------------------------------------------- one motivation

function MotivationDetail({ id }: { id: string }) {
  const { supported, loaded } = useMotivationData()
  const m = useHive((s) => s.motivations[id])
  const links = useHive((s) => s.taskLinks)
  const goals = useHive((s) => s.goals)
  const swarms = useHive((s) => s.swarms)
  const agents = useHive((s) => s.agents)
  const linksSeq = useHive((s) => s.linksSeq)
  const { me } = useMe()
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

  // its words being edited: Save goes against the revision seen when editing began, never the live one (stand-in P1-2)
  const [words, setWords] = useState<WordsDraft | null>(null)
  const seen = words?.seen
  const wordsChanged = !!m && !!seen && m.id === seen.id && m.rev !== seen.rev
  const [controls, setControls] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null })
  // choosing or changing the people it is shared with: saved against the motivation as it was when opened
  const [sharing, setSharing] = useState<SharingDraft | null>(null)
  const [file, setFile] = useState<FileDraft>(NEW_FILE)
  const people = usePeople(!!sharing)

  const gone = !m && (read === 'gone' || (loaded && read === 'read'))
  const compose = useCompose(useScreenLook())
  const names = useMemo(() => ({ me, agents, swarms }), [me, agents, swarms])
  const { plan, data, frame, ids } = useMemo(() => {
    const s = motivationScreen({ m, supported, gone, links, goals, names, partial, now, words, wordsChanged, controls, sharing, people, file }, compose)
    return { ...s, plan: compose('motivation', s.facts) }
  }, [m, supported, gone, links, goals, names, partial, now, words, wordsChanged, controls, sharing, people, file, compose])
  const only = useMemo(() => (g: Goal) => ids.has(g.id), [ids])

  // status and who can see it: one write at a time; a refusal is said in plain words
  const run = async (p: Promise<{ ok: boolean; why?: string }>) => {
    setControls({ busy: true, error: null })
    const r = await p
    setControls({ busy: false, error: r.ok ? null : (r.why ?? 'Not changed.') })
  }
  const openSharing = () => m && setSharing({ seen: m, people: m.visibility === 'shared' ? normalPeople(m.shared_with ?? []) : [] })
  const saveSharing = async () => {
    if (!sharing) return
    setControls({ busy: true, error: null })
    const r = await setMotivationVisibility(sharing.seen, 'shared', sharing.people)
    setControls({ busy: false, error: r.ok ? null : r.why })
    if (r.ok) setSharing(null)
  }
  const saveWords = async () => {
    if (!words || !seen) return
    setWords({ ...words, busy: true })
    const r = await saveDraft(seen, { title: words.title, why: words.why })
    setWords(r.ok ? null : (w) => w && { ...w, busy: false, error: r.why })
  }
  const fileTasks = async () => {
    if (!m) return
    const hasSubs = file.picked.some((p) => Object.values(goals).some((g) => g.parent_id === p))
    setFile((f) => ({ ...f, busy: true, message: null }))
    const r = await changeLinks(m, 'link', file.picked, hasSubs && file.withSubs)
    if (r.ok) {
      const n = r.value.applied.length
      const text = `Filed ${n} task${n === 1 ? '' : 's'} under it${r.value.unchanged.length ? ` (${r.value.unchanged.length} already were)` : ''}.`
      setFile((f) => ({ ...f, busy: false, picked: [], message: { tone: 'ok', text } }))
    } else setFile((f) => ({ ...f, busy: false, message: { tone: 'bad', text: r.why } }))
  }

  const islands = m
    ? {
        'edit-words': <EditWords words={words} setWords={setWords} />,
        'motivation-tasks': <GoalsBoard key={m.id} only={only} layout="list" addUnder={m} />,
      }
    : undefined

  const onAction = (action: string, item: ScreenItem, value?: boolean) => {
    const pick = (list: string[]) => (value ? [...list.filter((x) => x !== String(item.id)), String(item.id)] : list.filter((x) => x !== String(item.id)))
    switch (action) {
      case 'all-motivations': return navigate({ name: 'motivations' })
      case 'edit-words': return m && setWords({ seen: m, title: m.title, why: m.why, busy: false, error: null })
      case 'save-words': return void saveWords()
      case 'cancel-words': return setWords(null)
      // the two choosers (held by controls.busy while a change is saved): a press is one write, except Shared, which
      // opens the people box rather than writing at once (motivationsData chooserPress)
      case 'set-status':
      case 'set-visibility': {
        const press = m ? chooserPress(action, item.value, m, controls.busy) : null
        if (!m || !press) return
        if (press.kind === 'open-sharing') return openSharing()
        return void run(press.kind === 'status' ? editMotivation(m, { status: press.status }) : setMotivationVisibility(m, press.visibility))
      }
      case 'edit-people': return openSharing()
      case 'save-sharing': return void saveSharing()
      case 'cancel-sharing': return setSharing(null)
      case 'pick-share-person': return setSharing((s) => s && { ...s, people: normalPeople(pick(s.people)) })
      case 'file-open': return setFile((f) => ({ ...f, open: true }))
      case 'file-close': return setFile((f) => ({ ...f, open: false }))
      case 'pick-task': return setFile((f) => ({ ...f, picked: pick(f.picked) }))
      case 'pick-subtasks': return setFile((f) => ({ ...f, withSubs: value === true }))
      case 'file-tasks': return void fileTasks()
    }
  }

  return (
    <Page label={frame.label} eyebrow={frame.eyebrow} title={frame.title} info={frame.info} onClose={() => navigate({ name: 'motivations' })}>
      <div className={PAGE_BODY} data-motivation-detail={m?.id}>
        <Screen plan={plan} host={{
          data,
          framed: true,
          islands,
          onInput: (bind, value) => { if (bind === 'file.query') setFile((f) => ({ ...f, query: value })) },
          onOpen: (target) => { if (target === 'tasks' && m) navigate({ name: 'tasks', motivation: m.id }) },
          onAction,
        }} />
      </div>
    </Page>
  )
}

/** The title and the why being edited (the screen draws what is said about them, and Save and Cancel). */
function EditWords({ words, setWords }: { words: WordsDraft | null; setWords: (f: (w: WordsDraft | null) => WordsDraft | null) => void }) {
  const field = 'w-full rounded-xl border border-line bg-shade/25 px-3 text-[14px] text-ink outline-none focus:border-line-2'
  return (
    <div className="space-y-2">
      <input value={words?.title ?? ''} onChange={(e) => setWords((w) => w && { ...w, title: e.target.value })} maxLength={200} aria-label="Title" className={cx(field, 'min-h-10')} />
      <textarea value={words?.why ?? ''} onChange={(e) => setWords((w) => w && { ...w, why: e.target.value })} maxLength={4000} rows={4} aria-label="Why" className={cx(field, 'py-2')} />
    </div>
  )
}
