import { AnimatePresence } from 'framer-motion'
import { useRef, useState } from 'react'
import type { Asset, AssetStore } from '../../api/moneyWork'
import { cx } from '../../lib/cx'
import { bindTo, decisionFailure } from '../../lib/decisionGate'
import { shown } from '../../lib/displayName'
import { ago, bytes } from '../../lib/format'
import { navigate } from '../../lib/router'
import { actionFailure, has, need, useResource } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { DecisionDialog } from '../../ui/DecisionDialog'
import { Icon } from '../../ui/Icon'
import { Page } from '../../ui/Page'
import { Button } from '../../ui/primitives'
import { ResourceView } from '../../ui/ResourceView'
import { useMe } from '../../lib/useAdmin'
import { CleanupDialog, pendingRemoval } from './Cleanup'
import { useUnsaved } from '../ask/dirty'
import { markSaved } from '../../shell/unsavedWork'

const who = (p: string, name: (id: string) => string) => (p.startsWith('agent:') ? name(p.slice(6)) : p.startsWith('user:') ? p.slice(5) : p)

/**
 * #/assets: files minds and people stored (R12). Content-addressed: a file is its sha256 wherever it lives, so a copy
 * or a move never changes it, and every transfer is checked against the hash. Admins upload and transfer.
 */
export default function AssetsPage({ swarm }: { swarm?: string }) {
  const client = useHive((s) => s.client)
  const swarms = useHive((s) => s.swarms)
  const stores = useResource(() => need(client, 'assetStores', 'Storage')(), {})
  const res = useResource(() => need(client, 'listAssets', 'Files')(swarm), { context: swarm ?? '', poll: 30_000 })
  const [uploading, setUploading] = useState(false)
  const canUpload = has(client, 'uploadAsset')
  return (
    <Page
      title="Files and storage"
      eyebrow={swarm ? `Files of ${shown(swarms[swarm]?.name ?? swarm)}` : 'Every swarm you can see'}
      label="Files and storage"
      onClose={() => navigate({ name: 'hive' })}
      actions={canUpload ? <Button variant="primary" icon="plus" onClick={() => setUploading(true)}>Add a file</Button> : undefined}
    >
      <div className="mx-auto max-w-4xl space-y-4 px-3 pt-2 pb-12 md:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-[12.5px] text-ink-3">
            Swarm
            <select value={swarm ?? ''} onChange={(e) => navigate({ name: 'assets', swarm: e.target.value || undefined }, { replace: true })} className="min-h-10 rounded-xl border border-line bg-shade/30 px-2.5 text-[13px] text-ink outline-none focus:border-line-2">
              <option value="">Every swarm</option>
              {Object.values(swarms).map((s) => (
                <option key={s.id} value={s.id}>
                  {shown(s.name)}
                </option>
              ))}
            </select>
          </label>
          {stores.data && (
            <span className="ml-auto text-[12px] text-ink-4">
              Stores: {stores.data.map((s) => `${s.name} (${s.kind === 's3' ? 'cloud bucket' : s.kind === 'local' ? 'this machine' : s.kind})`).join(', ')}
            </span>
          )}
        </div>
        {uploading && <Upload stores={stores.data ?? [{ name: 'local', kind: 'local' }]} swarm={swarm} onDone={(a) => (setUploading(false), a && res.mutate((list) => [a, ...(list ?? [])]))} />}
        <ResourceView
          res={res}
          errorTitle="Could not list files"
          empty={{ icon: 'database', title: 'No files yet', body: 'Images, PDFs, decks and design originals that minds or people store appear here.' }}
          unsupported={{ body: 'This hive or the demo does not store files yet.' }}
        >
          {(list) => (
            <ul className="overflow-hidden rounded-2xl border border-line bg-tint/[0.02]">
              {list.map((a, i) => (
                <AssetRow key={a.sha256} asset={a} first={i === 0} stores={stores.data ?? []} onChange={(next) => res.mutate((l) => (l ?? []).map((x) => (x.sha256 === next.sha256 ? next : x)))} live={(sha) => res.data?.find((x) => x.sha256 === sha)} />
              ))}
            </ul>
          )}
        </ResourceView>
        <p className="text-meta text-ink-4">A file marked “this machine only” is refused by every cloud store. Minds read a file only through their swarm or a live request that lists it.</p>
      </div>
    </Page>
  )
}

function Upload({ stores, swarm, onDone }: { stores: AssetStore[]; swarm?: string; onDone: (a?: Asset) => void }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const swarms = useHive((s) => s.swarms)
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [owner, setOwner] = useState(swarm ?? '')
  const [store, setStore] = useState('local')
  const [localOnly, setLocalOnly] = useState(false)
  const [busy, setBusy] = useState(false)
  // a file picked but not yet stored lives only here: a reload or a proposed move must not drop it (stand-in r6)
  useUnsaved(!!file)
  const target = stores.find((s) => s.name === store)
  const refused = localOnly && target && target.kind !== 'local'
  const sel = 'mt-1 min-h-11 w-full rounded-xl border border-line bg-shade/30 px-3 text-[13px] text-ink outline-none focus:border-line-2'
  return (
    <div className="rounded-2xl border border-line bg-tint/[0.03] p-4" data-unsaved-scope="asset-upload">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Button variant="subtle" icon="plus" onClick={() => input.current?.click()}>
            {file ? 'Choose another file…' : 'Choose a file…'}
          </Button>
          {file && (
            <span className="ml-3 text-[13px] text-ink-2">
              {file.name}, {bytes(file.size)}
            </span>
          )}
          {file && file.size > 100 * 1024 * 1024 && <p className="mt-1 text-[12.5px] text-bad">Files are limited to 100 MB.</p>}
          <input ref={input} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); if (f && !name) setName(f.name) }} />
        </div>
        <label>
          <span className="text-[12px] text-ink-3">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={sel} />
        </label>
        <label>
          <span className="text-[12px] text-ink-3">Swarm that owns it</span>
          <select value={owner} onChange={(e) => setOwner(e.target.value)} className={sel}>
            <option value="">No swarm (admins only)</option>
            {Object.values(swarms).map((s) => (
              <option key={s.id} value={s.id}>
                {shown(s.name)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="text-[12px] text-ink-3">Store</span>
          <select value={store} onChange={(e) => setStore(e.target.value)} className={sel}>
            {stores.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name} ({s.kind === 's3' ? 'cloud bucket' : s.kind === 'local' ? 'this machine' : s.kind})
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 self-end pb-2.5 text-[13px] text-ink-2">
          <input type="checkbox" checked={localOnly} onChange={(e) => setLocalOnly(e.target.checked)} className="size-4 accent-[var(--color-accent)]" />
          This machine only: never to a cloud store
        </label>
      </div>
      {refused && <p className="mt-2 text-[12.5px] text-bad">A file kept on this machine only cannot go to {store}, a cloud store.</p>}
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => onDone()} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!file || busy || !!refused || (file?.size ?? 0) > 100 * 1024 * 1024}
          onClick={async () => {
            if (!file) return
            setBusy(true)
            try {
              const a = await need(client, 'uploadAsset', 'Storing files')(file, { swarm_id: owner || undefined, name: name.trim() || file.name, local_only: localOnly, store })
              markSaved('asset-upload') // stored: the picked file and its details are in the hive now
              toast({ tone: 'success', icon: 'database', title: `${a.name} stored`, body: `sha256 ${a.sha256.slice(0, 12)}… in ${a.placements.join(', ')}` })
              onDone(a)
            } catch (e) {
              toast(actionFailure(e, 'Could not store the file'))
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? 'Storing…' : 'Store it'}
        </Button>
      </div>
    </div>
  )
}

function AssetRow({ asset: a, first, stores, onChange, live }: { asset: Asset; first: boolean; stores: AssetStore[]; onChange: (a: Asset) => void; live: (sha: string) => Asset | undefined }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const [open, setOpen] = useState(false)
  const [moving, setMoving] = useState<{ seen: Asset; to: string } | null>(null)
  const [cleaning, setCleaning] = useState<Asset | null>(null)
  const { admin } = useMe()
  const pending = pendingRemoval(a, stores)
  const [busy, setBusy] = useState(false)
  const name = (id: string) => shown(agents[id]?.name ?? id)
  const others = stores.filter((s) => !a.placements.includes(s.name))
  const allowed = (s: AssetStore) => !a.local_only || s.kind === 'local'
  const canTransfer = has(client, 'transferAsset') && stores.length > 1

  const copy = async (to: string) => {
    setBusy(true)
    try {
      const next = await need(client, 'transferAsset', 'Transfers')(a.sha256, to, false)
      onChange(next)
      toast({ tone: 'success', title: `Copied to ${to}`, body: 'Checked against its hash.' })
    } catch (e) {
      toast(actionFailure(e, 'Could not copy'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className={cx('px-4 py-3', !first && 'border-t border-line')}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl border border-line bg-tint/[0.04] text-ink-3">
          <Icon name={a.mime.startsWith('image/') ? 'sparkles' : 'doc'} size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[14px] font-medium text-ink [overflow-wrap:anywhere]">{a.name}</span>
            <span className="text-meta text-ink-4">
              {a.mime} · {bytes(a.bytes)}
            </span>
          </div>
          <div className="mt-0.5 text-[12px] text-ink-3">
            {a.owners.length ? a.owners.map((o) => shown(swarms[o]?.name ?? o)).join(', ') : 'no swarm'} · by {who(a.created_by, name)} {ago(a.created_at)}
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {a.placements.map((p) => (
              <span key={p} className="rounded-full border border-line px-2 py-px text-[11px] text-ink-2">
                in {p}
              </span>
            ))}
            {a.local_only && <span className="rounded-full border border-warn/35 px-2 py-px text-[11px] text-warn">this machine only</span>}
            {pending.length > 0 && <span className="rounded-full border border-bad/40 px-2 py-px text-[11px] text-bad">still copied in {pending.join(', ')}</span>}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {has(client, 'assetBlob') && (
            <Button
              variant="ghost"
              className="min-h-9 px-2.5 text-[12px]"
              onClick={async () => {
                try {
                  const blob = await need(client, 'assetBlob', 'Downloads')(a.sha256)
                  const url = URL.createObjectURL(blob)
                  const el = document.createElement('a')
                  el.href = url
                  el.download = a.name
                  el.click()
                  setTimeout(() => URL.revokeObjectURL(url), 30_000)
                } catch (e) {
                  toast(actionFailure(e, 'Could not download'))
                }
              }}
            >
              Download
            </Button>
          )}
          {admin && pending.length > 0 && has(client, 'cleanupAsset') && (
            <Button variant="subtle" className="min-h-9 px-2.5 text-[12px]" onClick={() => setCleaning({ ...a, placements: [...a.placements] })}>
              Clean up…
            </Button>
          )}
          <button onClick={() => setOpen(!open)} aria-expanded={open} className="min-h-9 rounded-lg px-2.5 text-[12px] text-ink-3 hover:bg-tint/[0.06] hover:text-ink">
            {canTransfer ? 'Stores and history' : 'History'}
          </button>
        </div>
      </div>
      {open && (
        <div className="mt-2 ml-11 space-y-2 rounded-xl border border-line bg-shade/20 px-3 py-2.5 text-[12.5px]">
          <div className="font-mono text-[11px] text-ink-4 [overflow-wrap:anywhere]">sha256 {a.sha256}</div>
          {canTransfer && (
            <div className="flex flex-wrap items-center gap-1.5">
              {others.map((s) => (
                <Button key={s.name} variant="subtle" className="min-h-9 px-2.5 text-[12px]" disabled={busy || !allowed(s)} title={allowed(s) ? undefined : 'This file stays on this machine'} onClick={() => void copy(s.name)}>
                  Copy to {s.name}
                </Button>
              ))}
              {stores
                .filter((s) => !(a.placements.length === 1 && a.placements[0] === s.name))
                .map((s) => (
                  <Button key={`m-${s.name}`} variant="ghost" className="min-h-9 px-2.5 text-[12px]" disabled={busy || !allowed(s)} onClick={() => setMoving({ seen: { ...a, placements: [...a.placements] }, to: s.name })}>
                    Move to {s.name} only…
                  </Button>
                ))}
            </div>
          )}
          <ol className="space-y-0.5 text-ink-3">
            {a.history.map((h, i) => (
              <li key={i}>
                <span className="text-ink-2">{h.event === 'stored' ? `Stored in ${h.store}` : h.event === 'copied' ? `Copied to ${h.to}` : h.event === 'moved' ? `Moved to ${h.to}${h.removed?.length ? `, removed from ${h.removed.join(', ')}` : ''}` : h.event.replace(/_/g, ' ')}</span>
                <span className="text-ink-4">
                  {' '}
                  · {who(h.by, name)} · {ago(h.at)}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
      <AnimatePresence>
        {cleaning && <CleanupDialog seen={cleaning} live={live(cleaning.sha256)} stores={stores} onClose={() => setCleaning(null)} onDone={onChange} />}
        {moving && (
          <DecisionDialog
            icon="database"
            eyebrow="Move a file"
            title={`Keep ${moving.seen.name} in ${moving.to} only?`}
            facts={[
              ['File', moving.seen.name],
              ['sha256', <span className="font-mono text-[11px]">{moving.seen.sha256}</span>],
              ['Size', bytes(moving.seen.bytes)],
              ['Now in', moving.seen.placements.join(', ')],
              ['After', `${moving.to} only`],
              ['Removed from', moving.seen.placements.filter((p) => p !== moving.to).join(', ') || 'nothing'],
              ['Safety', `It is copied to ${moving.to} and checked against its hash first; if the copy cannot be verified, nothing is removed.`],
            ]}
            bound={bindTo(moving.seen, live(moving.seen.sha256), ['sha256', 'placements', 'local_only'])}
            thing="This file"
            onClose={() => setMoving(null)}
            actions={[
              {
                label: `Move to ${moving.to}`,
                busyLabel: 'Moving',
                tone: 'danger',
                run: async () => {
                  try {
                    const next = await need(client, 'transferAsset', 'Transfers')(moving.seen.sha256, moving.to, true)
                    onChange(next)
                    toast({ tone: 'success', title: `${next.name} is in ${moving.to} only`, body: 'Copied and checked against its hash before anything was removed.' })
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
    </li>
  )
}
