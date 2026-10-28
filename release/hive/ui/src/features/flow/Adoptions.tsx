import { AnimatePresence } from 'framer-motion'
import { useEffect, useMemo, useState } from 'react'
import type { FlowListRow, FlowRevisionRead } from '../../api/missingUi'
import { decisionFailure, type DecisionResult } from '../../lib/decisionGate'
import type { HiveClient } from '../../api/client'
import { shown } from '../../lib/displayName'
import { ago } from '../../lib/format'
import { errorMessage, has, need, useResource } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { boundRun, useIdentityEpoch } from '../../lib/epochBound'
import { bindEpoch, type Stale } from '../../lib/identityEpoch'
import { DecisionDialog } from '../../ui/DecisionDialog'
import { Button } from '../../ui/primitives'

/** Revision numbers to check, newest first (the host lists only a flow's latest revision). Pure. */
export const revisionsOf = (latest: number, shown = 5): number[] => Array.from({ length: Math.max(0, Math.min(latest, shown)) }, (_, i) => latest - i)

/**
 * What is adopted, and taking an adoption back (GET /api/swarms/{id}/flows, GET …/revisions/{n}, DELETE
 * …/revisions/{n}/adoption; Surface missing-UI batch 1, audit item 13). Adopting stays in the Flow studio, on the exact
 * revision it shows. Taking an adoption back stops new runs of that revision (the hive refuses to start an unadopted
 * revision); a named owner or admin decides, in full view of what was adopted, by whom and when.
 */
export function FlowAdoptions() {
  const client = useHive((s) => s.client)
  const swarms = useHive((s) => s.swarms)
  const list = useMemo(() => Object.values(swarms).filter((s) => !s.archived_at).sort((a, b) => a.name.localeCompare(b.name)), [swarms])
  const [open, setOpen] = useState(false)
  const [swarm, setSwarm] = useState('')
  const current = swarm || list[0]?.id || ''
  if (!has(client, 'flowList') || !has(client, 'flowRevision')) return null
  return (
    <section aria-labelledby="flow-adoptions-h" className="mx-3 my-2 rounded-2xl border border-line bg-white/[0.02] px-4 py-2.5 md:mx-6" data-flow-adoptions>
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="flow-adoptions-h" className="flex-1 text-[14px] font-medium text-ink">Adopted revisions</h2>
        {open && list.length > 1 && (
          <select aria-label="Swarm" value={current} onChange={(e) => setSwarm(e.target.value)} className="min-h-10 rounded-xl border border-line bg-black/30 px-2.5 text-[13px] text-ink outline-none focus:border-line-2">
            {list.map((s) => (
              <option key={s.id} value={s.id}>
                {shown(s.name)}
              </option>
            ))}
          </select>
        )}
        <Button variant="subtle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Show'}
        </Button>
      </div>
      {open && current && <FlowsOf swarmId={current} />}
    </section>
  )
}

type Reads = Record<number, FlowRevisionRead | string>
type SetReads = (fn: (x: Reads) => Reads) => void

/** Reads a flow's newest revisions; each answer is written only for the identity that asked (r5). Returns a cancel. */
export function readRevisions(d: { client: HiveClient | null; artifact: string; latest: number; setReads: SetReads }): () => void {
  let live = true
  const binding = bindEpoch()
  for (const n of revisionsOf(d.latest))
    d.client!.flowRevision!(d.artifact, n).then(
      (r) => live && binding.commit(() => d.setReads((x) => ({ ...x, [n]: r }))),
      (e) => live && binding.commit(() => d.setReads((x) => ({ ...x, [n]: errorMessage(e) }))),
    )
  return () => {
    live = false
  }
}

/** Taking back an adoption, then reading it again; bound to the identity it was pressed under (r5). */
export function unadoptRun(d: { client: HiveClient | null; artifactId: string; revision: number; setReads: SetReads }): () => Promise<DecisionResult | Stale> {
  return boundRun(async (binding) => {
    try {
      await need(d.client, 'unadoptFlow', 'Taking back an adoption')(d.artifactId, d.revision)
      // read it again: the hive's own record decides what is shown
      const again = await need(d.client, 'flowRevision', 'Flow revision')(d.artifactId, d.revision)
      binding.commit(() => d.setReads((x) => ({ ...x, [d.revision]: again })))
      return again.adoption ? { failed: 'The hive answered, but the revision still reads as adopted. Check it in the studio.' } : true
    } catch (e) {
      return decisionFailure(e)
    }
  })
}

function FlowsOf({ swarmId }: { swarmId: string }) {
  const client = useHive((s) => s.client)
  const res = useResource(() => need(client, 'flowList', 'Flows')(swarmId), { context: swarmId })
  // r5: each row's revision reads are per person; a new identity starts every row empty
  const epoch = useIdentityEpoch()
  if (res.status === 'loading') return <p className="mt-2 text-[12.5px] text-ink-4">Loading…</p>
  if (res.status === 'error') return <p className="mt-2 text-[12.5px] text-bad">{errorMessage(res.error)}</p>
  if (res.status === 'empty' || !res.data?.length) return <p className="mt-2 text-[12.5px] text-ink-4">No saved flows in this swarm.</p>
  return (
    <ul className="mt-2 divide-y divide-line">
      {res.data.map((f) => (
        <FlowRow key={`${epoch}:${f.artifact_id}`} flow={f} />
      ))}
    </ul>
  )
}

function FlowRow({ flow }: { flow: FlowListRow }) {
  const client = useHive((s) => s.client)
  const [reads, setReads] = useState<Reads>({})
  const [asking, setAsking] = useState<FlowRevisionRead | null>(null)
  const nums = revisionsOf(flow.revision)
  const artifact = flow.artifact_id
  const latest = flow.revision
  useEffect(() => {
    return readRevisions({ client, artifact, latest, setReads })
  }, [client, artifact, latest])
  const adopted = nums.map((n) => reads[n]).filter((r): r is FlowRevisionRead => typeof r === 'object' && !!r.adoption)
  const pending = nums.some((n) => reads[n] === undefined)
  return (
    <li className="py-2 text-[13px]">
      <div className="text-ink">
        {flow.title} <span className="text-ink-4">· {flow.revision} revision{flow.revision === 1 ? '' : 's'}</span>
      </div>
      {pending && <div className="text-[12px] text-ink-4">Checking…</div>}
      {!pending && adopted.length === 0 && <div className="text-[12px] text-ink-4">None of the {nums.length === flow.revision ? '' : `${nums.length} newest `}revisions is adopted.</div>}
      <ul className="mt-1 space-y-1">
        {adopted.map((r) => (
          <li key={r.revision} className="flex flex-wrap items-center gap-2 text-[12.5px]">
            <span className="text-ink-2">
              Revision {r.revision} adopted by {r.adoption!.adopted_by.replace(/^user:/, '')} {ago(r.adoption!.adopted_at)}
            </span>
            {has(client, 'unadoptFlow') && (
              <Button variant="ghost" className="min-h-9 px-2.5 text-[12px] text-bad" onClick={() => setAsking(r)}>
                Take back…
              </Button>
            )}
          </li>
        ))}
        {nums.filter((n) => typeof reads[n] === 'string').map((n) => (
          <li key={`e${n}`} className="text-[12px] text-bad">Revision {n}: {reads[n] as string}</li>
        ))}
      </ul>
      {flow.revision > nums.length && <div className="text-[12px] text-ink-4">Older revisions are not checked here; open them in the studio.</div>}
      <AnimatePresence>
        {asking && (
          <DecisionDialog
            icon="ban"
            eyebrow="Flow adoption"
            title={`Take back the adoption of “${flow.title}” revision ${asking.revision}?`}
            facts={[
              ['Flow', `${flow.title} (${flow.artifact_id})`],
              ['Revision', String(asking.revision)],
              ['Fingerprint', <span className="font-mono text-[11px] [overflow-wrap:anywhere]">{asking.adoption!.digest}</span>],
              ['Adopted', `by ${asking.adoption!.adopted_by} ${ago(asking.adoption!.adopted_at)}`],
              ['Effect', 'New runs of this revision are refused until someone adopts it again. Runs already going are decided by the hive’s own rules.'],
            ]}
            bound={(() => {
              const live = reads[asking.revision]
              if (typeof live !== 'object') return { kind: 'gone' as const }
              if (!live.adoption) return { kind: 'closed' as const, why: 'This revision is no longer adopted.' }
              return live.adoption.digest === asking.adoption!.digest ? { kind: 'ready' as const } : { kind: 'changed' as const, fields: ['adoption'] }
            })()}
            thing="This adoption"
            onClose={() => setAsking(null)}
            actions={[
              {
                label: 'Take it back',
                busyLabel: 'Taking back',
                tone: 'danger',
                run: unadoptRun({ client, artifactId: asking.artifact_id, revision: asking.revision, setReads }),
              },
            ]}
          />
        )}
      </AnimatePresence>
    </li>
  )
}
