import { plural } from '../../lib/plural'
import { AnimatePresence, LayoutGroup, m } from 'framer-motion'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ProgramAction, ProgramStage, WorkItem } from '../../api/types'
import { cx } from '../../lib/cx'
import { isTypingTarget, useReducedMotion } from '../../lib/hooks'
import { actionsFor, currentStep, resolveFocus, sessionKey, type TrailStep } from '../../store/programSession'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { Button, EmptyState, ErrorState, Segmented, Skeleton } from '../../ui/primitives'
import { Detail } from './Detail'
import { indexGraph, type GraphIndex } from './layout'
import { POL, programBackOrExit, STAGE_ICON, STAGE_WORDS } from './style'
import { ActionBar, InputForm, ItemSummary, NoticeBar, SourcesPanel, TaskChips } from './Rail'
import { ResultPanel } from './ResultPanel'
import { collectSources } from './sources'
import { Scene } from './Scene'
import FusionComposer from './FusionComposer'
import { RefusedHere } from './RefusedHere'
import { useConfirmedProgramAct } from './HostConfirm'

const STAGES: ProgramStage[] = ['unfold', 'map', 'compare', 'detail']

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}


function shortLabel(s: string, n = 34) {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s
}

/** Labels of every item seen, so a crumb keeps its words when a narrower view no longer holds the item. */
const seenLabels = new Map<string, string>()

function stepLabel(step: TrailStep, gi: GraphIndex | null, programId: string): string {
  if (step.stage === 'compare') return step.compare?.length ? plural(step.compare.length, 'item') : 'groups'
  const label = step.focus ? (gi?.items.get(step.focus)?.label ?? seenLabels.get(`${programId}\u0000${step.focus}`)) : null
  return label ? shortLabel(label) : step.focus ? step.focus : 'start'
}

/**
 * The adaptive host for one program in one swarm. The platform owns layout, stage transitions,
 * accessibility and the restored trail; the program owns meaning and returns data only. Program text
 * is always rendered as text.
 */
type HostProps = { programId: string; swarmId: string; variant: 'page' | 'panel'; onExit: () => void }

export default function ProgramHost(props: HostProps) {
  const [ref, width] = useWidth<HTMLDivElement>()
  return (
    <div ref={ref} className="flex h-full min-h-0 flex-col">
      {width > 0 && <Host {...props} width={width} />}
    </div>
  )
}

function Host({ programId, swarmId, variant, onExit, width }: HostProps & { width: number }) {
  const key = sessionKey(programId, swarmId)
  const session = useHive((s) => s.programSessions[key])
  const detail = useHive((s) => s.programDetails[programId])
  const program = useHive((s) => s.programs?.find((p) => p.id === programId))
  const openProgram = useHive((s) => s.openProgram)
  const go = useHive((s) => s.programGo)
  const jump = useHive((s) => s.programJump)
  const select = useHive((s) => s.programSelect)
  // §9d: confirm actions are asked in the host and sent with its token; the rest go to store.programAct unchanged
  const { act, dialog: confirmDialog } = useConfirmedProgramAct(programId, swarmId)   // review B1: bound to this app and swarm
  const dismiss = useHive((s) => s.programDismiss)
  const refresh = useHive((s) => s.programRefresh)
  const cancelTask = useHive((s) => s.programCancelTask)
  const setEnabled = useHive((s) => s.setProgramEnabled)
  const reduced = useReducedMotion()
  const narrow = variant === 'panel' || width < 980
  const [selectMode, setSelectMode] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const scope = `${variant}-${programId}`

  useEffect(() => {
    void openProgram(programId, swarmId)
  }, [openProgram, programId, swarmId])

  const graph = session?.graph ?? null
  const describe = detail?.describe ?? null
  const gi = useMemo(() => (graph ? indexGraph(graph, describe) : null), [graph, describe])
  useEffect(() => {
    for (const it of graph?.items ?? []) seenLabels.set(`${programId}\u0000${it.id}`, it.label)
  }, [graph, programId])
  const rawStep = session ? currentStep(session) : null
  const focus = rawStep ? resolveFocus(rawStep, graph) : null
  const step = useMemo<TrailStep | null>(() => (rawStep ? { ...rawStep, focus } : null), [rawStep, focus])
  const selection = useMemo(() => session?.selection ?? [], [session?.selection])
  const subjects = useMemo(() => (selection.length ? selection : focus ? [focus] : []), [selection, focus])
  const subjectItems = useMemo(() => subjects.map((id) => gi?.items.get(id)).filter((x): x is WorkItem => !!x), [subjects, gi])
  const allActions = useMemo(() => (describe?.actions ?? []).filter(a => programId !== 'omegafusion' || !['human-forecast','human-reconcile'].includes(a.id)), [describe, programId])
  const applicable = useMemo(() => actionsFor(allActions, [...new Set(subjectItems.map((i) => i.kind))]), [allActions, subjectItems])
  const inspectFor = useCallback((id: string) => {
    const it = gi?.items.get(id)
    return !!it && actionsFor(allActions, [it.kind]).some((a) => a.id === 'inspect-source')
  }, [gi, allActions])
  const busy = session?.busy ?? null

  const back = useCallback(() => programBackOrExit(key, onExit), [key, onExit])
  const pushStage = useCallback(
    (stage: ProgramStage, id: string | null, compare?: string[]) => {
      setSelectMode(false)
      go(key, stage === 'compare' ? { stage, focus: id, compare: compare ?? [] } : { stage, focus: id })
    },
    [go, key],
  )
  const compare = useCallback(
    (ids: string[]) => {
      const kinds = [...new Set(ids.map((id) => gi?.items.get(id)?.kind).filter((k): k is string => !!k))]
      const programCompare = actionsFor(allActions, kinds).find((a) => a.id === 'compare' || a.stage === 'compare')
      setSelectMode(false)
      if (programCompare) void act(key, programCompare.id, ids)
      else go(key, { stage: 'compare', focus: ids[0], compare: ids })
    },
    [gi, allActions, act, go, key],
  )
  const runAction = useCallback(
    (a: ProgramAction, ids: string[]) => {
      if (a.id === 'compare' || a.stage === 'compare') {
        if (ids.length >= 2) return compare(ids)
      }
      void act(key, a.id, ids)
    },
    [act, compare, key],
  )
  const pick = useCallback(
    (id: string, additive: boolean) => {
      const cur = useHive.getState().programSessions[key]?.selection ?? []
      if (additive || selectMode) select(key, cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id])
      else if (cur.length === 1 && cur[0] === id) pushStage('detail', id) // a second tap opens it
      else select(key, [id])
    },
    [key, select, selectMode, pushStage],
  )

  // keyboard: Backspace or Alt+← goes back; 1–4 switch stage (Esc is the escape stack's: back one level)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || useHive.getState().paletteOpen || e.metaKey || e.ctrlKey) return
      if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowLeft')) {
        e.preventDefault()
        back()
      } else if (!e.altKey && ['1', '2', '3', '4'].includes(e.key) && step) {
        const stage = STAGES[Number(e.key) - 1]
        e.preventDefault()
        pushStage(stage, step.focus, stage === 'compare' && selection.length >= 2 ? selection : undefined)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [back, pushStage, step, selection])

  const notesRow = graph?.notes.length ? (
    <p className="flex min-w-0 items-start gap-1.5 text-[11.5px] leading-snug text-ink-3" role="note" aria-label="Program notes">
      <Icon name="info" size={13} className="mt-px shrink-0 text-ink-4" />
      <span className="min-w-0">{graph.notes.join(' · ')}</span>
    </p>
  ) : null

  // ---------------------------------------------------------------- states before a graph
  let body: React.ReactNode = null
  if (!session || (!graph && !session.error)) {
    body = (
      <div className="flex flex-1 flex-col gap-3 p-3 md:p-5">
        <Skeleton className="h-9 w-2/3 rounded-xl" />
        <div className="relative flex flex-1 items-center justify-center rounded-[20px] border border-line">
          <div className="eyebrow animate-pulse">Unfolding the work…</div>
        </div>
      </div>
    )
  } else if (session.error && !graph) {
    const e = session.error
    body =
      e.code === 'program_disabled' ? (
        <EmptyState icon="power" title="This app is turned off" body="An operator disabled it. Turn it back on to open its work here." action={<Button variant="primary" icon="power" onClick={() => void setEnabled(programId, true)}>Enable {program?.name ?? programId}</Button>} />
      ) : e.code === 'program_refused' ? (
        <RefusedHere programId={programId} swarmId={swarmId} programName={program?.name ?? programId} message={e.message} onExit={onExit} />
      ) : e.code === 'not_found' ? (
        <EmptyState icon="apps" title="No such app" body={e.message} action={<Button onClick={onExit}>Back</Button>} />
      ) : (
        <ErrorState title={e.code === 'program_error' ? 'The app failed' : e.code === 'bad_graph' ? 'The app broke the contract' : 'Could not open the app'} body={`${e.message}`} onRetry={() => void refresh(key)} />
      )
  }

  if (body || !session || !graph || !gi || !step) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {body}
      </div>
    )
  }

  const trail = session.trail
  const sources = collectSources(gi, subjects)
  const sharedOrigins = sources.groups.filter((g) => g.shared).length
  const sourceCount = sources.groups.reduce((n, g) => n + g.uses.length, 0)
  const inputDef = session.input ? allActions.find((a) => a.id === session.input!.action) : undefined
  const result = session.result
  // a result about the item open in detail is shown inside it; any other result floats over the stage
  const detailFocus = step.stage === 'detail' && step.focus && graph.items.length > 0 ? step.focus : null
  const resultInDetail = !!result && !!detailFocus && (!result.items.length || result.items.includes(detailFocus))

  const bar = (
    <div className={cx('flex min-w-0 shrink-0 items-center gap-2', narrow ? 'px-3' : 'px-0')} data-tour="program-bar">
      <Button variant="subtle" icon="back" onClick={back} data-tour="program-back" className="min-h-9 shrink-0 rounded-xl px-2.5 text-[13px]" aria-label={trail.length > 1 ? `Back to ${STAGE_WORDS[trail[trail.length - 2].stage]}` : 'Leave the program'} title="Back (Backspace, Alt+←, Esc)">
        {narrow ? null : trail.length > 1 ? 'Back' : 'Leave'}
      </Button>
      <nav aria-label="Trail" className="no-scrollbar min-w-0 flex-1 overflow-x-auto" style={trail.length > 2 ? { maskImage: 'linear-gradient(90deg, transparent, #000 28px)', WebkitMaskImage: 'linear-gradient(90deg, transparent, #000 28px)' } : undefined}>
        <TrailCrumbs trail={trail} gi={gi} programId={programId} narrow={narrow} onJump={(i) => jump(key, i)} />
      </nav>
      <RevisionChip revision={graph.revision} loading={session.loading} />
    </div>
  )

  const stageSwitch = (
    <Segmented<ProgramStage>
      label="Stage"
      tour="program-stage"
      dense={narrow}
      value={step.stage}
      onChange={(s) => pushStage(s, step.focus, s === 'compare' && selection.length >= 2 ? selection : undefined)}
      className={narrow ? 'w-full' : undefined}
      options={STAGES.map((s) => ({ value: s, label: STAGE_WORDS[s], badge: session.suggestion === s ? <span className="size-1.5 rounded-full bg-accent-2 shadow-[0_0_8px_#6ee7ff]" aria-label="suggested" /> : undefined }))}
    />
  )

  const suggestion = session.suggestion && (
    <m.div initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} className="flex shrink-0 items-center gap-1 rounded-xl border border-accent-2/25 bg-accent-2/[0.06] py-1 pr-1 pl-2.5 text-[12px] text-ink-2">
      <Icon name="sparkles" size={13} className="text-accent-2" />
      <span>
        The program suggests <b className="font-semibold text-ink">{STAGE_WORDS[session.suggestion]}</b>
      </span>
      <button className="rounded-lg px-2 py-1 font-semibold text-accent-2 hover:bg-accent-2/10" onClick={() => pushStage(session.suggestion!, step.focus)}>
        Switch
      </button>
      <button className="rounded-lg p-1 text-ink-4 hover:text-ink" onClick={() => dismiss(key, 'suggestion')} aria-label="Dismiss suggestion">
        <Icon name="x" size={13} />
      </button>
    </m.div>
  )

  const overlays = (
    <div className={cx('pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col items-center gap-2', narrow ? 'p-2' : 'p-3')}>
      <AnimatePresence>
        {result && !resultInDetail && (
          <div key={`result-${result.seq}`} className="thin-scroll pointer-events-auto max-h-[min(58vh,560px)] w-full max-w-[640px] overflow-y-auto overscroll-contain rounded-2xl shadow-[0_24px_70px_-30px_rgb(0_0_0/0.9)]">
            <ResultPanel result={result} currentRevision={graph.revision} itemLabel={(x) => gi.items.get(x)?.label ?? seenLabels.get(`${programId}\u0000${x}`) ?? x} onClose={() => dismiss(key, 'result')} />
          </div>
        )}
        {session.notice && (
          <div key={session.notice.id} className="pointer-events-auto w-full max-w-[560px]">
            <NoticeBar notice={session.notice} onDismiss={() => dismiss(key, 'notice')} />
          </div>
        )}
        {session.input && (
          <div key={`input-${session.input.action}`} className="pointer-events-auto w-full max-w-[560px]">
            <InputForm input={session.input} def={inputDef} busy={!!busy} onCancel={() => dismiss(key, 'input')} onSubmit={(params) => void act(key, session.input!.action, session.input!.items.length ? session.input!.items : subjects, params)} />
          </div>
        )}
      </AnimatePresence>
    </div>
  )

  const stage = (
    <div className={cx('relative min-h-0 flex-1 overflow-hidden', !narrow && 'rounded-[20px] border border-line')} data-tour="program-stage-view" style={{ background: 'radial-gradient(80% 70% at 50% 40%, rgb(70 60 160 / 0.14), color-mix(in oklab, var(--color-void) 35%, transparent))' }}>
      {graph.items.length === 0 ? (
        <EmptyState icon="sparkles" title="Nothing here yet" body={graph.notes[0] ?? 'The program returned an empty view.'} />
      ) : step.stage === 'detail' && step.focus ? (
        <Detail
          key={step.focus}
          graph={graph}
          gi={gi}
          id={step.focus}
          scope={scope}
          swarmId={swarmId}
          actions={actionsFor(allActions, [gi.items.get(step.focus)?.kind ?? ''])}
          busy={busy}
          sourceDetail={session.sourceDetail}
          result={result}
          onCloseResult={() => dismiss(key, 'result')}
          onOpen={(id) => pushStage('detail', id)}
          onAct={runAction}
          onInspect={(id) => void act(key, 'inspect-source', [id])}
          inspectable={inspectFor(step.focus)}
        />
      ) : (
        <Scene graph={graph} describe={describe} gi={gi} step={step} trail={trail} selection={selection} scope={scope} onPick={pick} onOpen={(id) => pushStage('detail', id)} onClear={() => select(key, [])} />
      )}
      {narrow && <div className="pointer-events-none absolute inset-x-0 top-0 z-[5] h-5 bg-gradient-to-b from-[#07071a] to-transparent" aria-hidden="true" />}
      {overlays}
      {!narrow && step.stage !== 'detail' && !session.notice && !session.input && !result && <Legend />}
      {!narrow && step.stage !== 'detail' && !selection.length && !reduced && !session.notice && !session.input && !result && (
        <div className="pointer-events-none absolute right-3 bottom-3 rounded-lg bg-shade/30 px-2 py-1 text-[11px] text-ink-4">{narrow ? 'Tap to select · tap again to open' : 'Click to select · shift-click to add · double-click to open'}</div>
      )}
    </div>
  )

  const subjectBlock = subjectItems.length > 0 && (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <h3 className="eyebrow">{selection.length > 1 ? `${selection.length} selected` : selection.length ? 'Selected' : 'In focus'}</h3>
        <span className="flex-1" />
        {selection.length > 0 && (
          <button className="text-[11.5px] text-ink-3 hover:text-ink" onClick={() => select(key, [])}>
            Clear
          </button>
        )}
      </div>
      {subjectItems.length === 1 ? (
        <ItemSummary item={subjectItems[0]} gi={gi} compact={narrow} />
      ) : (
        <ul className="space-y-1">
          {subjectItems.map((it) => (
            <li key={it.id} className="truncate text-[12.5px] text-ink-2">
              <span className="font-mono text-[10.5px] text-ink-4">{it.id}</span> {it.label}
            </li>
          ))}
        </ul>
      )}
      <ActionBar items={subjectItems} gi={gi} actions={applicable} busy={busy} compact={narrow} onNav={(s, id) => pushStage(s, id)} onCompare={compare} onAct={runAction} />
      {narrow && step.stage !== 'detail' && (
        <button onClick={() => setSelectMode(!selectMode)} aria-pressed={selectMode} className={cx('inline-flex min-h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px]', selectMode ? 'border-accent-2/60 bg-accent-2/10 text-accent-2' : 'border-line text-ink-3')}>
          <Icon name="plus" size={13} />
          {selectMode ? 'Selecting: tap items to add' : 'Select more'}
        </button>
      )}
    </div>
  )

  const sourcesPanel = (
    <SourcesPanel
      gi={gi}
      subjects={subjects}
      inspectable={inspectFor}
      inspecting={!!busy}
      onInspect={(id) => void act(key, 'inspect-source', [id])}
      detail={session.sourceDetail}
      onCloseDetail={() => dismiss(key, 'source')}
      onSelect={(id) => select(key, [id])}
    />
  )

  const tasks = <TaskChips tasks={session.tasks} swarmId={swarmId} onCancel={(id) => void cancelTask(key, id)} />

  return (
    <LayoutGroup id={scope}>
      <div className={cx('flex min-h-0 flex-1 flex-col', narrow ? 'gap-2 pt-1' : 'gap-3 px-6 pb-5')}>
        {bar}
        {confirmDialog}
        {programId === 'omegafusion' && describe?.actions.some(a => a.id === 'human-forecast') && describe.actions.some(a => a.id === 'human-reconcile') && <FusionComposer swarmId={swarmId} />}
        <div className={cx('flex min-w-0 shrink-0 flex-wrap items-center gap-2', narrow && 'px-3')}>
          {stageSwitch}
          <AnimatePresence>{suggestion}</AnimatePresence>
          {!narrow && <div className="min-w-0 flex-1">{notesRow}</div>}
        </div>
        {narrow && notesRow && <div className="px-3">{notesRow}</div>}
        {narrow && session.tasks.length > 0 && <div className="px-3">{tasks}</div>}
        {narrow ? (
          <>
            {stage}
            <Drawer
              open={drawer}
              setOpen={setDrawer}
              subject={subjectItems}
              gi={gi}
              sourceCount={sourceCount}
              shared={sharedOrigins}
              quick={
                selection.length > 0 && !drawer ? (
                  <ActionBar items={subjectItems} gi={gi} actions={[]} busy={busy} compact onNav={(st, id) => pushStage(st, id)} onCompare={compare} onAct={runAction} />
                ) : null
              }
            >
              {subjectBlock}
              <div className="mt-4">{sourcesPanel}</div>
            </Drawer>
          </>
        ) : (
          <div className="grid min-h-0 flex-1 gap-4" style={{ gridTemplateColumns: 'minmax(0, 1fr) 340px' }}>
            {stage}
            <aside className="thin-scroll min-h-0 space-y-5 overflow-y-auto pr-1" aria-label="Inspector">
              {subjectBlock}
              {tasks}
              {sourcesPanel}
            </aside>
          </div>
        )}
      </div>
    </LayoutGroup>
  )
}

// ---------------------------------------------------------------- trail, revision, legend, drawer

function TrailCrumbs({ trail, gi, programId, narrow, onJump }: { trail: TrailStep[]; gi: GraphIndex; programId: string; narrow: boolean; onJump(i: number): void }) {
  const ref = useRef<HTMLOListElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.parentElement?.scrollTo({ left: el.scrollWidth, behavior: 'smooth' })
  }, [trail.length])
  return (
    <ol ref={ref} className="flex w-max items-center gap-1">
      {trail.map((t, i) => {
        const last = i === trail.length - 1
        return (
          <li key={i} className="flex items-center gap-1">
            {i > 0 && <Icon name="chevron" size={12} className="shrink-0 text-ink-4" aria-hidden="true" />}
            <button
              onClick={() => onJump(i)}
              disabled={last}
              aria-current={last ? 'step' : undefined}
              className={cx('inline-flex min-h-8 items-center', narrow ? 'max-w-[190px]' : 'max-w-[220px]', ' gap-1.5 rounded-lg px-2 text-[12px] whitespace-nowrap transition-colors', last ? 'border border-line-2 bg-tint/[0.07] text-ink' : 'text-ink-3 hover:bg-tint/[0.05] hover:text-ink')}
              title={`${STAGE_WORDS[t.stage]} · ${t.focus ? (gi.items.get(t.focus)?.label ?? t.focus) : 'start'}`}
            >
              <Icon name={STAGE_ICON[t.stage]} size={13} className="shrink-0" />
              <span className="font-medium">{STAGE_WORDS[t.stage]}</span>
              <span className="truncate text-ink-4">{stepLabel(t, gi, programId)}</span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}

function RevisionChip({ revision, loading }: { revision: string; loading: boolean }) {
  const [flash, setFlash] = useState(false)
  const prev = useRef(revision)
  useEffect(() => {
    if (prev.current === revision) return
    prev.current = revision
    setFlash(true)
    const t = setTimeout(() => setFlash(false), 2400)
    return () => clearTimeout(t)
  }, [revision])
  return (
    <span className={cx('relative inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 font-mono text-[11px] transition-colors', flash ? 'border-accent-2/60 text-accent-2' : 'border-line text-ink-3')} title={`Revision ${revision}: changes whenever the program's content changes`} aria-live="polite">
      <span className={cx('size-1.5 rounded-full', loading ? 'animate-pulse bg-ink-3' : flash ? 'bg-accent-2' : 'bg-good')} aria-hidden="true" />
      <span className="sr-only">Revision</span>
      {revision}
    </span>
  )
}

function Legend() {
  const rows: [keyof typeof POL, string][] = [
    ['support', '0'],
    ['oppose', '6 5'],
    ['qualify', '2 4'],
    ['neutral', '1 5'],
  ]
  return (
    <div className="pointer-events-none absolute bottom-3 left-16 z-[4] flex flex-wrap items-center gap-3 rounded-xl border border-line bg-[#08081c]/90 px-2.5 py-1.5 text-[11px] text-ink-3" aria-hidden="true">
      {rows.map(([p, dash]) => (
        <span key={p} className="inline-flex items-center gap-1.5">
          <svg width="22" height="6">
            <line x1="1" y1="3" x2="21" y2="3" stroke={POL[p].color} strokeWidth="2" strokeDasharray={dash === '0' ? undefined : dash} strokeLinecap="round" />
          </svg>
          {POL[p].label}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <span className="h-3 w-4 rounded border border-dashed border-[#fda4af]" />
        missing research
      </span>
    </div>
  )
}

function Drawer({ open, setOpen, subject, gi, sourceCount, shared, quick, children }: { open: boolean; setOpen(v: boolean): void; subject: WorkItem[]; gi: GraphIndex; sourceCount: number; shared: number; quick: React.ReactNode; children: React.ReactNode }) {
  const first = subject[0]
  return (
    <m.section layout className="glass-strong relative z-10 mx-0 shrink-0 overflow-hidden rounded-t-[22px] border-x-0 border-b-0" style={{ paddingBottom: 'calc(var(--sab) + 6px)' }} aria-label="Inspector">
      <button onClick={() => setOpen(!open)} className="flex min-h-14 w-full items-center gap-2.5 px-4 pt-1.5 text-left" aria-expanded={open} data-tour="program-drawer">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">{subject.length > 1 ? `${subject.length} selected` : first ? first.label : 'Nothing selected'}</span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-3">
            {first && subject.length === 1 && <span style={{ color: '#a5b4fc' }}>{gi.kindLabel(first.kind)}</span>}
            <Icon name="link" size={11} />
            {sourceCount} source{sourceCount === 1 ? '' : 's'}
            {shared > 0 && <span className="rounded border border-warn/40 bg-warn/12 px-1 text-[10px] font-semibold text-warn">same origin</span>}
          </span>
        </span>
        <Icon name="chevronDown" size={18} className={cx('shrink-0 text-ink-3 transition-transform', !open && 'rotate-180')} />
      </button>
      {quick && <div className="no-scrollbar overflow-x-auto px-4 pb-2">{quick}</div>}
      <AnimatePresence initial={false}>
        {open && (
          <m.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} transition={{ type: 'spring', stiffness: 380, damping: 38 }} className="overflow-hidden">
            <div className="thin-scroll max-h-[52dvh] overflow-y-auto px-4 pb-3">{children}</div>
          </m.div>
        )}
      </AnimatePresence>
    </m.section>
  )
}
