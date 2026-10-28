import { createPortal } from 'react-dom'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { artifactCandidates, assetCandidates, type PickAccept, type PickCandidate } from '../../lib/appBridge'
import { useEscape } from '../../lib/hooks'
import { useHive } from '../../store/store'
import { shown } from '../../lib/displayName'
import { useModalContainment } from '../../ui/useModalContainment'
import { guardComposing } from '../../features/ask/keys'

const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`)
const short = (digest: string) => digest.replace(/^sha256:/, '').slice(0, 12)

/**
 * The host's own picker for an app frame's `pick` request (Studio slice 1). It lists only what this person may read
 * for this app in this swarm, through the host's existing routes: the swarm's artifacts at their latest exact revision
 * (GET /api/swarms/{id}/artifacts) and the swarm's files (GET /api/assets?swarm_id=). The frame never sees the list;
 * it receives the one reference the person chooses. A window in the experience's chrome; focus starts on the heading,
 * Esc cancels, arrows/Home/End move through the list, Enter chooses, typing searches.
 */
export function AppPicker({ appName, swarmId, accept, kinds, onChoose, onCancel }: {
  appName: string
  swarmId: string
  accept: PickAccept[]
  kinds: string[] | null
  onChoose: (c: PickCandidate) => void
  onCancel: () => void
}) {
  const client = useHive((s) => s.client)
  const swarmName = useHive((s) => s.swarms[swarmId]?.name)
  const id = useId()
  const head = useRef<HTMLHeadingElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const [items, setItems] = useState<PickCandidate[] | null>(null)
  const [missing, setMissing] = useState<string[]>([])
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  useEscape(onCancel)
  // Tab/Shift-Tab stay in the picker (loading, empty and error states too), the app and hive behind are inert until a
  // choice or cancel, and focus returns to the opener
  useModalContainment(box)

  useEffect(() => {
    head.current?.focus()
  }, [])

  useEffect(() => {
    let live = true
    const gaps: string[] = []
    const wantArtifacts = accept.includes('artifact')
    const wantAssets = accept.includes('asset')
    if (wantArtifacts && !client?.swarmArtifacts) gaps.push('creations (this hive does not list them)')
    if (wantAssets && !client?.listAssets) gaps.push('files (this hive does not list them)')
    void Promise.all([
      wantArtifacts && client?.swarmArtifacts ? client.swarmArtifacts(swarmId).catch((e: unknown) => (gaps.push(`creations: ${e instanceof Error ? e.message : String(e)}`), [])) : Promise.resolve([]),
      wantAssets && client?.listAssets ? client.listAssets(swarmId).catch((e: unknown) => (gaps.push(`files: ${e instanceof Error ? e.message : String(e)}`), [])) : Promise.resolve([]),
    ]).then(([arts, files]) => {
      if (!live) return
      setItems([...artifactCandidates(arts, kinds), ...assetCandidates(files, swarmId, kinds)])
      setMissing(gaps)
    })
    return () => {
      live = false
    }
  }, [client, swarmId, accept, kinds])

  const shownItems = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (items ?? []).filter((c) => !needle || `${c.title} ${c.kind}`.toLowerCase().includes(needle))
  }, [items, q])
  const current = shownItems[Math.min(active, shownItems.length - 1)]
  useEffect(() => {
    if (current) list.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(current.key)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [current])

  const move = (e: KeyboardEvent) => {
    // an IME's confirming Enter belongs to the input method (features/ask/keys; r2.4 sweep)
    if (guardComposing(e)) return
    const n = shownItems.length
    if (!n) return
    const to = e.key === 'ArrowDown' ? Math.min(active + 1, n - 1) : e.key === 'ArrowUp' ? Math.max(active - 1, 0) : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : null
    if (to !== null) {
      e.preventDefault()
      setActive(to)
    } else if (e.key === 'Enter' && current && !e.repeat) {
      e.preventDefault()
      onChoose(current)
    }
  }

  const what = accept.length === 2 ? 'a creation or file' : accept[0] === 'artifact' ? 'a creation' : 'a file'
  const optionId = (c: PickCandidate) => `${id}-o-${c.key.replace(/[^\w-]/g, '_')}`
  const groups: [string, PickCandidate[]][] = (
    [
      ['Creations', shownItems.filter((c) => c.source === 'artifact')],
      ['Files', shownItems.filter((c) => c.source === 'asset')],
    ] as [string, PickCandidate[]][]
  ).filter(([, g]) => g.length)

  return createPortal(
    <div className="xc-scrim fixed inset-0 z-[70] flex items-end justify-center p-3 md:items-center" onClick={onCancel}>
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-t`}
        aria-describedby={`${id}-d`}
        data-app-picker=""
        onClick={(e) => e.stopPropagation()}
        className="xc-window flex max-h-[min(86dvh,680px)] w-full max-w-[560px] flex-col overflow-hidden"
      >
        <div className="xc-divider border-b px-5 pt-5 pb-3">
          <h2 id={`${id}-t`} ref={head} tabIndex={-1} className="xc-heading text-[18px] leading-tight outline-none focus-visible:underline">
            Choose {what} for {shown(appName)}
          </h2>
          <p id={`${id}-d`} className="xc-ink-2 mt-1 text-[13px] leading-snug">
            From {shown(swarmName ?? swarmId)}. {shown(appName)} receives only the one you choose, as an exact reference; nothing else in the swarm.
          </p>
          <input
            type="search"
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setActive(0)
            }}
            onKeyDown={move}
            placeholder="Search by name or kind"
            aria-label="Search"
            aria-controls={`${id}-l`}
            aria-activedescendant={current ? optionId(current) : undefined}
            className="xc-input mt-3 h-10 w-full px-3 text-[14px]"
          />
        </div>
        <div
          ref={list}
          id={`${id}-l`}
          role="listbox"
          aria-label={`Choose ${what}`}
          data-unsaved-ignore="" // picking an app to open is going somewhere, not work
          tabIndex={0}
          aria-activedescendant={current ? optionId(current) : undefined}
          onKeyDown={move}
          className="thin-scroll min-h-[120px] flex-1 overflow-y-auto px-3 py-2 outline-none"
        >
          {items === null ? (
            <p role="status" className="xc-ink-3 px-2 py-6 text-center text-[13px]">Reading what you can choose from…</p>
          ) : !shownItems.length ? (
            <p role="status" className="xc-ink-3 px-2 py-6 text-center text-[13px]">
              {q ? 'Nothing matches that search.' : `Nothing in ${shown(swarmName ?? swarmId)} you can choose here yet.`}
            </p>
          ) : (
            groups.map(([label, g]) => (
              <div key={label} role="group" aria-label={label} className="mb-2">
                <div role="presentation" className="xc-ink-3 px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wider uppercase">{label}</div>
                {g.map((c) => {
                  const selected = c === current
                  return (
                    <div
                      key={c.key}
                      id={optionId(c)}
                      data-key={c.key}
                      role="option"
                      aria-selected={selected}
                      onClick={() => onChoose(c)}
                      onMouseMove={() => setActive(shownItems.indexOf(c))}
                      className="xc-item flex cursor-pointer items-baseline gap-3 px-3 py-2.5"
                      style={selected ? { background: 'var(--xc-raised)', boxShadow: 'inset 0 0 0 2px var(--xc-accent)' } : undefined}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] font-medium">{c.title}</span>
                        <span className="xc-ink-3 block truncate text-[12px]">
                          {c.source === 'artifact'
                            ? `${c.kind} · revision ${c.reference.revision} · ${short(c.reference.digest)}`
                            : `${c.kind} · ${bytes(c.reference.size)}`}
                        </span>
                      </span>
                    </div>
                  )
                })}
              </div>
            ))
          )}
        </div>
        <div className="xc-divider border-t px-5 pt-3 pb-4">
          {missing.length > 0 && <p role="status" className="xc-ink-2 mb-2 text-[12.5px]">Not shown: {missing.join('; ')}.</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className="xc-button xc-subtle" onClick={onCancel}>Cancel</button>
            <button type="button" className="xc-button xc-primary" aria-disabled={!current} onClick={() => current && onChoose(current)}>
              {current ? `Use “${current.title.length > 28 ? `${current.title.slice(0, 27)}…` : current.title}”` : 'Use selected'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
