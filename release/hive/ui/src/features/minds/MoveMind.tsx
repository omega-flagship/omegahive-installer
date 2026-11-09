import { plural } from '../../lib/plural'
import { AnimatePresence } from 'framer-motion'
import { useRef, useState } from 'react'
import type { Agent } from '../../api/types'
import { bindTo, decisionFailure } from '../../lib/decisionGate'
import { shown } from '../../lib/displayName'
import { ago, bytes } from '../../lib/format'
import { copyText } from '../../lib/hooks'
import { navigate } from '../../lib/router'
import { actionFailure, errorMessage, has, need, useResource } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { useMe } from '../../lib/useAdmin'
import { DecisionDialog } from '../../ui/DecisionDialog'
import { Icon } from '../../ui/Icon'
import { Button } from '../../ui/primitives'
import { useUnsaved } from '../ask/dirty'
import { markSaved } from '../../shell/unsavedWork'
import { exportBlockers, looksLikeHiveId, looksLikeSha256, pendingExport, readBundle, type BundleSummary } from './logic'
import type { HiveIdentity, MindMove } from './types'

type Moved = Agent & { moved_to?: string | null; moved_to_name?: string | null; moved_at?: string | null }

const PACKED = 'its memory and vector memory, who it is, its conversation, its wakeups and its own rules (never its token, its log or temporary files)'

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

/** Moving one mind to another hive (placement.py): export, import there, then settle here. Its owner or an admin. */
export function MoveMind({ agent }: { agent: Agent }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const live = useHive((s) => s.agents[agent.id]) as Moved | undefined
  const moves = useResource(() => need(client, 'mindMoves', 'Moves')(agent.id), { context: agent.id, key: agent.status })
  const [dialog, setDialog] = useState<null | { kind: 'export'; seen: Moved } | { kind: 'settle'; seen: Moved; move: MindMove } | { kind: 'native'; seen: Moved }>(null)
  if (!has(client, 'exportMind') && !has(client, 'mindMoves')) return null
  const a = (live ?? agent) as Moved
  const name = shown(a.name)
  const movedAway = !!a.moved_to || (a.status as string) === 'moved'
  const blockers = exportBlockers(a)
  const pending = moves.data ? pendingExport(moves.data) : undefined
  const outside = a.kind === 'module'

  return (
    <section aria-labelledby="move-h" data-tour="mind-move">
      <h3 id="move-h" className="eyebrow mb-2">
        Where {name} lives
      </h3>
      {movedAway ? (
        <p className="rounded-xl border border-line bg-tint/[0.03] px-3 py-2.5 text-[13px] text-ink-2">
          {name} moved to <span className="font-medium text-ink">{a.moved_to_name || a.moved_to}</span>
          {a.moved_at && ` ${ago(a.moved_at)}`}. Its history here stays readable; it cannot start here. Bringing its bundle back restores the same mind.
        </p>
      ) : (
        <div className="space-y-2">
          <p className="text-[12.5px] leading-snug text-ink-3">
            Move {name} to another hive (home or cloud): export a bundle, import it there, then settle it here. Nothing changes here until you settle.
          </p>
          <div className="flex flex-wrap gap-2">
            {has(client, 'exportMind') && !outside && (
              <Button variant="subtle" icon="external" onClick={() => setDialog({ kind: 'export', seen: { ...a } })}>
                Export to move…
              </Button>
            )}
            {has(client, 'settleMind') && pending && (
              <Button variant="subtle" icon="check" onClick={() => setDialog({ kind: 'settle', seen: { ...a }, move: { ...pending } })}>
                Settle the move…
              </Button>
            )}
            {has(client, 'convertNative') && outside && (
              <Button variant="subtle" icon="cpu" onClick={() => setDialog({ kind: 'native', seen: { ...a } })}>
                Run it in this hive…
              </Button>
            )}
          </div>
          {!outside && blockers.length > 0 && <p className="text-meta text-ink-4">To export: {blockers.join(' ')}</p>}
          {outside && <p className="text-meta text-ink-4">{name} is an outside member: it moves by reconnecting to the other hive. An admin can make it a mind that runs in this hive instead.</p>}
        </div>
      )}

      {moves.status === 'error' && <p className="mt-2 text-meta text-bad">Could not read its moves: {errorMessage(moves.error)}</p>}
      {moves.data && moves.data.length > 0 && (
        <ul className="mt-2.5 overflow-hidden rounded-xl border border-line bg-shade/20 text-[12px]">
          {[...moves.data].reverse().map((mv, i) => (
            <li key={mv.id} className={i ? 'border-t border-line px-3 py-1.5' : 'px-3 py-1.5'}>
              <span className="text-ink-2">
                {mv.direction === 'in' ? `Arrived from ${mv.other_name || mv.other_hive || 'another hive'}` : mv.status === 'settled' ? `Moved to ${mv.other_name || mv.other_hive}` : 'Exported, not yet settled'}
              </span>
              <span className="text-ink-4">
                {' '}
                · {ago(mv.created_at)}
                {mv.detail.files !== undefined && ` · ${plural(mv.detail.files, 'file')}`}
                {mv.detail.bytes !== undefined && ` · ${bytes(mv.detail.bytes)}`}
              </span>
              {mv.manifest_sha256 && <div className="truncate font-mono text-[11px] text-ink-4" title={mv.manifest_sha256}>manifest {mv.manifest_sha256}</div>}
            </li>
          ))}
        </ul>
      )}

      <AnimatePresence>
        {dialog?.kind === 'export' && (
          <DecisionDialog
            icon="external"
            eyebrow="Move a mind: step 1 of 3"
            title={`Export ${shown(dialog.seen.name)} to move it?`}
            facts={[
              ['Mind', `${shown(dialog.seen.name)} (${dialog.seen.id})`],
              ['Kind', dialog.seen.kind],
              ['Status now', dialog.seen.status],
              ['Model', dialog.seen.model],
              ['Packed', PACKED],
              ['Here', 'Nothing changes until you settle. The bundle is a file you carry to the other hive.'],
            ]}
            bound={bindTo(dialog.seen, a, ['id', 'status', 'kind', 'moved_to'], (l) => (exportBlockers(l).length ? exportBlockers(l).join(' ') : null))}
            thing="This mind"
            onClose={() => setDialog(null)}
            actions={[
              {
                label: 'Export bundle',
                busyLabel: 'Packing',
                tone: 'primary',
                run: async () => {
                  try {
                    const out = await need(client, 'exportMind', 'Exporting a mind')(a.id)
                    download(out.blob, out.filename)
                    moves.reload()
                    toast({ tone: 'success', icon: 'external', title: `${name} is packed`, body: `${out.filename}, ${bytes(out.bytes)}. Import it on the other hive, then settle it here.` })
                    return true
                  } catch (e) {
                    return decisionFailure(e)
                  }
                },
              },
            ]}
          />
        )}
        {dialog?.kind === 'settle' && (
          <SettleDialog
            seen={dialog.seen}
            move={dialog.move}
            liveAgent={a}
            liveMove={moves.data?.find((m) => m.id === dialog.move.id)}
            onClose={() => setDialog(null)}
            onDone={() => moves.reload()}
          />
        )}
        {dialog?.kind === 'native' && (
          <DecisionDialog
            icon="cpu"
            eyebrow="Change how a mind runs"
            title={`Run ${shown(dialog.seen.name)} in this hive?`}
            facts={[
              ['Mind', `${shown(dialog.seen.name)} (${dialog.seen.id})`],
              ['Now', 'an outside member: it connects with its own token from elsewhere'],
              ['After', 'a mind that runs in this hive, with the same id, role, rules and history'],
              ['Its token', 'replaced: the outside program’s token stops working at once'],
              ['Status now', dialog.seen.status],
            ]}
            bound={bindTo(dialog.seen, a, ['id', 'kind', 'status'], (l) => (l.kind !== 'module' ? `It already runs as ${l.kind}.` : l.status !== 'created' && l.status !== 'stopped' ? `Stop ${shown(l.name)} first: it is ${l.status}.` : null))}
            thing="This mind"
            onClose={() => setDialog(null)}
            actions={[
              {
                label: 'Run it here',
                busyLabel: 'Converting',
                tone: 'primary',
                run: async () => {
                  try {
                    await need(client, 'convertNative', 'Converting a mind')(a.id)
                    toast({ tone: 'success', title: `${name} now runs in this hive`, body: 'Wake it when you are ready.' })
                    return true
                  } catch (e) {
                    return decisionFailure(e)
                  }
                },
              },
            ]}
          />
        )}
      </AnimatePresence>
    </section>
  )
}

function SettleDialog({ seen, move, liveAgent, liveMove, onClose, onDone }: { seen: Moved; move: MindMove; liveAgent: Moved; liveMove: MindMove | undefined; onClose: () => void; onDone: () => void }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const [hiveId, setHiveId] = useState('')
  const [hiveName, setHiveName] = useState('')
  const name = shown(seen.name)
  const agentBound = bindTo(seen, liveAgent, ['id', 'moved_to'], (l) => (l.moved_to ? `${shown(l.name)} already moved to ${l.moved_to_name || l.moved_to}.` : null))
  const moveBound = bindTo(move, liveMove, ['id', 'status', 'manifest_sha256'], (l) => (l.status !== 'exported' ? `That export is already ${l.status}.` : null))
  const bound = agentBound.kind !== 'ready' ? agentBound : moveBound
  const blocked = !looksLikeHiveId(hiveId)
    ? 'Enter the other hive’s id (h_ and hex): Settings on that hive shows it.'
    : !hiveName.trim()
      ? 'Name the other hive, as people will read it here.'
      : !looksLikeSha256(move.manifest_sha256 ?? '')
        ? 'This export has no manifest digest, so it cannot be settled.'
        : null
  return (
    <DecisionDialog
      icon="check"
      eyebrow="Move a mind: step 3 of 3"
      title={`Settle ${name} on the other hive?`}
      facts={[
        ['Mind', `${name} (${seen.id})`],
        ['Bundle', `exported ${ago(move.created_at)}${move.detail.bytes !== undefined ? `, ${bytes(move.detail.bytes)}` : ''}`],
        ['Manifest', <span className="font-mono text-[12px]">{move.manifest_sha256}</span>],
        ['Here, after', `${name} is marked as moved. Its history stays readable; it cannot start here; its token here stops working.`],
        ['Only when', `the other hive has imported this exact bundle and ${name} is alive there.`],
      ]}
      bound={bound}
      thing="This move"
      onClose={onClose}
      actions={[
        {
          label: `Settle: ${name} lives there`,
          busyLabel: 'Settling',
          tone: 'danger',
          blocked,
          run: async () => {
            try {
              await need(client, 'settleMind', 'Settling a move')(seen.id, { to_hive: hiveId.trim(), to_name: hiveName.trim(), manifest_sha256: move.manifest_sha256 ?? '' })
              onDone()
              toast({ tone: 'success', title: `${name} lives on ${hiveName.trim()} now`, body: 'Its history stays here.' })
              return true
            } catch (e) {
              return decisionFailure(e)
            }
          },
        },
      ]}
    >
      <label className="block">
        <span className="text-[12px] text-ink-3">The other hive’s id</span>
        <input value={hiveId} onChange={(e) => setHiveId(e.target.value)} placeholder="h_…" spellCheck={false} autoComplete="off" className="mt-1 min-h-11 w-full rounded-xl border border-line bg-shade/30 px-3 font-mono text-[13px] text-ink outline-none focus:border-line-2" />
      </label>
      <label className="block">
        <span className="text-[12px] text-ink-3">Its name</span>
        <input value={hiveName} onChange={(e) => setHiveName(e.target.value)} placeholder="Cloud hive" className="mt-1 min-h-11 w-full rounded-xl border border-line bg-shade/30 px-3 text-[13px] text-ink outline-none focus:border-line-2" />
      </label>
    </DecisionDialog>
  )
}

/** Settings: this hive as other hives name it, and bringing a mind here from a bundle. */
export function HivePlacement() {
  const client = useHive((s) => s.client)
  const id = useResource(() => need(client, 'hiveIdentity', 'Hive identity')(), { isEmpty: () => false })
  if (!has(client, 'hiveIdentity') && !has(client, 'importMind')) return null
  return (
    <section aria-labelledby="place-h" className="space-y-3">
      <h2 id="place-h" className="eyebrow">
        This hive and moving minds
      </h2>
      {id.status === 'ready' && id.data && <Identity me={id.data} onRenamed={(next) => id.mutate(() => next)} />}
      {id.status === 'error' && <p className="text-[13px] text-bad">Could not read this hive’s identity: {errorMessage(id.error)}</p>}
      {has(client, 'importMind') && <ImportMind />}
    </section>
  )
}

function Identity({ me, onRenamed }: { me: HiveIdentity; onRenamed: (next: HiveIdentity) => void }) {
  const toast = useHive((s) => s.toast)
  const client = useHive((s) => s.client)
  const { admin } = useMe()
  const [naming, setNaming] = useState<HiveIdentity | null>(null)
  return (
    <div className="rounded-2xl border border-line bg-tint/[0.03] p-4" data-tour="hive-identity">
      <AnimatePresence>{naming && <NameHive seen={naming} live={me} onClose={() => setNaming(null)} onDone={onRenamed} />}</AnimatePresence>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-ink">{me.name}</span>
        {admin && has(client, 'setHiveIdentity') && (
          <Button variant="ghost" icon="edit" className="min-h-9 px-2.5 text-[12px]" onClick={() => setNaming({ ...me })}>
            Rename…
          </Button>
        )}
        <span className="rounded-full border border-line px-2 py-px text-[11px] text-ink-3">{me.home ? 'home' : 'cloud'}</span>
        {me.owner && <span className="text-meta text-ink-4">whose machine: {me.owner}</span>}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-shade/30 px-2.5 py-1.5 font-mono text-[12.5px] text-ink-2">{me.id}</code>
        <Button variant="ghost" icon="copy" className="min-h-9 px-2.5 text-[12px]" onClick={async () => {
            const ok = await copyText(me.id)
            toast({ tone: ok ? 'success' : 'error', title: ok ? 'Hive id copied' : 'Could not copy' })
          }}>
          Copy
        </Button>
      </div>
      <p className="mt-1.5 text-meta text-ink-4">The hive a mind leaves asks for this id when you settle a move here.</p>
    </div>
  )
}

/** Admins: rename this hive as other hives see it (PATCH /api/hive/identity), with the change shown before it is made. */
function NameHive({ seen, live, onClose, onDone }: { seen: HiveIdentity; live: HiveIdentity; onClose: () => void; onDone: (next: HiveIdentity) => void }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const [name, setName] = useState(seen.name)
  const next = name.trim()
  const blocked = !next ? 'Give the hive a name.' : next.length > 80 ? 'Keep the name to 80 characters (the hive cuts longer names).' : next === seen.name ? 'That is already its name.' : null
  return (
    <DecisionDialog
      icon="edit"
      eyebrow="Name this hive"
      title={`Rename “${seen.name}”?`}
      facts={[
        ['Hive', <span className="font-mono text-[12px]">{seen.id}</span>],
        ['Now called', seen.name],
        ['Will be called', next || '(nothing yet)'],
        ['Kind', seen.home ? 'home' : 'cloud'],
      ]}
      bound={bindTo(seen, live, ['id', 'name'])}
      thing="This hive"
      onClose={onClose}
      actions={[
        {
          label: 'Rename hive',
          busyLabel: 'Renaming',
          tone: 'primary',
          blocked,
          run: async () => {
            try {
              const out = await need(client, 'setHiveIdentity', 'Naming this hive')({ name: next })
              onDone(out)
              toast({ tone: 'success', title: `This hive is now “${out.name}”` })
              return true
            } catch (e) {
              return decisionFailure(e)
            }
          },
        },
      ]}
    >
      <label className="block">
        <span className="text-[12px] text-ink-3">New name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className="mt-1 min-h-11 w-full rounded-xl border border-line bg-shade/30 px-3 text-[13px] text-ink outline-none focus:border-line-2" />
      </label>
      <p className="text-meta leading-snug text-ink-4">Other hives see this name when a mind moves between hives. The hive id stays the same, so moves already settled are unaffected.</p>
    </DecisionDialog>
  )
}

function ImportMind() {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const swarms = useHive((s) => s.swarms)
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<BundleSummary | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [swarm, setSwarm] = useState('')
  const [busy, setBusy] = useState(false)
  // a bundle picked but not yet imported lives only here: a reload or a proposed move must not drop it (stand-in r6)
  useUnsaved(!!file)

  const pick = async (f: File | undefined) => {
    setErr(null)
    setPreview(null)
    setFile(f ?? null)
    if (!f) return
    try {
      const s = await readBundle(await f.arrayBuffer())
      setPreview(s)
      setSwarm(s.swarm && swarms[s.swarm.id] ? s.swarm.id : '')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="rounded-2xl border border-line bg-tint/[0.03] p-4" data-unsaved-scope="mind-import">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">Bring a mind here</div>
          <div className="text-[12px] text-ink-3">From a .omegamind.tgz another hive exported. Every file is checked against its hash.</div>
        </div>
        <Button variant="subtle" icon="plus" onClick={() => input.current?.click()}>
          Choose bundle…
        </Button>
        <input ref={input} type="file" accept=".tgz,.gz,application/gzip" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} />
      </div>
      {err && <p className="mt-2 text-[13px] text-bad">{err}</p>}
      {preview && file && (
        <div className="mt-3 space-y-3">
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-[12.5px]">
            <dt className="text-ink-4">Mind</dt>
            <dd className="text-ink">
              {preview.mindName} <span className="font-mono text-ink-4">({preview.mindId})</span>
            </dd>
            <dt className="text-ink-4">From</dt>
            <dd className="text-ink-2">
              {preview.fromHive.name ?? 'an unnamed hive'} {preview.fromHive.id && <span className="font-mono text-ink-4">({preview.fromHive.id})</span>}
            </dd>
            <dt className="text-ink-4">Exported</dt>
            <dd className="text-ink-2">{preview.exportedAt ? new Date(preview.exportedAt).toLocaleString() : 'unknown'}</dd>
            <dt className="text-ink-4">Kind, model</dt>
            <dd className="text-ink-2">
              {preview.kind}, {preview.model}
            </dd>
            <dt className="text-ink-4">Carries</dt>
            <dd className="text-ink-2">
              {plural(preview.files, 'memory file')}, {plural(preview.messages, 'message')}, {plural(preview.wakeups, 'wakeup')}, {plural(preview.rules.length, 'rule')}
              {preview.rules.length > 0 && <span className="text-ink-4"> ({preview.rules.map((r) => `${r.skill}: ${r.mode}`).join(', ')})</span>}
            </dd>
            <dt className="text-ink-4">File</dt>
            <dd className="text-ink-2">
              {file.name}, {bytes(file.size)}
            </dd>
          </dl>
          <label className="block">
            <span className="text-[12px] text-ink-3">Swarm it joins here</span>
            <select value={swarm} onChange={(e) => setSwarm(e.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-line bg-shade/30 px-3 text-[13px] text-ink outline-none focus:border-line-2">
              <option value="">{preview.swarm ? `Its own swarm (${preview.swarm.name}), if it is here` : 'Choose a swarm'}</option>
              {Object.values(swarms).map((s) => (
                <option key={s.id} value={s.id}>
                  {shown(s.name)}
                </option>
              ))}
            </select>
          </label>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => void pick(undefined)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  const r = await need(client, 'importMind', 'Importing a mind')(file, swarm || undefined)
                  markSaved('mind-import') // imported: the bundle is in the hive now
                  toast({ tone: 'success', title: `${shown(r.agent.name)} arrived`, body: `Settle the move on ${r.from.name ?? 'the hive it left'} with manifest ${r.manifest_sha256.slice(0, 12)}….` })
                  void pick(undefined)
                  navigate({ name: 'dot', id: r.agent.id, tab: 'model' })
                } catch (e) {
                  setErr(actionFailure(e, 'Could not import').body)
                } finally {
                  setBusy(false)
                }
              }}
            >
              <Icon name="check" size={16} />
              {busy ? 'Bringing it here…' : `Bring ${preview.mindName} here`}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
