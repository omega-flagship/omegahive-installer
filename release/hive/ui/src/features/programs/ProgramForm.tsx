import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Program, ProgramDescription, ProgramStage, WorkGraph } from '../../api/types'
import { baseRevisionOf, FORMS, NATIVE_GRAMMARS, type ActContext, type FormActResult, type FormId, type Grammar } from '../../forms/contract'
import { actErrorResult } from '../../forms/actResult'
import { dressedIn } from '../../forms/chromeDress'
import { sessionKey } from '../../store/programSession'
import { useHive } from '../../store/store'
import { needsConfirm, prepareConfirm } from '../../lib/hostConfirm'
import { finalAsResult, useHostConfirm } from './HostConfirm'
import type { CreationReference } from '../../lib/router'
import { RefusedHere } from './RefusedHere'

type ProgramFormProps = { form: FormId; program: Program; swarmId: string; grammar: Grammar; source?: CreationReference; onDirty?: (dirty: boolean) => void; openOwn?: () => void; onExit?: () => void }

/**
 * Hosts an app's form (forms/contract.ts) on the app page: opens the same program session as the generic stage,
 * binds swarm and base revision into act(), refreshes after each action, and renders the form in the grammar of the
 * experience the person is in when the form has one (Truth in Still is a legal brief; in Construct, a case docket).
 */
export function ProgramForm(props: ProgramFormProps) {
  const { form, program, swarmId } = props
  const key = sessionKey(program.id, swarmId)
  const session = useHive((s) => s.programSessions[key])
  const detail = useHive((s) => s.programDetails[program.id])
  const openProgram = useHive((s) => s.openProgram)
  const loadProgram = useHive((s) => s.loadProgram)
  useEffect(() => {
    void openProgram(program.id, swarmId)
    if (!detail) void loadProgram(program.id)
  }, [openProgram, loadProgram, program.id, swarmId, detail])

  // an app this swarm refuses: the same RefusedHere as the generic stage (ProgramHost), never a bare error line, and
  // with a working Back whether or not the caller gave an onExit (Kimi town-r3 #4)
  if (!session?.graph && session?.error?.code === 'program_refused') {
    return <div className="h-full overflow-y-auto pt-3"><RefusedHere programId={program.id} swarmId={swarmId} programName={program.name} message={session.error.message} onExit={props.onExit} /></div>
  }
  if (!session?.graph) {
    return <div className="grid h-full place-items-center text-[13px] text-ink-3">{session?.error ? `Could not open ${program.name}: ${session.error.message}` : `Opening ${program.name}…`}</div>
  }
  // Design parent r2: the rendered form and its confirmation controller retire together when this ready body leaves
  // (graph withdrawn, another app/swarm/form). A source change retires the old source's callbacks and confirm inside
  // the body (sourceGeneration below) without remounting the form, so the form keeps its own state and receipts.
  return <ReadyProgramForm key={JSON.stringify([key, form])} {...props} graph={session.graph} describe={detail?.describe ?? null} busy={!!session.busy} />
}

function ReadyProgramForm({ form, program, swarmId, grammar, source, onDirty, openOwn, graph, describe, busy }: ProgramFormProps & { graph: WorkGraph; describe: ProgramDescription | null; busy: boolean }) {
  const key = sessionKey(program.id, swarmId)
  // §9d: a confirm action is confirmed by the person in the host (or in the form's own full-context dialog) first
  const confirm = useHostConfirm(program.id, swarmId)   // review B1: bound to this app and swarm
  // Retained callbacks belong to this mounted ready body and to the source it was rendered for.
  // Stand-in r4 B1 (Design parent r2's epoch check restored): callbacks are bound to the lifetime epoch they were
  // rendered under; a cleanup moves it on, and a StrictMode replay publishes fresh callbacks by rendering again.
  const lifetime = useRef({ active: true, epoch: 0 })
  const [lifeEpoch, setLifeEpoch] = useState(0)
  const cancelAll = confirm.cancelAll
  useLayoutEffect(() => {
    const own = lifetime.current
    own.active = true   // StrictMode replay: the same body again (callbacks rendered before it stay retired)
    if (own.epoch > 0) void Promise.resolve().then(() => { if (own.active) setLifeEpoch(own.epoch) })
    return () => {
      own.active = false   // refuse new entry before cancelling the existing intent
      own.epoch++
      cancelAll()
    }
  }, [cancelAll])
  // Design source-reference r1, done in place: the canonical source tuple (key order is not identity). Every change,
  // A→B→A included, starts a new generation; callbacks rendered for an older one refuse, and its open confirm closes.
  const sourceKey = JSON.stringify(source ? [source.artifact_id, source.revision, source.digest] : null)
  const [sourceGen, setSourceGen] = useState({ key: sourceKey, gen: 0 })
  if (sourceGen.key !== sourceKey) setSourceGen({ key: sourceKey, gen: sourceGen.gen + 1 })   // adjusted while rendering
  const gen = sourceGen.key === sourceKey ? sourceGen.gen : sourceGen.gen + 1
  const liveGen = useRef(gen)
  useLayoutEffect(() => {
    if (liveGen.current === gen) return
    liveGen.current = gen
    cancelAll()
  }, [gen, cancelAll])
  const bodyLive = useCallback(() => lifetime.current.active && lifetime.current.epoch === lifeEpoch && liveGen.current === gen, [gen, lifeEpoch])
  const ask = confirm.ask
  const act = useCallback(
    async (action: string, items: string[], params: Record<string, unknown> = {}, ctx?: ActContext): Promise<FormActResult> => {
      if (!bodyLive()) return { status: 'refused', message: 'This app view is no longer open. Reopen it before acting.' }
      const { client, programSessions, programRefresh } = useHive.getState()
      const s = programSessions[key]
      if (!client) return { status: 'error', message: 'Not connected to the hive.' }
      // Review C2: a form that confirmed against a revision it showed sends exactly that one; the host refuses it if
      // the record has moved on. Only a form that inspected nothing falls back to the session's current revision.
      const base_revision = baseRevisionOf(ctx, s?.graph?.revision)
      try {
        const body = { swarm_id: swarmId, action, items, params, base_revision }
        const describe = useHive.getState().programDetails[program.id]?.describe ?? null
        let r: FormActResult
        if (needsConfirm(describe, action)) {
          // the form's own dialog (ctx.confirmed) was the person's confirm: no second dialog; otherwise the host asks
          const p = prepareConfirm(program.id, body, describe)
          if (!p.ok) return { status: 'refused', message: p.message }
          const f = await ask(p.intent, {}, { preconfirmed: ctx?.confirmed === true })
          // review B1: cancelled by an identity change (or unmount): its sentence only; nothing is refreshed or loaded
          if (f.kind === 'stale') return finalAsResult(f)
          r = finalAsResult(f)
        } else r = await client.programAct(program.id, body)
        // an outcome that is not known (Review B1, commons f0818d8) is read again like a taken one: it may have happened
        if (bodyLive() && (r.unknown || (r.status !== 'refused' && r.status !== 'error'))) void programRefresh(key)
        if (bodyLive() && (r.status === 'started' || r.unknown)) void useHive.getState().loadGoals(swarmId, true).catch(() => undefined)
        return r
      } catch (e) {
        // Review B1 (commons f0818d8): a lost answer or a 5xx after sending is `unknown`, never a known refusal
        const r = actErrorResult(e)
        if (r.unknown) {
          if (bodyLive()) void programRefresh(key)
          if (bodyLive()) void useHive.getState().loadGoals(swarmId, true).catch(() => undefined)
        }
        return r
      }
    },
    [key, program.id, swarmId, ask, bodyLive],
  )
  const focus = useCallback(() => undefined, [])
  // A read of another focus/stage (a belief unfolded), bound to this program and swarm; the session stays where it is.
  const view = useCallback(
    async (focus: string | null, stage?: ProgramStage) => {
      if (!bodyLive()) throw new Error('This app view is no longer open.')
      const { client } = useHive.getState()
      if (!client) throw new Error('Not connected to the hive.')
      const result = await client.programView(program.id, { swarm_id: swarmId, focus, stage })
      if (!bodyLive()) throw new Error('This app view is no longer open.')
      return result
    },
    [program.id, swarmId, bodyLive],
  )

  const Form = FORMS[form]
  // The program decides who may see a record: Atlas returns its subject only to a viewer it has enrolled. So a graph
  // that carries a subject is this person's own; anything else shows the empty Atlas (or a sample they choose).
  const isOwner = graph.items.some((it) => it.kind === 'subject')
  const g: Grammar = NATIVE_GRAMMARS[form].includes(grammar) ? grammar : 'classic'
  // no rendering of its own for this experience: the classic layout, dressed in the experience's chrome
  const dressFrom = dressedIn(form, grammar) ? grammar : undefined
  return (
    <div className="h-full min-h-0 overflow-y-auto" data-app-form={form}>
      <Suspense fallback={<div className="grid h-full place-items-center text-[13px] text-ink-3">Opening {program.name}…</div>}>
        <Form program={program} describe={describe} graph={graph} grammar={g} act={act} focus={focus} busy={busy} viewer={{ isOwner }} view={view} scope={swarmId} source={source} onDirty={onDirty} openOwn={openOwn} dressFrom={dressFrom} />
      </Suspense>
      {confirm.dialog}
    </div>
  )
}
