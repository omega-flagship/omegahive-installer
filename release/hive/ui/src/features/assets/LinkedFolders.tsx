import { AnimatePresence } from 'framer-motion'
import { useState } from 'react'
import type { FolderItem, FolderWriters, LinkedFolder } from '../../api/moneyWork'
import { cx } from '../../lib/cx'
import { bindTo, decisionFailure } from '../../lib/decisionGate'
import { shown } from '../../lib/displayName'
import { ago, bytes } from '../../lib/format'
import { actionFailure, has, need, useResource } from '../../lib/useResource'
import { useMe } from '../../lib/useAdmin'
import { useHive } from '../../store/store'
import { DecisionDialog } from '../../ui/DecisionDialog'
import { Icon } from '../../ui/Icon'
import { Button } from '../../ui/primitives'
import { ResourceView } from '../../ui/ResourceView'

/** The folder above `path` inside a linked folder ('' is its root). Pure. */
export function parentPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  parts.pop()
  return parts.join('/')
}

/** Breadcrumb steps for a path inside a linked folder: [label, path] from the root down. Pure. */
export function crumbs(label: string, path: string): [string, string][] {
  const parts = path.split('/').filter(Boolean)
  return [[label, ''], ...parts.map((p, i): [string, string] => [p, parts.slice(0, i + 1).join('/')])]
}

/** Who may write, in plain words. Pure. */
export function writersLabel(w: FolderWriters | undefined): string {
  return w === 'swarm_members' ? 'swarm members write' : 'admins write'
}

/** What a link refusal means, in plain words (folders.py codes). Pure. */
export function linkRefusal(code: string | undefined): string | null {
  switch (code) {
    case 'folder_denied':
      return 'This folder is protected and can never be linked: it is, holds or sits inside a private or credential place.'
    case 'folder_not_allowed':
      return 'This hive links folders only from the places its operator allows.'
    case 'local_hive_only':
      return 'Folders can be linked only on the hive\u2019s own machine.'
    case 'already_linked':
      return 'This folder is already linked for that swarm.'
    case 'not_found':
      return 'No such folder on this machine.'
    default:
      return null
  }
}

const sel = 'mt-1 min-h-11 w-full rounded-xl border border-line bg-shade/30 px-3 text-[13px] text-ink outline-none focus:border-line-2'

/** Who reads a linked folder (folders.py: a mind reads through its own swarm, and never writes), said under the heading:
 *  testers could not tell whether linking a folder shares it with their minds. */
export const LINKED_FOLDER_READERS = 'Each folder belongs to a swarm: that swarm’s minds can read its files and never change them. Nothing is copied.'

/**
 * Linked folders on #/assets: a folder on the hive's own machine shown in the hive, never copied (folders.py). Admins
 * link, unlink and switch writing on per folder; anyone who sees the owner swarm browses. Hidden files, keys and secrets
 * never appear, and protected places (private data, credential stores) can never be linked.
 */
export function LinkedFolders({ swarm }: { swarm?: string }) {
  const client = useHive((s) => s.client)
  const { admin } = useMe()
  const res = useResource(() => need(client, 'listFolders', 'Linked folders')(swarm), { context: swarm ?? '' })
  const [linking, setLinking] = useState(false)
  const withFolders = (fn: (fs: LinkedFolder[]) => LinkedFolder[]) => res.mutate((l) => ({ local: l?.local ?? true, scope: 'this_machine_only', folders: fn(l?.folders ?? []) }))
  if (!has(client, 'listFolders')) return null
  if (res.data && !res.data.local) return null // a hive not on this machine has no linked folders
  return (
    <section className="space-y-2" aria-label="Linked folders">
      <div className="flex items-center gap-2">
        <h2 className="text-[13px] font-medium text-ink-2">Linked folders</h2>
        <span className="rounded-full border border-warn/35 px-2 py-px text-[11px] text-warn">this machine only</span>
        {admin && has(client, 'linkFolder') && !linking && (
          <Button variant="subtle" icon="plus" className="ml-auto min-h-9 px-2.5 text-[12px]" onClick={() => setLinking(true)}>
            Link a folder
          </Button>
        )}
      </div>
      <p className="text-[12px] text-ink-3" data-linked-folder-readers="">
        {LINKED_FOLDER_READERS}
      </p>
      {linking && <LinkForm swarm={swarm} onDone={(f) => (setLinking(false), f && withFolders((fs) => [f, ...fs]))} />}
      <ResourceView
        res={res}
        errorTitle="Could not list linked folders"
        empty={{ icon: 'database', title: 'No linked folders', body: 'An admin can link a folder on this machine; nothing is copied.' }}
        unsupported={{ body: 'This hive does not link folders.' }}
      >
        {(list) =>
          list.folders.length ? (
            <ul className="overflow-hidden rounded-2xl border border-line bg-tint/[0.02]">
              {list.folders.map((f, i) => (
                <FolderRow
                  key={f.id}
                  folder={f}
                  first={i === 0}
                  live={(id) => res.data?.folders.find((x) => x.id === id)}
                  onChange={(next) => withFolders((fs) => fs.map((x) => (x.id === next.id ? next : x)))}
                  onGone={(id) => withFolders((fs) => fs.filter((x) => x.id !== id))}
                />
              ))}
            </ul>
          ) : (
            <p className="text-[12.5px] text-ink-4">No linked folders. {admin ? 'Link one to browse it here; nothing is copied.' : ''}</p>
          )
        }
      </ResourceView>
    </section>
  )
}

function LinkForm({ swarm, onDone }: { swarm?: string; onDone: (f?: LinkedFolder) => void }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const swarms = useHive((s) => s.swarms)
  const [path, setPath] = useState('')
  const [owner, setOwner] = useState(swarm ?? '')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  return (
    <div className="rounded-2xl border border-line bg-tint/[0.03] p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="sm:col-span-2">
          <span className="text-[12px] text-ink-3">Folder on this machine (full path)</span>
          <input value={path} onChange={(e) => (setPath(e.target.value), setRefusal(null))} placeholder="~/Projects/site" className={cx(sel, 'font-mono')} />
        </label>
        <label>
          <span className="text-[12px] text-ink-3">Swarm that owns it</span>
          <select value={owner} onChange={(e) => setOwner(e.target.value)} className={sel}>
            <option value="">Choose a swarm…</option>
            {Object.values(swarms).map((s) => (
              <option key={s.id} value={s.id}>
                {shown(s.name)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="text-[12px] text-ink-3">Name (optional)</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} className={sel} />
        </label>
      </div>
      <p className="mt-2 text-[12px] text-ink-4">Read-only until you turn on writing. Hidden files, .git, .env and keys never appear. Private and credential places cannot be linked.</p>
      {refusal && <p className="mt-2 text-[12.5px] text-bad">{refusal}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => onDone()} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!path.trim() || !owner || busy}
          onClick={async () => {
            setBusy(true)
            try {
              const f = await need(client, 'linkFolder', 'Linking folders')({ path: path.trim(), swarm_id: owner, label: label.trim() || undefined })
              toast({ tone: 'success', icon: 'database', title: `${f.label} linked`, body: 'Read-only, on this machine only.' })
              onDone(f)
            } catch (e) {
              const known = linkRefusal((e as { code?: string })?.code)
              if (known) setRefusal(known)
              else toast(actionFailure(e, 'Could not link the folder'))
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? 'Linking…' : 'Link it'}
        </Button>
      </div>
    </div>
  )
}

function FolderRow({ folder: f, first, live, onChange, onGone }: { folder: LinkedFolder; first: boolean; live: (id: string) => LinkedFolder | undefined; onChange: (f: LinkedFolder) => void; onGone: (id: string) => void }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const swarms = useHive((s) => s.swarms)
  const { admin } = useMe()
  const [open, setOpen] = useState(false)
  const [deciding, setDeciding] = useState<null | { kind: 'unlink' | 'write'; seen: LinkedFolder }>(null)
  return (
    <li className={cx('px-4 py-3', !first && 'border-t border-line')}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl border border-line bg-tint/[0.04] text-ink-3">
          <Icon name="database" size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium text-ink [overflow-wrap:anywhere]">{f.label}</div>
          <div className="font-mono text-[11px] text-ink-4 [overflow-wrap:anywhere]">{f.root}</div>
          <div className="mt-1 flex flex-wrap gap-1">
            <span className="rounded-full border border-line px-2 py-px text-[11px] text-ink-2">{shown(swarms[f.owner_swarm]?.name ?? f.owner_swarm)}</span>
            <span className="rounded-full border border-warn/35 px-2 py-px text-[11px] text-warn">this machine only</span>
            <span className={cx('rounded-full border px-2 py-px text-[11px]', f.writable ? 'border-bad/40 text-bad' : 'border-line text-ink-3')}>{f.writable ? `writing on · ${writersLabel(f.writers)}` : 'read-only'}</span>
            {!f.available && <span className="rounded-full border border-bad/40 px-2 py-px text-[11px] text-bad">folder missing</span>}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          <button onClick={() => setOpen(!open)} aria-expanded={open} className="min-h-9 rounded-lg px-2.5 text-[12px] text-ink-3 hover:bg-tint/[0.06] hover:text-ink">
            {open ? 'Close' : 'Browse'}
          </button>
          {admin && has(client, 'setFolderWritable') && (
            <Button
              variant="ghost"
              className="min-h-9 px-2.5 text-[12px]"
              onClick={async () => {
                if (f.writable) {
                  try {
                    onChange(await need(client, 'setFolderWritable', 'Folder writing')(f.id, false))
                    toast({ tone: 'success', title: `${f.label} is read-only` })
                  } catch (e) {
                    toast(actionFailure(e, 'Could not change writing'))
                  }
                } else setDeciding({ kind: 'write', seen: { ...f } })
              }}
            >
              {f.writable ? 'Make read-only' : 'Allow writing…'}
            </Button>
          )}
          {admin && has(client, 'setFolderWriters') && (
            <label className="flex min-h-9 items-center gap-1 text-[12px] text-ink-3">
              Who can write
              <select
                value={f.writers ?? 'admins'}
                onChange={async (e) => {
                  try {
                    const next = await need(client, 'setFolderWriters', 'Folder writing')(f.id, e.target.value as FolderWriters)
                    onChange(next)
                    toast({ tone: 'success', title: `${f.label}: ${writersLabel(next.writers)}`, body: next.writable ? 'Every write leaves a receipt.' : 'Applies once writing is allowed.' })
                  } catch (err) {
                    toast(actionFailure(err, 'Could not change who can write'))
                  }
                }}
                className="min-h-9 rounded-lg border border-line bg-shade/30 px-2 text-[12px] text-ink outline-none focus:border-line-2"
              >
                <option value="admins">Admins</option>
                <option value="swarm_members">Swarm members</option>
              </select>
            </label>
          )}
          {admin && has(client, 'unlinkFolder') && (
            <Button variant="ghost" className="min-h-9 px-2.5 text-[12px]" onClick={() => setDeciding({ kind: 'unlink', seen: { ...f } })}>
              Unlink…
            </Button>
          )}
        </div>
      </div>
      {open && <Browser folder={f} />}
      <AnimatePresence>
        {deciding && (
          <DecisionDialog
            icon="database"
            eyebrow={deciding.kind === 'unlink' ? 'Unlink a folder' : 'Allow writing'}
            title={deciding.kind === 'unlink' ? `Unlink ${deciding.seen.label}?` : `Let ${deciding.seen.label} be written?`}
            facts={[
              ['Folder', <span className="font-mono text-[11px]">{deciding.seen.root}</span>],
              ['Owned by', shown(swarms[deciding.seen.owner_swarm]?.name ?? deciding.seen.owner_swarm)],
              deciding.kind === 'unlink'
                ? ['After', 'The hive stops showing it. Nothing on disk changes, and its write receipts stay.']
                : ['After', `${deciding.seen.writers === 'swarm_members' ? 'People who see this swarm' : 'Admins'} can save files into it. Every write is recorded: who, which file, its hash before and after, and when. Hidden files and keys stay untouchable.`],
            ]}
            bound={bindTo(deciding.seen, live(deciding.seen.id), ['id', 'root', 'writable', 'writers', 'owner_swarm'])}
            thing="This folder"
            onClose={() => setDeciding(null)}
            actions={[
              {
                label: deciding.kind === 'unlink' ? 'Unlink' : 'Allow writing',
                busyLabel: deciding.kind === 'unlink' ? 'Unlinking' : 'Allowing',
                tone: 'danger',
                run: async () => {
                  try {
                    if (deciding.kind === 'unlink') {
                      await need(client, 'unlinkFolder', 'Unlinking folders')(deciding.seen.id)
                      onGone(deciding.seen.id)
                      toast({ tone: 'success', title: `${deciding.seen.label} unlinked`, body: 'Nothing on disk changed.' })
                    } else {
                      onChange(await need(client, 'setFolderWritable', 'Folder writing')(deciding.seen.id, true))
                      toast({ tone: 'success', title: `${deciding.seen.label} can be written`, body: 'Every write leaves a receipt.' })
                    }
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

function Browser({ folder }: { folder: LinkedFolder }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const [path, setPath] = useState('')
  const res = useResource(() => need(client, 'browseFolder', 'Browsing folders')(folder.id, path), { context: `${folder.id}:${path}` })
  const download = async (item: FolderItem) => {
    try {
      const blob = await need(client, 'folderFileBlob', 'Reading folder files')(folder.id, item.path)
      const url = URL.createObjectURL(blob)
      const el = document.createElement('a')
      el.href = url
      el.download = item.name
      el.click()
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    } catch (e) {
      toast(actionFailure(e, 'Could not read the file'))
    }
  }
  return (
    <div className="mt-2 ml-11 rounded-xl border border-line bg-shade/20 px-3 py-2.5 text-[12.5px]">
      <nav className="mb-1.5 flex flex-wrap items-center gap-1 text-ink-3" aria-label="Folder path">
        {crumbs(folder.label, path).map(([label, p], i, all) => (
          <span key={p || '/'} className="flex items-center gap-1">
            {i > 0 && <span className="text-ink-4">/</span>}
            {i === all.length - 1 ? <span className="text-ink-2">{label}</span> : <button className="hover:text-ink" onClick={() => setPath(p)}>{label}</button>}
          </span>
        ))}
      </nav>
      <ResourceView res={res} errorTitle="Could not open this folder" empty={{ icon: 'database', title: 'Empty folder', body: 'Nothing to show here.' }} unsupported={{ body: 'This hive does not link folders.' }}>
        {(listing) => (
          <>
            <ul className="space-y-0.5">
              {path && (
                <li>
                  <button className="min-h-8 text-ink-3 hover:text-ink" onClick={() => setPath(parentPath(path))}>
                    ↑ Up
                  </button>
                </li>
              )}
              {listing.items.map((item) => (
                <li key={item.path} className="flex min-h-8 items-center gap-2">
                  {item.kind === 'folder' ? (
                    <button className="text-left text-ink hover:underline [overflow-wrap:anywhere]" onClick={() => setPath(item.path)}>
                      {item.name}/
                    </button>
                  ) : (
                    <span className="text-ink-2 [overflow-wrap:anywhere]">{item.name}</span>
                  )}
                  <span className="ml-auto shrink-0 text-ink-4">
                    {item.kind === 'file' && item.bytes !== null ? `${bytes(item.bytes)} · ` : ''}
                    {ago(new Date(item.modified_at * 1000).toISOString())}
                  </span>
                  {item.kind === 'file' && has(client, 'folderFileBlob') && (
                    <Button variant="ghost" className="min-h-8 px-2 text-[12px]" onClick={() => void download(item)}>
                      Download
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            {(listing.hidden > 0 || listing.truncated) && (
              <p className="mt-1.5 text-[11.5px] text-ink-4">
                {listing.hidden > 0 ? `${listing.hidden} hidden (dotfiles, keys, secrets, or links leading out).` : ''}
                {listing.truncated ? ' Showing the first 2000.' : ''}
              </p>
            )}
          </>
        )}
      </ResourceView>
    </div>
  )
}
