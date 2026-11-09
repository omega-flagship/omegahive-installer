/**
 * You › <mind>: the person's own personal mind (Jon, 2026-10-08: "a really beautiful human shape mind in the classic
 * UI"; "I was thinking every user had one"; its memory "lives in the browser"). One page, all from real reads: who it
 * is and whether it is awake (GET /api/me/mind, its figure), what it remembers (this browser's memory, with the swarm
 * talk it collected), its version (GET /api/me/mind/versions, when the hive has it), its hands (the Ask thread's acts
 * when a turn is acting as it) and what it handed on. A hive without personal minds says so calmly.
 *
 * The page and each of its cards are atoms (mind.metta) that MeTTa composes for the look being worn; this page loads
 * the data, states the facts (data.ts), and carries out a press.
 *
 * Islands: the figure (a drawing in the look being worn, MindPortrait.tsx), the notes (each row edits the browser's
 * memory in its own form, the same rows the You page's memory section draws) and keeping it safe (download, restore
 * from a file or a folder: the file chooser and folder link, shared with the You page too, MemoryDurability.tsx).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '../../api/client'
import { presenceOf, readPersonalMind, readVersions, type MindVersions, type PersonalMind } from '../../api/personalMind'
import { experienceById } from '../../experiences/registry'
import { askMemory, useAskMemory } from '../../lib/askMemory'
import { askConfirmBound, bindEpoch } from '../../lib/identityEpoch'
import { navigate } from '../../lib/router'
import { Screen, type ScreenHost, type ScreenItem } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { useLook } from '../../shell/uiVariant'
import { useAskStore } from '../../store/ask'
import { useHive } from '../../store/store'
import { ConfirmHost } from '../../ui/confirm'
import { Page } from '../../ui/Page'
import { BeliefRow } from '../keys/AskMemorySection'
import { betterOf, mindScreen, type VersionsState } from './data'
import { lostRose } from './durability'
import { handedOn, handsOf } from './hands'
import { MemoryDurability } from './MemoryDurability'
import { MindPortrait } from './MindPortrait'
import { useMindLook } from './mindLook'
import { useMind } from './store'
import './mind.css'

const scopeOf = (item: ScreenItem): string[] => (Array.isArray(item.scope) ? item.scope.map(String) : [])

export default function PersonalMindPage() {
  const state = useMind((s) => s.state)
  const mind = useMind((s) => s.mind)
  const absentWhy = useMind((s) => s.absentWhy)
  const load = useMind((s) => s.load)
  const rename = useMind((s) => s.rename)
  const collect = useMind((s) => s.collect)
  const collecting = useMind((s) => s.collecting)
  const client = useHive((s) => s.client)
  const mem = useAskMemory()
  const log = useAskStore((s) => s.log)
  const turns = useAskStore((s) => s.turns)
  const look = experienceById(useLook().current?.experience).id
  const figureLook = useMindLook()
  const compose = useCompose(look)
  useEffect(() => {
    void load()
  }, [load, client])

  const here = state === 'ready' && !!mind
  const versions = useVersions(here)
  const [editing, setEditing] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const renaming = useRef(false)
  const [openTalks, setOpenTalks] = useState<ReadonlySet<string>>(() => new Set())
  const [versionBusy, setVersionBusy] = useState(false)
  const [versionSay, setVersionSay] = useState<string | null>(null)

  const hands = useMemo(() => (mind ? handsOf(log, turns, mind.id) : null), [log, turns, mind])
  const handed = useMemo(() => handedOn(log, turns), [log, turns])
  const acting = !!hands?.live
  const presence = presenceOf(mind?.status ?? 'asleep', acting)
  const beliefs = useMemo(() => [...mem.beliefs].sort((a, b) => b.updated_at - a.updated_at), [mem.beliefs])
  // a loss the hive reported is said once it is new to this person (lostRose remembers what was already said)
  const lost = useMemo(() => collect?.state === 'done' && !!mem.owner && (collect.dropped > 0 || collect.expired > 0) && lostRose(mem.owner, collect.dropped, collect.expired), [collect, mem.owner])

  const { plan, data } = useMemo(() => {
    const { data, facts } = mindScreen({
      state, mind, absentWhy, presence, openTalks, hands, handed,
      rename: { editing, problem },
      memory: { ready: mem.ready, signedIn: mem.owner !== null, hive: mem.hive, capabilities: mem.capabilities, notes: mem.beliefs.length, talks: mem.talks.map((t) => ({ ...t, uses: t.uses ?? 0 })), talkRecall: mem.talkRecall },
      collect: { state: collect?.state ?? null, collecting, lost },
      versions: { state: versions.state, data: versions.data, busy: versionBusy, say: versionSay, canAdopt: !!client?.adoptMyMindVersion, canRollback: !!client?.rollbackMyMind },
    }, compose)
    return { plan: compose('mind', facts), data }
  }, [state, mind, absentWhy, presence, openTalks, hands, handed, editing, problem, mem, collect, collecting, lost, versions.state, versions.data, versionBusy, versionSay, client, compose])

  const saveName = async (value: string) => {
    if (!mind || renaming.current) return
    if (value === mind.name) return (setEditing(false), setProblem(null))
    renaming.current = true
    const binding = bindEpoch()
    const why = await rename(value)
    renaming.current = false
    binding.commit(() => {
      if (why) return setProblem(why)
      setEditing(false)
      setProblem(null)
    })
  }

  const changeVersion = async (what: 'adopt' | 'rollback') => {
    if (!mind || versionBusy) return
    const current = versions.data?.current ?? null
    const better = betterOf(versions.data)
    if (what === 'adopt' && !better) return
    const binding = bindEpoch()
    const ok = await askConfirmBound(
      what === 'adopt' ? `Switch ${mind.name} to ${better!.label}? You can roll back to ${current?.label ?? 'the version before'} afterwards.` : `Roll ${mind.name} back to the version before?`,
      what === 'adopt' ? `Adopt ${better!.label}` : 'Roll back',
      { binding },
    )
    if (!ok) return
    setVersionBusy(true)
    setVersionSay(null)
    try {
      const raw = what === 'adopt' ? await client!.adoptMyMindVersion!(better!.id) : await client!.rollbackMyMind!()
      binding.commit(() => {
        setVersionBusy(false)
        versions.set(readPersonalMind(raw))
        versions.reload()
        setVersionSay(what === 'adopt' ? `${mind.name} now runs ${better!.label}.` : `${mind.name} is back on the version before.`)
      })
    } catch (e) {
      binding.commit(() => {
        setVersionBusy(false)
        const code = e instanceof ApiError ? e.code : ''
        setVersionSay(code === 'already_current' ? `${mind.name} already runs that version.` : code === 'nothing_to_roll_back' ? 'There is no earlier version to go back to.' : code === 'unknown_version' ? 'That version is no longer offered.' : 'That could not be done just now. Nothing changed.')
      })
    }
  }

  const nowAct = hands?.rows.findLast((r) => r.state === 'now') ?? null
  const host: ScreenHost = {
    data,
    islands: {
      'figure': mind ? (
        <MindPortrait name={mind.name} presence={presence} notes={mem.beliefs.length} talks={mem.talks.length} acting={acting}
          version={(versions.data?.current ?? mind.version)?.label ?? null} allowance={mind.allowance_usd}
          hands={nowAct ? nowAct.text.slice(0, 32) : acting ? 'on your screen' : 'resting'} />
      ) : null,
      'notes': (
        <ul className="rounded-xl border border-line px-3" aria-label="Notes">
          {beliefs.map((b) => (
            <BeliefRow key={b.id} b={b} />
          ))}
        </ul>
      ),
      'keep-safe': <MemoryDurability compact />,
    },
    onAction: (action, item, value) => {
      if (action === 'retry') return void load()
      if (action === 'back') return navigate({ name: 'me' })
      if (action === 'rename-open') return (setProblem(null), setEditing(true))
      if (action === 'rename') return void saveName(typeof item.value === 'string' ? item.value : '')
      if (action === 'stop-rename') return renaming.current ? undefined : (setEditing(false), setProblem(null))
      if (action === 'take-over') return useAskStore.getState().personTookOver()
      if (action === 'talk-recall') return askMemory.setTalkRecall(value === true)
      if (action === 'adopt' || action === 'rollback') return void changeVersion(action)
      // a press on a conversation comes back scoped [card, conversation]
      const id = scopeOf(item).at(-1)
      if (!id) return
      if (action === 'toggle-talk') {
        setOpenTalks((s) => {
          const next = new Set(s)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      } else if (action === 'forget-talk') askMemory.forgetTalk(id)
    },
  }

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
      <div className="mx-auto max-w-[1200px] px-4 pt-2 pb-28 md:px-6" data-mind-look={figureLook}>
        <Screen plan={plan} host={host} />
      </div>
    </Page>
  )
}

type VersionsRead = { state: VersionsState; data: MindVersions | null; reload: () => void; set: (m: PersonalMind | null) => void }

/** GET /api/me/mind/versions once the person's mind is read; a host without it (404) is "comes later", nothing else. */
function useVersions(enabled: boolean): VersionsRead {
  const client = useHive((s) => s.client)
  const [state, setState] = useState<VersionsState>('loading')
  const [data, setData] = useState<MindVersions | null>(null)
  const [n, setN] = useState(0)
  useEffect(() => {
    let live = true
    const binding = bindEpoch()
    if (!enabled || !client?.myMindVersions) return
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
  }, [client, n, enabled])
  // a client without the route at all: "comes later", as on a host that answers 404
  return { state: client?.myMindVersions ? state : 'later', data, reload: () => setN((x) => x + 1), set: (m) => m && useMind.setState({ mind: m }) }
}
