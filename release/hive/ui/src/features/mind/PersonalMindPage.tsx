/**
 * You › <mind>: the person's own personal mind in Classic (the owner, 2026-10-08: "a really beautiful human shape mind in
 * the classic UI"; "I was thinking every user had one"; its memory "lives in the browser"). One page, all from real
 * reads: who it is and whether it is awake (GET /api/me/mind, the glass figure), what it remembers (this browser's
 * memory, with the swarm talk it collected), its version (GET /api/me/mind/versions, when the hive has it), its hands
 * (the Ask thread's acts when a turn is acting as it) and what it handed on. A hive without personal minds says so
 * calmly. The Universal Ask stays on this page as on every page.
 */
import { plural } from '../../lib/plural'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ApiError } from '../../api/client'
import { presenceOf, PRESENCE_ORDER, PRESENCE_WORDS, readPersonalMind, readVersions, type MindVersion, type MindVersions, type PersonalMind } from '../../api/personalMind'
import { askMemory, useAskMemory } from '../../lib/askMemory'
import { ago, money } from '../../lib/format'
import { askConfirmBound, bindEpoch } from '../../lib/identityEpoch'
import { navigate } from '../../lib/router'
import { useMediaQuery } from '../../lib/hooks'
import { useAskStore } from '../../store/ask'
import { useHive } from '../../store/store'
import { ConfirmHost } from '../../ui/confirm'
import { Page } from '../../ui/Page'
import { Button, Switch } from '../../ui/primitives'
import { BeliefRow } from '../keys/AskMemorySection'
import { memoryStatus } from '../ask/words'
import { MindFigure } from './MindFigure'
import { useMindLook } from './mindLook'
import { handedOn, handsOf } from './hands'
import { MemoryDurability } from './MemoryDurability'
import { lostRose } from './durability'
import { useMind } from './store'
import './mind.css'

const iso = (ms: number) => new Date(ms).toISOString()

export default function PersonalMindPage() {
  const state = useMind((s) => s.state)
  const mind = useMind((s) => s.mind)
  const absentWhy = useMind((s) => s.absentWhy)
  const load = useMind((s) => s.load)
  const client = useHive((s) => s.client)
  useEffect(() => {
    void load()
  }, [load, client])
  const title = mind ? (
    <>
      <span className="text-ink-3">You ›</span> {mind.name}
    </>
  ) : (
    'Your personal mind'
  )
  return (
    <Page title={title} eyebrow="You" label={mind ? `You, ${mind.name}` : 'Your personal mind'} onClose={() => navigate({ name: 'me' })}>
      <ConfirmHost />
      {state === 'ready' && mind ? (
        <MindView mind={mind} />
      ) : state === 'absent' || state === 'none' ? (
        <Calm why={absentWhy} />
      ) : state === 'error' ? (
        <div className="mx-auto max-w-xl px-4 py-16 text-center" role="alert">
          <p className="text-[15px] text-ink">Your personal mind could not be read just now.</p>
          <Button variant="subtle" className="mt-4" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : (
        <p className="px-4 py-16 text-center text-[13px] text-ink-3" role="status">
          Finding your mind…
        </p>
      )}
    </Page>
  )
}

/** No personal mind on this hive (or for this account): said calmly, with nothing broken around it. */
function Calm({ why }: { why: 'no_route' | 'person_required' | null }) {
  return (
    <div className="mx-auto max-w-xl px-4 py-16 text-center" data-mind-absent={why ?? 'none'}>
      <div className="mx-auto w-[96px] opacity-60" aria-hidden>
        <MindFigure name="Your mind" presence="asleep" remembers={2} acting={false} versioned={false} width={96} />
      </div>
      <p className="mt-6 text-[16px] font-semibold text-ink">Your personal mind isn’t set up on this hive yet</p>
      <p className="mt-2 text-[13px] text-ink-3">
        {why === 'person_required'
          ? 'A personal mind belongs to a signed-in person with an account here. The Ask still answers through your swarms.'
          : 'When this hive has personal minds, yours will be here, named after you. Until then the Ask answers through your swarms, and what it learns about you is still kept in this browser.'}
      </p>
      <Button variant="ghost" className="mt-5" onClick={() => navigate({ name: 'me' })}>
        Back to You
      </Button>
    </div>
  )
}

function MindView({ mind }: { mind: PersonalMind }) {
  const mem = useAskMemory()
  const log = useAskStore((s) => s.log)
  const turns = useAskStore((s) => s.turns)
  const hands = useMemo(() => handsOf(log, turns, mind.id), [log, turns, mind.id])
  const handed = useMemo(() => handedOn(log, turns), [log, turns])
  const wide = useMediaQuery('(min-width: 1024px)')
  const acting = !!hands?.live
  const presence = presenceOf(mind.status, acting)
  const versions = useVersions()
  const version = versions.data?.current ?? mind.version
  const nowAct = hands?.rows.findLast((r) => r.state === 'now') ?? null
  const look = useMindLook()

  const figure = (
    <MindFigure name={mind.name} presence={presence} remembers={mem.beliefs.length + mem.talks.length} acting={acting} versioned={!!version} width={wide ? 260 : 118} />
  )

  const remembers = <Remembers mind={mind} />
  const yourHands = <YourHands mind={mind} hands={hands} />
  const versionCard = <VersionCard mind={mind} versions={versions} />
  const handedCard = <Handed mind={mind} handed={handed} />

  if (!wide) {
    return (
      <div className="mx-auto max-w-xl space-y-4 px-4 pt-1 pb-28" data-mind-page="phone" data-mind-look={look}>
        <section className="flex items-start gap-4" aria-label="Who it is">
          <div className="shrink-0">{figure}</div>
          <div className="min-w-0 flex-1 pt-6">
            <p className="eyebrow">Your personal mind</p>
            <Identity mind={mind} size="phone" />
            <p className="mt-2">
              <span className="pm-pill" data-tone={presence === 'working' ? 'live' : presence === 'listening' ? 'good' : undefined} data-mind-presence={presence}>
                {PRESENCE_WORDS[presence]}
              </span>
            </p>
            <p className="mt-2 text-[12.5px] leading-5 text-ink-3">
              Remembers {mem.beliefs.length} note{mem.beliefs.length === 1 ? '' : 's'} · {mem.talks.length} talk{mem.talks.length === 1 ? '' : 's'}
              {version && (
                <>
                  <br />
                  Version <span className="font-mono text-accent-2">{version.label}</span>
                </>
              )}
            </p>
          </div>
        </section>
        {yourHands}
        {remembers}
        {versionCard}
        {handedCard}
      </div>
    )
  }

  return (
    <div className="relative mx-auto grid max-w-[1400px] grid-cols-[minmax(280px,380px)_minmax(0,1fr)_minmax(280px,380px)] gap-6 px-6 pt-2 pb-28" data-mind-page="desktop" data-mind-look={look}>
      <div className="space-y-4">
        {remembers}
        {handedCard}
      </div>
      <section className="pm-center relative flex min-h-[640px] flex-col items-center" aria-label="Who it is">
        <span className="pm-glow" aria-hidden />
        <p className="eyebrow mt-1">Your personal mind</p>
        <Identity mind={mind} size="desktop" />
        <ol className="pm-states mt-3" aria-label="Whether it is awake" data-mind-presence={presence}>
          {PRESENCE_ORDER.map((p) => (
            <li key={p} aria-current={p === presence ? 'true' : undefined}>
              {PRESENCE_WORDS[p]}
            </li>
          ))}
        </ol>
        {/* the same facts as the figure's labels, in one line; the labels show only where there is room beside it */}
        <p className="pm-facts mt-3 text-center text-[12.5px] text-ink-3">
          Remembers {mem.beliefs.length} note{mem.beliefs.length === 1 ? '' : 's'} · {mem.talks.length} talk{mem.talks.length === 1 ? '' : 's'}
          {mind.allowance_usd !== null ? ` · energy from your allowance (${money(mind.allowance_usd)} a month)` : ''}
          {version ? ` · ${version.label}` : ''}
        </p>
        <div className="relative mt-6">
          {figure}
          {version && (
            <span className="pm-tag" data-side="r" style={{ left: '62%', top: '-1%' }}>
              <i />
              <span>
                <b>Halo</b>
                {version.label}
              </span>
            </span>
          )}
          <span className="pm-tag" data-side="l" style={{ right: '64%', top: '6%' }}>
            <span>
              <b>Remembers</b>
              {plural(mem.beliefs.length, 'note')} · {plural(mem.talks.length, 'talk')}
            </span>
            <i />
          </span>
          <span className="pm-tag" data-side="l" style={{ right: '64%', top: '27%' }}>
            <span>
              <b>Energy</b>
              {mind.allowance_usd !== null ? `your allowance · ${money(mind.allowance_usd)} a month` : 'your allowance'}
            </span>
            <i />
          </span>
          <span className="pm-tag" data-side="r" style={{ left: '76%', top: '58%' }}>
            <i />
            <span>
              <b>Hands</b>
              {nowAct ? nowAct.text.slice(0, 32) : acting ? 'on your screen' : 'resting'}
            </span>
          </span>
        </div>
      </section>
      <div className="space-y-4">
        {versionCard}
        {yourHands}
      </div>
    </div>
  )
}

/** The name, and Rename (POST /api/me/mind {name}). */
function Identity({ mind, size }: { mind: PersonalMind; size: 'phone' | 'desktop' }) {
  const rename = useMind((s) => s.rename)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(mind.name)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (name.trim() === mind.name) return setEditing(false)
    setBusy(true)
    const binding = bindEpoch()
    const why = await rename(name)
    binding.commit(() => {
      setBusy(false)
      if (why) return setProblem(why)
      setEditing(false)
      setProblem(null)
      queueMicrotask(() => btn.current?.focus())
    })
  }
  if (editing) {
    return (
      <form className="mt-2 flex flex-wrap items-center justify-center gap-2" onSubmit={(e) => void submit(e)} data-mind-rename="">
        <input
          autoFocus
          value={name}
          maxLength={80}
          onChange={(e) => (setName(e.target.value), setProblem(null))}
          aria-label="Your mind’s name"
          aria-invalid={problem ? true : undefined}
          className="min-h-10 w-56 rounded-lg border border-line-2 bg-black/20 px-3 text-[15px] text-ink outline-none"
        />
        <Button type="submit" variant="primary" className="min-h-10 px-4 text-[13px]" disabled={busy || !name.trim()}>
          Save
        </Button>
        <Button type="button" variant="ghost" className="min-h-10 px-3 text-[13px]" onClick={() => (setName(mind.name), setProblem(null), setEditing(false))}>
          Cancel
        </Button>
        {problem && (
          <p role="alert" className="w-full text-center text-[12.5px] text-warn">
            {problem}
          </p>
        )}
      </form>
    )
  }
  return (
    <div className={size === 'desktop' ? 'text-center' : ''}>
      <h1 className={size === 'desktop' ? 'mt-1 font-display text-[44px] leading-[1.1] font-semibold text-ink' : 'mt-1 font-display text-[30px] leading-tight font-semibold text-ink'} data-mind-name="">
        {mind.name}
      </h1>
      <p className="mt-1 text-[13px] text-ink-3">
        Your mind · alone in its own swarm ·{' '}
        <button ref={btn} type="button" className="text-accent hover:underline" onClick={() => (setName(mind.name), setEditing(true))} data-mind-rename-open="">
          Rename
        </button>
      </p>
    </div>
  )
}

/** What it remembers: this browser's memory (view, edit, forget), the swarm talk it collected, and keeping it safe. */
function Remembers({ mind }: { mind: PersonalMind }) {
  const mem = useAskMemory()
  const collect = useMind((s) => s.collect)
  const collecting = useMind((s) => s.collecting)
  const beliefs = useMemo(() => [...mem.beliefs].sort((a, b) => b.updated_at - a.updated_at), [mem.beliefs])
  const talks = useMemo(() => [...mem.talks].reverse(), [mem.talks])
  const on = !!mem.capabilities?.memory || mem.hive === 'learning' || mem.hive === 'conductor'
  return (
    <section className="pm-card" aria-labelledby="pm-remembers-h" data-mind-remembers="" data-tour="mind-remembers">
      <div className="flex items-start gap-3">
        <h2 id="pm-remembers-h" className="min-w-0 flex-1">
          What {mind.name} remembers
        </h2>
        <span className="pm-pill" data-tone={on ? 'good' : undefined}>
          {on ? 'Memory on' : mem.hive === 'off' ? 'Memory off' : 'Memory'}
        </span>
      </div>
      <p className="pm-sub">{memoryStatus(mem.owner !== null, mem.hive, mem.capabilities, mem.beliefs.length)}</p>
      {!mem.ready ? (
        <p className="text-[12.5px] text-ink-3" role="status">
          Reading this browser’s memory…
        </p>
      ) : beliefs.length ? (
        <ul className="rounded-xl border border-line px-3" aria-label="Notes">
          {beliefs.map((b) => (
            <BeliefRow key={b.id} b={b} />
          ))}
        </ul>
      ) : (
        <p className="text-[12.5px] text-ink-3">No notes yet.</p>
      )}

      <h3 className="eyebrow mt-5">From your swarm talk</h3>
      <p className="pm-sub">Copies of your own conversations with your swarms, remembered without waking {mind.name}. Read only; forget one and it is never used again.</p>
      {/* r2.3: the person's own choice, off until they turn it on (kept in this browser's memory, for this person) */}
      <div className="mb-2 flex items-center gap-3 rounded-lg border border-line px-3 py-1.5" data-mind-talk-recall={mem.talkRecall ? 'on' : 'off'} data-tour="mind-talk-recall">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-ink">Use my swarm talk in answers</p>
          <p className="text-[12px] text-ink-3" data-mind-talk-recall-say="">
            {mem.talkRecall ? `When you ask, the conversations that matter go with your words, so ${mind.name} gets to know you.` : 'Kept in your browser, not used in answers yet.'}
          </p>
        </div>
        <Switch checked={mem.talkRecall} onChange={(on) => askMemory.setTalkRecall(on)} label="Use my swarm talk in answers" disabled={!mem.ready} />
      </div>
      <p className="mb-2 text-[11.5px] text-ink-4" data-mind-forget-scope="">Forget everything clears what’s remembered; your “Use my swarm talk in answers” choice stays as you set it.</p>
      {talks.length ? (
        <ul className="pm-list" aria-label="From your swarm talk" data-mind-talks="">
          {talks.map((t) => (
            <TalkRow key={t.id} id={t.id} words={t.words} answer={t.answer} truncated={t.truncated} at={t.at} uses={t.uses ?? 0} />
          ))}
        </ul>
      ) : (
        <p className="text-[12.5px] text-ink-3" data-mind-talks-empty="">
          {collect?.state === 'absent' ? 'Swarm talk is not kept on this hive yet.' : 'Nothing yet. When you talk with one of your swarms, a copy is kept here.'}
        </p>
      )}
      {collecting ? (
        <p className="mt-2 text-[11.5px] text-ink-4" role="status">
          Collecting from the hive…
        </p>
      ) : collect?.state === 'done' && mem.owner && (collect.dropped > 0 || collect.expired > 0) && lostRose(mem.owner, collect.dropped, collect.expired) ? (
        <p className="mt-2 text-[11.5px] text-ink-4" role="status" data-mind-collect="lost">
          Some older conversations weren’t collected in time, and the hive no longer holds them.
        </p>
      ) : collect?.state === 'volatile' ? (
        <p className="mt-2 text-[11.5px] text-ink-4" role="status" data-mind-collect="volatile">
          Your browser isn’t keeping memory here, so your swarm talk stays on the hive for now.
        </p>
      ) : collect?.state === 'failed' ? (
        <p className="mt-2 text-[11.5px] text-ink-4" role="status" data-mind-collect="failed">
          The hive could not be reached just now; it keeps your conversations until this browser collects them.
        </p>
      ) : null}
      <MemoryDurability compact />
    </section>
  )
}

function TalkRow({ id, words, answer, truncated, at, uses }: { id: string; words: string; answer: string; truncated: boolean; at: number; uses: number }) {
  const [open, setOpen] = useState(false)
  return (
    <li className="flex-wrap" data-mind-talk={id}>
      <div className="min-w-0 flex-1">
        <p className="text-ink [overflow-wrap:anywhere]">{words}</p>
        <p className={`mt-0.5 text-[12.5px] text-ink-3 [overflow-wrap:anywhere] ${open ? 'whitespace-pre-wrap' : 'line-clamp-2'}`}>
          {answer}
          {truncated && open ? ' (cut short by the hive)' : ''}
        </p>
        <p className="mt-0.5 text-[11.5px] text-ink-4" data-mind-talk-uses={uses}>
          {uses ? `used ${uses} time${uses === 1 ? '' : 's'} when you asked` : 'not used yet'}
        </p>
      </div>
      <span className="shrink-0 text-[12px] text-ink-4">{ago(iso(at))}</span>
      <button type="button" className="shrink-0 text-[12px] text-ink-3 hover:text-ink" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={`${open ? 'Less of' : 'All of'}: ${words.slice(0, 60)}`}>
        {open ? 'Less' : 'View'}
      </button>
      <button type="button" className="shrink-0 text-[12px] text-accent hover:underline" onClick={() => askMemory.forgetTalk(id)} aria-label={`Forget: ${words.slice(0, 60)}`} data-mind-talk-forget="">
        Forget
      </button>
    </li>
  )
}

type VersionsRead = { state: 'loading' | 'later' | 'ready' | 'error'; data: MindVersions | null; reload: () => void; set: (m: PersonalMind | null) => void }

/** GET /api/me/mind/versions; a host without it (404) is "comes later", nothing else. */
function useVersions(): VersionsRead {
  const client = useHive((s) => s.client)
  const [state, setState] = useState<VersionsRead['state']>('loading')
  const [data, setData] = useState<MindVersions | null>(null)
  const [n, setN] = useState(0)
  useEffect(() => {
    let live = true
    const binding = bindEpoch()
    if (!client?.myMindVersions) return
    client.myMindVersions().then(
      (raw) => {
        if (live) binding.commit(() => (setData(readVersions(raw)), setState('ready')))
      },
      (e: unknown) => {
        if (live) binding.commit(() => setState(e instanceof ApiError && e.status === 404 ? 'later' : 'error'))
      },
    )
    return () => {
      live = false
    }
  }, [client, n])
  // a client without the route at all: "comes later", as on a host that answers 404
  return { state: client?.myMindVersions ? state : 'later', data, reload: () => setN((x) => x + 1), set: (m) => m && useMind.setState({ mind: m }) }
}

const pct = (x: number) => `${Math.round(x * 100)}%`
const steps = (x: number) => x.toFixed(1)
const cost = (x: number) => `$${x.toFixed(3)}`

function VersionCard({ mind, versions }: { mind: PersonalMind; versions: VersionsRead }) {
  const [busy, setBusy] = useState(false)
  const [say, setSay] = useState<string | null>(null)
  const client = useHive((s) => s.client)
  if (versions.state === 'later') {
    return (
      <section className="pm-card" aria-labelledby="pm-version-h" data-mind-version="later">
        <h2 id="pm-version-h">Version</h2>
        <p className="pm-sub mb-0">Version choice comes later.</p>
      </section>
    )
  }
  if (versions.state !== 'ready' || !versions.data) {
    return (
      <section className="pm-card" aria-labelledby="pm-version-h" data-mind-version={versions.state}>
        <h2 id="pm-version-h">Version</h2>
        <p className="pm-sub mb-0">{versions.state === 'loading' ? 'Reading its version…' : 'Its version could not be read just now.'}</p>
      </section>
    )
  }
  const { current, best } = versions.data
  const better = best && current && best.id !== current.id ? best : null
  const act = async (what: 'adopt' | 'rollback', v?: MindVersion) => {
    const binding = bindEpoch()
    const ok = await askConfirmBound(
      what === 'adopt' ? `Switch ${mind.name} to ${v!.label}? You can roll back to ${current?.label ?? 'the version before'} afterwards.` : `Roll ${mind.name} back to the version before?`,
      what === 'adopt' ? `Adopt ${v!.label}` : 'Roll back',
      { binding },
    )
    if (!ok) return
    setBusy(true)
    setSay(null)
    try {
      const raw = what === 'adopt' ? await client!.adoptMyMindVersion!(v!.id) : await client!.rollbackMyMind!()
      binding.commit(() => {
        setBusy(false)
        versions.set(readPersonalMind(raw))
        versions.reload()
        setSay(what === 'adopt' ? `${mind.name} now runs ${v!.label}.` : `${mind.name} is back on the version before.`)
      })
    } catch (e) {
      binding.commit(() => {
        setBusy(false)
        const code = e instanceof ApiError ? e.code : ''
        setSay(code === 'already_current' ? `${mind.name} already runs that version.` : code === 'nothing_to_roll_back' ? 'There is no earlier version to go back to.' : code === 'unknown_version' ? 'That version is no longer offered.' : 'That could not be done just now. Nothing changed.')
      })
    }
  }
  return (
    <section className="pm-card" aria-labelledby="pm-version-h" data-mind-version="ready">
      <div className="flex items-baseline gap-3">
        <h2 id="pm-version-h" className="min-w-0 flex-1">
          {better ? `${better.label} is waiting` : 'Version'}
        </h2>
        {current && <span className="font-mono text-[12px] text-accent-2">{current.label}</span>}
      </div>
      <p className="pm-sub">
        {current ? `${mind.name} runs ${current.label}${mind.adopted_at ? `, adopted ${ago(mind.adopted_at)}` : ''}.` : `${mind.name}’s version is not known yet.`}
        {better ? ' A better one is waiting.' : current ? ' It is the best measured so far.' : ''}
      </p>
      {better && current?.score && better.score && (
        <table className="pm-score">
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">Measure</span>
              </th>
              <th scope="col">Now · {current.label}</th>
              <th scope="col">Best · {better.label}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Success</td>
              <td>{pct(current.score.success)}</td>
              <td data-better={better.score.success > current.score.success ? '' : undefined}>{pct(better.score.success)}</td>
            </tr>
            <tr>
              <td>Steps per task</td>
              <td>{steps(current.score.steps)}</td>
              <td data-better={better.score.steps < current.score.steps ? '' : undefined}>{steps(better.score.steps)}</td>
            </tr>
            <tr>
              <td>Cost per task</td>
              <td>{cost(current.score.cost_usd)}</td>
              <td data-better={better.score.cost_usd < current.score.cost_usd ? '' : undefined}>{cost(better.score.cost_usd)}</td>
            </tr>
          </tbody>
        </table>
      )}
      {better?.measured_at && <p className="mt-2 text-[12px] text-ink-3">{better.label}: measured {ago(better.measured_at)}{better.suite_run_id ? ` · Lab run ${better.suite_run_id}` : ''}.</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {better && client?.adoptMyMindVersion && (
          <Button variant="primary" disabled={busy} onClick={() => void act('adopt', better)} data-mind-adopt="">
            Adopt {better.label}
          </Button>
        )}
        {mind.previous_version_id && client?.rollbackMyMind && (
          <Button variant="subtle" disabled={busy} onClick={() => void act('rollback')} data-mind-rollback="">
            Roll back
          </Button>
        )}
      </div>
      {say && (
        <p className="mt-2 text-[12.5px] text-ink-2" role="status">
          {say}
        </p>
      )}
    </section>
  )
}

function YourHands({ mind, hands }: { mind: PersonalMind; hands: ReturnType<typeof handsOf> }) {
  const live = !!hands?.live
  return (
    <section className="pm-card" aria-labelledby="pm-hands-h" data-mind-hands={live ? 'live' : 'resting'}>
      <div className="flex items-start gap-3">
        <h2 id="pm-hands-h" className="min-w-0 flex-1">
          Its hands
        </h2>
        {live && (
          <span className="pm-pill" data-tone="live">
            Acting on your screen
          </span>
        )}
      </div>
      <p className="pm-sub">{live ? `What ${mind.name} is doing on this screen right now.` : hands ? `What ${mind.name} did on your screen last.` : `${mind.name} is not acting on your screen. When the Ask acts for you, you will see each step here.`}</p>
      {hands && hands.rows.length > 0 && (
        <ul className="pm-list pm-acts" aria-label="Its steps">
          {hands.rows.slice(-8).map((r) => (
            <li key={r.id} data-state={r.state}>
              <span className="pm-mark" aria-hidden>
                {r.state === 'done' ? '✓' : r.state === 'now' ? '●' : r.state === 'refused' ? '⊘' : '○'}
              </span>
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{r.text}</span>
            </li>
          ))}
        </ul>
      )}
      {live && (
        <div className="mt-3 flex items-center gap-3">
          <button type="button" className="pm-take" data-takeover="" onClick={() => useAskStore.getState().personTookOver()}>
            Take back control
          </button>
          <span className="text-[12px] text-ink-4">or click anywhere</span>
        </div>
      )}
    </section>
  )
}

function Handed({ mind, handed }: { mind: PersonalMind; handed: ReturnType<typeof handedOn> }) {
  return (
    <section className="pm-card" aria-labelledby="pm-handed-h" data-mind-handed="">
      <h2 id="pm-handed-h">Handed to swarms</h2>
      <p className="pm-sub">Work {mind.name} passed to the right swarm’s coordinator, from this Ask thread. A full list across threads comes later.</p>
      {handed.length ? (
        <ul className="pm-list">
          {handed.slice(0, 8).map((h) => (
            <li key={h.id}>
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{h.text}</span>
              <span className="shrink-0 text-[12px] text-ink-4">{ago(h.at)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12.5px] text-ink-3">Nothing handed on in this thread yet.</p>
      )}
    </section>
  )
}
