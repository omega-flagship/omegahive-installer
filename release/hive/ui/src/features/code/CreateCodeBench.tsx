/**
 * Create's Code bench: straight into a project, then the living canvas (benchOpen.ts says which project and why).
 * Opening a project here starts work on it (POST /api/code/open: a task and an edit grant for this person) with no
 * confirmation and no ids shown; a task saved in this browser is reused only once its grant checks out. The full Code
 * page (#/code) keeps its explicit, confirmed start.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAskStore } from '../../store/ask'
import { useHive } from '../../store/store'
import { useIdentityEpoch } from '../../lib/epochBound'
import { bindEpoch } from '../../lib/identityEpoch'
import { Button } from '../../ui/primitives'
import type { Opened, Target } from './CodePage'
import { usePrincipal } from './EditSession'
import { EmbeddedCodeWorkbench } from './EmbeddedCodeWorkbench'
import type { EmbeddedDepartureHandle } from './embeddedDeparture'
import { benchPlan, lastProject, rememberProject } from './benchOpen'
import { judgeSaved, notEditable, notEditableText, targetOpenable } from './editSessionRules'
import { dropSessionIf, readSession, saveSession } from './savedSession'
import './bench.css'

export default function CreateCodeBench(props: { onBack: () => void; departure: EmbeddedDepartureHandle }) {
  const epoch = useIdentityEpoch()
  return <BoundCodeBench key={epoch} {...props} />
}

type Stage =
  | { kind: 'reading' }
  | { kind: 'opening'; label: string }
  | { kind: 'choose'; targets: Target[]; notice: string | null }
  | { kind: 'none' }
  | { kind: 'error'; text: string }

const errText = (e: unknown) => (e as { message?: string } | null)?.message || 'The hive did not answer.'

function BoundCodeBench({ onBack, departure }: { onBack: () => void; departure: EmbeddedDepartureHandle }) {
  const binding = useMemo(() => bindEpoch(), [])
  const client = useHive((s) => s.client)
  const principal = usePrincipal()
  const [stage, setStage] = useState<Stage>({ kind: 'reading' })
  const [opened, setOpened] = useState<Opened | null>(null)
  const [targets, setTargets] = useState<Target[]>([])
  const [round, setRound] = useState(0)
  const [tries, setTries] = useState(0)
  const available = useAskStore((s) => s.settings?.capabilities?.code_test_intents === true)
  const leave = () => { binding.commit(onBack) }

  /** Open one project: reuse the saved task when its grant is this person's and active, else start fresh. */
  const open = useCallback(async (target: Target, reuse: boolean, all: Target[]) => {
    if (!client?.codeOpen) return binding.commit(() => setStage({ kind: 'error', text: 'This hive cannot open code here.' }))
    binding.commit(() => setStage({ kind: 'opening', label: target.label }))
    try {
      const saved = reuse ? readSession(principal, target.id) : null
      if (saved && client.goalGrants) {
        const read = await client.goalGrants(saved.task_id).then((grants) => ({ grants }), (error: unknown) => ({ error }))
        const judged = judgeSaved(saved, read, principal, Date.now() / 1000)
        if (judged.kind === 'offer') {
          rememberProject(principal, target.id)
          return binding.commit(() => setOpened({ target, task_id: saved.task_id, grant_id: saved.grant_id, repository_id: saved.repository_id, swarm_id: saved.swarm_id ?? '', base_commit: saved.base_commit ?? target.repo?.commit ?? '', ...(saved.workspace_id ? { workspace_id: saved.workspace_id } : {}) }))
        }
        if (judged.kind === 'drop') dropSessionIf(principal, target.id, saved)
      }
      const o = await client.codeOpen(target.id)
      const fresh: Opened = { ...o, target }
      saveSession(principal, target.id, fresh, true)
      rememberProject(principal, target.id)
      binding.commit(() => setOpened(fresh))
    } catch (e) {
      const r = notEditable(e)
      binding.commit(() => setStage(r
        ? { kind: 'choose', targets: all.filter((t) => t.id !== target.id), notice: notEditableText(r, target.label).body }
        : { kind: 'error', text: errText(e) }))
    }
  }, [binding, client, principal])

  useEffect(() => {
    if (principal === undefined || opened) return
    let live = true
    void (async () => {
      if (!client?.codeTargets) return binding.commit(() => setStage({ kind: 'error', text: 'This hive cannot open code here.' }))
      try {
        const all = await client.codeTargets()
        if (!live) return
        binding.commit(() => setTargets(all))
        const plan = round === 0 ? benchPlan(all, (id) => !!readSession(principal, id), lastProject(principal)) : { kind: 'choose' as const, targets: all.filter((t) => targetOpenable(t)) }
        if (plan.kind === 'open') await open(plan.target, plan.reuse, all)
        else binding.commit(() => setStage(plan.kind === 'choose' ? { kind: 'choose', targets: plan.targets, notice: null } : { kind: 'none' }))
      } catch (e) {
        if (live) binding.commit(() => setStage({ kind: 'error', text: errText(e) }))
      }
    })()
    return () => { live = false }
  }, [binding, client, open, opened, principal, round, tries])

  if (opened) return <EmbeddedCodeWorkbench
    attachment={{ task: opened.task_id, repository: opened.repository_id }}
    // Back: another project (round > 0 always shows the choice); Close: leave Code for Create
    onBack={() => binding.commit(() => { setOpened(null); setStage({ kind: 'reading' }); setRound((n) => n + 1) })}
    onClose={leave} departure={departure} sandboxTestAvailable={available}
    onGrantRefused={() => binding.commit(() => { dropSessionIf(principal, opened.target.id, opened); setOpened(null); setStage({ kind: 'opening', label: opened.target.label }); void open(opened.target, false, targets) })}
  />

  return <section aria-label="Code in Create" data-create-code="" className="flex h-full min-h-0 flex-col">
    <div className="flex shrink-0 items-center gap-3 px-4 py-2">
      <Button onClick={leave}>Back to Create</Button>
    </div>
    <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto px-4 pb-8 pt-[8vh]">
      {stage.kind === 'reading' || stage.kind === 'opening' ? (
        <div role="status" aria-live="polite" className="flex flex-col items-center gap-4 text-center">
          <span aria-hidden className="cc-open-orb" />
          <p className="text-[15px] text-ink-2">{stage.kind === 'opening' ? `Opening ${stage.label}…` : 'Finding your project…'}</p>
        </div>
      ) : stage.kind === 'choose' ? (
        <div className="w-full max-w-3xl space-y-5">
          <h2 className="text-center text-[20px] font-semibold tracking-tight text-ink">What are we working on?</h2>
          {stage.notice && <p role="status" className="mx-auto max-w-xl text-center text-[13px] text-ink-3">{stage.notice}</p>}
          <ul className="grid gap-3 sm:grid-cols-2" aria-label="Your projects">
            {stage.targets.map((t) => <li key={t.id}>
              <button type="button" className="cc-project group w-full text-left" onClick={() => void open(t, !!readSession(principal, t.id), targets)}>
                <span className="block text-[15px] font-semibold text-ink">{t.label}</span>
                {t.detail && <span className="mt-1 block text-[13px] leading-snug text-ink-3">{t.detail}</span>}
              </button>
            </li>)}
          </ul>
        </div>
      ) : stage.kind === 'none' ? (
        <div role="status" className="max-w-md space-y-2 text-center">
          <h2 className="text-[18px] font-semibold text-ink">No project to work on yet</h2>
          <p className="text-[13px] text-ink-3">Code opens a repository this hive can edit. When one is added, it opens here straight away.</p>
        </div>
      ) : (
        <div role="alert" className="max-w-md space-y-3 text-center">
          <h2 className="text-[18px] font-semibold text-ink">Code didn’t open</h2>
          <p className="text-[13px] text-ink-3">{stage.text}</p>
          <Button variant="primary" onClick={() => binding.commit(() => { setStage({ kind: 'reading' }); setRound(0); setOpened(null); setTries((n) => n + 1) })}>Try again</Button>
        </div>
      )}
    </div>
  </section>
}
