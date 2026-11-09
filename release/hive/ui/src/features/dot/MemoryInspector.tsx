import { AnimatePresence, m } from 'framer-motion'
import { useEffect, useMemo, useState } from 'react'
import type { Agent, MemoryAtom, MemorySpace } from '../../api/types'
import { hsl } from '../../lib/color'
import { cx } from '../../lib/cx'
import { bytes } from '../../lib/format'
import { readContext, taggedFor, type Tagged } from '../../lib/readContext'
import { atomKey, useHive } from '../../store/store'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { Icon } from '../../ui/Icon'
import { MeTTa } from '../../ui/MeTTa'
import { Button, EmptyState, ErrorState, Skeleton } from '../../ui/primitives'
import { shown } from '../../lib/displayName'
import { MemorySharing } from '../minds/MemorySharing'

/** The mind's private atomspaces, read from disk: browse, search, retire, reset. */
export function MemoryInspector({ agent }: { agent: Agent }) {
  const client = useHive((s) => s.client)
  const resetQueued = useHive((s) => !!s.resetQueued[agent.id])
  const resetMemory = useHive((s) => s.resetMemory)
  const toast = useHive((s) => s.toast)
  // Surface K1/L1 audit: the spaces and atoms belong to the client and mind they were read for
  const ctx = readContext(client, agent.id)
  const [spacesRead, setSpaces] = useState<Tagged<MemorySpace[]> | null>(null)
  const spaces = taggedFor(spacesRead, ctx)
  const [space, setSpace] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [atoms, setAtoms] = useState<{ key: string; list: MemoryAtom[] } | null>(null)
  const [atomErr, setAtomErr] = useState<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!client) return
    let live = true
    const asked = readContext(client, agent.id)
    client.listMemory(agent.id).then(
      (list) => {
        if (!live) return
        setSpaces({ ctx: asked, value: list })
        setErr(null)
        setSpace((cur) => cur ?? list[0]?.name ?? null)
      },
      (e: unknown) => live && setErr(e instanceof Error ? e.message : 'Could not read memory'),
    )
    return () => {
      live = false
    }
  }, [client, agent.id, nonce])

  // debounce the search box
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 220)
    return () => clearTimeout(t)
  }, [q])

  const key = `${ctx}\u0000${space}\u0000${query}\u0000${nonce}`
  useEffect(() => {
    if (!client || !space) return
    let live = true
    client.listAtoms(agent.id, space, { q: query || undefined, limit: 200 }).then(
      (list) => {
        if (!live) return
        setAtoms({ key, list })
        setAtomErr(null)
      },
      (e: unknown) => live && setAtomErr(e instanceof Error ? e.message : 'Could not read atoms'),
    )
    return () => {
      live = false
    }
  }, [client, agent.id, space, query, key])

  const max = useMemo(() => Math.max(1, ...(spaces ?? []).map((s) => s.atoms)), [spaces])
  const current = spaces?.find((s) => s.name === space)
  const loading = !atoms || atoms.key !== key

  if (err && !spaces) return <ErrorState title="Could not read memory" body={err} onRetry={() => setNonce((n) => n + 1)} />

  return (
    <div className="space-y-4 px-4 pt-2 pb-6">
      <AnimatePresence>
        {resetQueued && (
          <m.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <div className="flex items-center gap-2.5 rounded-xl border border-warn/30 bg-warn/[0.07] px-3 py-2.5 text-[13px] text-warn" role="status">
              <Icon name="clock" size={16} className="animate-spin-slow" />
              <span className="flex-1">Reset queued. {shown(agent.name)} clears its private spaces on its next loop.</span>
              <button onClick={() => setNonce((n) => n + 1)} className="font-semibold underline-offset-2 hover:underline">
                Refresh
              </button>
            </div>
          </m.div>
        )}
      </AnimatePresence>

      <MemorySharing agent={agent} />

      <section aria-labelledby="spaces-h" data-tour="memory-spaces">
        <div className="mb-2 flex items-baseline justify-between">
          <h3 id="spaces-h" className="eyebrow">
            Spaces
          </h3>
          {spaces && <span className="text-[11px] text-ink-4">{bytes(spaces.reduce((n, s) => n + s.bytes, 0))} on disk</span>}
        </div>
        {!spaces ? (
          <div className="grid grid-cols-2 gap-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[68px] rounded-xl" />
            ))}
          </div>
        ) : spaces.length === 0 ? (
          <EmptyState icon="database" title="No private spaces" body={`${shown(agent.name)} has not written anything to disk yet.`} />
        ) : (
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Space">
            {spaces.map((s) => {
              const on = s.name === space
              return (
                <button
                  key={s.name}
                  role="radio"
                  aria-checked={on}
                  onClick={() => setSpace(s.name)}
                  className={cx('relative overflow-hidden rounded-xl border px-3 py-2.5 text-left transition-colors', on ? 'border-transparent' : 'border-line hover:border-line-2')}
                  style={on ? { background: hsl(agent.hue, 70, 45, 0.14), boxShadow: `inset 0 0 0 1px ${hsl(agent.hue, 100, 75, 0.5)}` } : undefined}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-mono text-[13px]" style={{ color: on ? hsl(agent.hue, 100, 86) : 'var(--color-ink)' }}>
                      {shown(s.name)}
                    </span>
                    <span className="font-display text-[15px] font-semibold tabular-nums">{s.atoms}</span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <span className="h-1 flex-1 overflow-hidden rounded-full bg-tint/[0.07]">
                      <m.span className="block h-full rounded-full" initial={{ width: 0 }} animate={{ width: `${(s.atoms / max) * 100}%` }} style={{ background: hsl(agent.hue, 95, 70) }} />
                    </span>
                    <span className="text-[10px] text-ink-4">{bytes(s.bytes)}</span>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </section>

      {space && (
        <section aria-labelledby="atoms-h">
          <div className="mb-2 flex items-baseline justify-between">
            <h3 id="atoms-h" className="eyebrow">
              Atoms in <span className="font-mono normal-case tracking-normal">{space}</span>
            </h3>
            {atoms && !loading && (
              <span className="text-[11px] text-ink-4">
                {query ? `${atoms.list.length} match${atoms.list.length === 1 ? '' : 'es'}` : `${atoms.list.length}${current && current.atoms > atoms.list.length ? ` of ${current.atoms}` : ''}`}
              </span>
            )}
          </div>
          <label className="mb-2 flex min-h-11 items-center gap-2 rounded-xl border border-line bg-shade/25 px-3 focus-within:border-line-2">
            <Icon name="search" size={16} className="text-ink-4" />
            <span className="sr-only">Search atoms</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search atoms, e.g. vega or episode" className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-ink outline-none placeholder:font-sans placeholder:text-ink-4" autoCapitalize="off" spellCheck={false} />
            {q && (
              <button onClick={() => setQ('')} aria-label="Clear search" className="-mr-1 flex size-8 items-center justify-center text-ink-4 hover:text-ink">
                <Icon name="x" size={14} />
              </button>
            )}
          </label>
          {atomErr ? (
            <p className="px-1 text-sm text-bad">{atomErr}</p>
          ) : loading && !atoms ? (
            <div className="space-y-1.5">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-10 rounded-lg" />
              ))}
            </div>
          ) : atoms && atoms.list.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line px-3 py-6 text-center text-[13px] text-ink-4">{query ? `No atoms match “${query}”.` : 'This space is empty.'}</p>
          ) : (
            <ul className={cx('overflow-hidden rounded-xl border border-line bg-shade/20 transition-opacity', loading && 'opacity-60')}>
              {atoms?.list.map((a, i) => <AtomRow key={`${a.index}:${a.text}`} agent={agent} space={space} atom={a} first={i === 0} />)}
            </ul>
          )}
        </section>
      )}

      <section className="rounded-xl border border-bad/20 bg-bad/[0.04] p-3" aria-labelledby="reset-h">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div id="reset-h" className="text-sm font-medium">
              Reset memory
            </div>
            <div className="text-[12px] text-ink-3">Clears every private space. The swarm commons is untouched.</div>
          </div>
          <Button variant="danger" icon="reset" onClick={() => setConfirmReset(true)} disabled={resetQueued}>
            {resetQueued ? 'Queued' : 'Reset…'}
          </Button>
        </div>
      </section>

      <AnimatePresence>
        {confirmReset && (
          <ConfirmDialog
            title={`Reset ${shown(agent.name)}'s memory?`}
            body={
              <>
                Every private space ({(spaces ?? []).map((s) => s.name).join(', ') || 'all of them'}) is cleared on {shown(agent.name)}’s next loop. Episodes, notes and learned facts are gone for good. Beliefs it published to the commons stay.
              </>
            }
            phrase={agent.name}
            confirmLabel="Reset memory"
            icon="reset"
            onClose={() => setConfirmReset(false)}
            onConfirm={async () => {
              const ok = await resetMemory(agent.id)
              if (ok) toast({ tone: 'info', title: 'Memory reset queued', body: `${shown(agent.name)} clears it on its next loop.` })
              return ok
            }}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

function AtomRow({ agent, space, atom, first }: { agent: Agent; space: string; atom: MemoryAtom; first: boolean }) {
  const queued = useHive((s) => !!s.retired[atomKey(agent.id, space, atom.text)])
  const retire = useHive((s) => s.retireAtom)
  const [ask, setAsk] = useState(false)
  const [busy, setBusy] = useState(false)
  return (
    <li className={cx('group relative', !first && 'border-t border-line')}>
      <div className={cx('flex min-h-11 items-start gap-2.5 py-2 pr-1 pl-3 transition-opacity', queued && 'opacity-55')}>
        <span className="mt-[3px] w-7 shrink-0 text-right font-mono text-[10px] text-ink-4 tabular-nums">{atom.index}</span>
        <div className={cx('min-w-0 flex-1 text-[12.5px]', queued && 'line-through decoration-ink-4')}>
          <MeTTa src={atom.text} />
        </div>
        {queued ? (
          <span className="mt-0.5 mr-2 inline-flex shrink-0 items-center gap-1 rounded-full border border-warn/30 bg-warn/10 px-2 py-0.5 text-[10px] font-semibold text-warn" title="The mind removes it on its next loop">
            <Icon name="clock" size={10} className="animate-spin-slow" />
            Queued
          </span>
        ) : (
          <button
            onClick={() => setAsk(!ask)}
            aria-expanded={ask}
            aria-label={`Retire atom ${atom.index}`}
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-4 transition-colors hover:bg-bad/10 hover:text-bad md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
          >
            <Icon name="trash" size={15} />
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {ask && !queued && (
          <m.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="mx-2 mb-2 flex items-center gap-2 rounded-lg border border-bad/25 bg-bad/[0.06] py-1.5 pr-1.5 pl-3 text-[12px]">
              <span className="flex-1 text-ink-2">Retire this atom? {shown(agent.name)} removes it on its next loop.</span>
              <Button variant="ghost" className="min-h-9 px-2.5 text-[13px]" onClick={() => setAsk(false)}>
                Keep
              </Button>
              <Button
                variant="danger"
                className="min-h-9 px-3 text-[13px]"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  await retire(agent.id, space, atom.text)
                  setBusy(false)
                  setAsk(false)
                }}
              >
                {busy ? '…' : 'Retire'}
              </Button>
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </li>
  )
}
