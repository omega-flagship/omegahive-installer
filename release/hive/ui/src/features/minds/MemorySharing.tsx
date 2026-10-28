import { AnimatePresence, m } from 'framer-motion'
import { useState } from 'react'
import type { Agent } from '../../api/types'
import { shown } from '../../lib/displayName'
import { cx } from '../../lib/cx'
import { ago, until } from '../../lib/format'
import { useNow } from '../../lib/hooks'
import { navigate } from '../../lib/router'
import { errorMessage, has, isNotFound, need, useResource } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { Button, Orb, Skeleton } from '../../ui/primitives'
import { bindTo, decisionFailure, type DecisionResult } from '../../lib/decisionGate'
import { DecisionDialog } from '../../ui/DecisionDialog'
import { endedWords, ownerName, readerName, revokeContext, revokeEffect, shareOpen, shareSubject, splitShares } from './logic'
import type { Share } from './types'

/**
 * Who can read this mind's private memory, what it can read of others, who is asking, and every read: all on view,
 * any of it revocable (the owner's ruling: no true secrets; "check the logs"). Minds ask, offer and answer themselves; a person
 * sees everything and can end any share.
 */
export function MemorySharing({ agent }: { agent: Agent }) {
  const client = useHive((s) => s.client)
  // a share.updated event for this mind refreshes the list
  const pulse = useHive((s) => {
    let sig = ''
    for (const x of Object.values(s.shares)) if (x.owner_id === agent.id || x.grantee_id === agent.id) sig += `${x.id}:${x.status}:${String(x.reads ?? '')};`
    return sig
  })
  const res = useResource(() => need(client, 'listShares', 'Sharing')({ agent_id: agent.id }), { context: agent.id, key: pulse, isEmpty: () => false })
  const now = useNow(30_000)
  const [showPast, setShowPast] = useState(false)
  const [revoking, setRevoking] = useState<Share | null>(null)
  const toast = useHive((s) => s.toast)
  if (!has(client, 'listShares') || res.status === 'unsupported') return null

  const name = shown(agent.name)
  const split = res.data ? splitShares(res.data, agent.id, now) : null
  const open = split ? split.readersOfMine.length + split.readingOthers.length + split.askedOfMe.length + split.myAsks.length : 0
  const canRevoke = has(client, 'revokeShare')

  return (
    <section aria-labelledby="sharing-h" className="rounded-xl border border-line bg-white/[0.02] p-3" data-tour="memory-sharing">
      <div className="flex items-baseline justify-between gap-2">
        <h3 id="sharing-h" className="eyebrow">
          Sharing
        </h3>
        {split && (
          <span className="text-meta text-ink-4">
            {split.readersOfMine.length} reading {name} · {name} reads {split.readingOthers.length}
            {split.askedOfMe.length + split.myAsks.length > 0 && ` · ${split.askedOfMe.length + split.myAsks.length} asking`}
          </span>
        )}
      </div>
      <p className="mt-1 text-[12px] leading-snug text-ink-3">
        Minds in a swarm read each other's private memory only by consent and for a set time. Every read is logged. You can see all of it, and end any of it.
      </p>

      {res.status === 'loading' ? (
        <div className="mt-3 space-y-1.5">
          <Skeleton className="h-12 rounded-lg" />
          <Skeleton className="h-12 rounded-lg" />
        </div>
      ) : res.status === 'error' && isNotFound(res.error) ? (
        // R13: the hive answers 404 for a mind this viewer may not see; that is not a failure
        <p className="mt-3 rounded-lg border border-dashed border-line px-3 py-3 text-center text-[12.5px] text-ink-3" data-share-hidden>
          {name}'s sharing is not visible to you.
        </p>
      ) : res.status === 'error' ? (
        <p className="mt-3 text-[13px] text-bad">
          Could not read shares: {errorMessage(res.error)}{' '}
          <button className="underline" onClick={res.reload}>
            Try again
          </button>
        </p>
      ) : split ? (
        <div className="mt-3 space-y-3">
          {open === 0 && <p className="rounded-lg border border-dashed border-line px-3 py-3 text-center text-[12.5px] text-ink-4">Nothing is shared right now. {name}'s memory is private to {name}.</p>}
          <Group title={`Who can read ${name}'s memory`} list={split.readersOfMine} side="reader" onRevoke={canRevoke ? setRevoking : undefined} now={now} />
          <Group title={`Asking to read ${name}'s memory`} note={`${name} answers these itself. You can withdraw one.`} list={split.askedOfMe} side="reader" onRevoke={canRevoke ? setRevoking : undefined} now={now} />
          <Group title={`What ${name} can read`} list={split.readingOthers} side="owner" onRevoke={canRevoke ? setRevoking : undefined} now={now} />
          <Group title={`${name} is asking to read`} list={split.myAsks} side="owner" onRevoke={canRevoke ? setRevoking : undefined} now={now} />
          {split.closed.length > 0 && (
            <div>
              <button onClick={() => setShowPast(!showPast)} aria-expanded={showPast} className="flex min-h-9 items-center gap-1.5 text-[12px] text-ink-3 hover:text-ink">
                <Icon name="chevronDown" size={14} className={cx('transition-transform', showPast && 'rotate-180')} />
                Ended and declined ({split.closed.length})
              </button>
              {showPast && <Group list={split.closed} side="either" agentId={agent.id} now={now} />}
            </div>
          )}
        </div>
      ) : null}

      <AnimatePresence>
        {revoking && (
          <RevokeShare
            seen={revoking}
            live={res.data?.find((x) => x.id === revoking.id)}
            onClose={() => setRevoking(null)}
            onRevoke={async () => {
              try {
                const done = await need(client, 'revokeShare', 'Revoking a share')(revoking.id)
                res.mutate((list) => (list ?? []).map((s) => (s.id === done.id ? { ...s, ...done } : s)))
                toast({ tone: 'success', icon: 'ban', title: revoking.status === 'requested' ? 'Request withdrawn' : `${readerName(revoking)} can no longer read it`, body: `${readerName(revoking)} was told.` })
                return true
              } catch (e) {
                res.reload()
                if (isNotFound(e)) return 'This share is not visible to you (or no longer exists). Nothing was changed.'
                return decisionFailure(e)
              }
            }}
          />
        )}
      </AnimatePresence>
    </section>
  )
}

/** Every timestamp in a fact, in local time with how long ago or until. */
const when = (v: string) => v.replace(/\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d)?/g, (iso) => `${new Date(iso).toLocaleString()} (${Date.parse(iso) > Date.now() ? until(iso) : ago(iso)})`)

/** Revoking a share, bound to the exact share the person opened (Review R2/R3). */
function RevokeShare({ seen, live, onClose, onRevoke }: { seen: Share; live: Share | undefined; onClose: () => void; onRevoke: () => Promise<DecisionResult> }) {
  const ask = seen.status === 'requested'
  const bound = bindTo(seen, live, ['id', 'status', 'owner_id', 'grantee_id', 'space', 'pattern', 'exhibit_id', 'expires_at'], (l) =>
    shareOpen(l) ? null : `This share is already ${l.status === 'active' || l.status === 'requested' ? 'past its time' : l.status}.`,
  )
  return (
    <DecisionDialog
      icon="ban"
      eyebrow={ask ? 'Withdraw a request to read memory' : 'End a memory share'}
      title={ask ? `Withdraw ${readerName(seen)}'s request?` : `End ${readerName(seen)}'s access to ${ownerName(seen)}'s memory?`}
      facts={revokeContext(seen).map(([k, v]) => [k, when(v)])}
      bound={bound}
      thing="This share"
      onClose={onClose}
      actions={[{ label: ask ? 'Withdraw request' : 'End access', busyLabel: ask ? 'Withdrawing' : 'Ending access', tone: 'danger', run: onRevoke }]}
    >
      <p className="text-[13px] leading-relaxed text-ink-2">{revokeEffect(seen)}</p>
    </DecisionDialog>
  )
}

function Group({ title, note, list, side, onRevoke, now, agentId }: { title?: string; note?: string; list: Share[]; side: 'reader' | 'owner' | 'either'; onRevoke?: (s: Share) => void; now: number; agentId?: string }) {
  if (list.length === 0) return null
  return (
    <div>
      {title && <h4 className="mb-1 text-[12px] font-medium text-ink-2">{title}</h4>}
      {note && <p className="mb-1.5 text-meta text-ink-4">{note}</p>}
      <ul className="overflow-hidden rounded-lg border border-line bg-black/20">
        {list.map((s, i) => (
          <ShareRow key={s.id} share={s} side={side === 'either' ? (s.owner_id === agentId ? 'reader' : 'owner') : side} onRevoke={onRevoke} first={i === 0} now={now} />
        ))}
      </ul>
    </div>
  )
}

function ShareRow({ share: s, side, onRevoke, first, now }: { share: Share; side: 'reader' | 'owner'; onRevoke?: (s: Share) => void; first: boolean; now: number }) {
  const agents = useHive((st) => st.agents)
  const mindName = (id: string) => (agents[id] ? shown(agents[id].name) : undefined)
  const otherId = side === 'reader' ? s.grantee_id : s.owner_id
  const other = agents[otherId]
  const otherName = shown(side === 'reader' ? readerName(s) : ownerName(s))
  const [open, setOpen] = useState(false)
  const live = s.status === 'active' || s.status === 'requested'
  const ended = live && s.expires_at && Date.parse(s.expires_at) <= now
  return (
    <li className={cx(!first && 'border-t border-line')}>
      <div className="flex items-start gap-2.5 px-3 py-2">
        <span className="mt-0.5">
          <Orb hue={other?.hue ?? 250} status={other?.status ?? 'stopped'} size={22} />
        </span>
        <div className="min-w-0 flex-1 text-[12.5px]">
          <div className="flex flex-wrap items-baseline gap-x-1.5">
            <button className="font-medium text-ink hover:underline" onClick={() => other && navigate({ name: 'dot', id: otherId, tab: 'memory' })} disabled={!other}>
              {otherName}
            </button>
            <span className="text-ink-3">{shareSubject(s)}</span>
          </div>
          <div className="mt-0.5 text-meta text-ink-4">
            {live && !ended
              ? s.status === 'requested'
                ? `asked ${ago(s.created_at, now)}${s.expires_at ? ` · lapses ${until(s.expires_at, now)}` : ''}`
                : `${s.initiated_by === 'grantee' ? 'granted on request' : s.kind === 'exhibit' ? 'exhibited' : 'offered'} ${ago(s.decided_at ?? s.created_at, now)}${s.expires_at ? ` · ends ${until(s.expires_at, now)}` : ''}`
              : `${endedWords(s, mindName)} ${ago(s.decided_at ?? s.expires_at ?? s.created_at, now)}`}
            {' · '}
            {s.reads ? `${s.reads} read${s.reads === 1 ? '' : 's'}, last ${ago(s.last_read_at, now)}` : 'not read yet'}
          </div>
          {s.reason && <div className="mt-0.5 text-meta text-ink-3">“{s.reason}”</div>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {s.reads > 0 && (
            <button onClick={() => setOpen(!open)} aria-expanded={open} className="min-h-9 rounded-lg px-2 text-[12px] text-ink-3 hover:bg-white/[0.06] hover:text-ink">
              Reads
            </button>
          )}
          {onRevoke && live && !ended && (
            <Button variant="danger" className="min-h-9 px-2.5 text-[12px]" onClick={() => onRevoke(s)}>
              {s.status === 'requested' ? 'Withdraw…' : 'Revoke…'}
            </Button>
          )}
        </div>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <m.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <Reads share={s} />
          </m.div>
        )}
      </AnimatePresence>
    </li>
  )
}

function Reads({ share }: { share: Share }) {
  const client = useHive((s) => s.client)
  const res = useResource(() => need(client, 'shareReads', 'Read history')(share.id), { context: share.id, key: share.reads })
  return (
    <div className="mx-3 mb-2 rounded-lg border border-line bg-black/25 px-3 py-2 text-meta">
      {res.status === 'loading' ? (
        <span className="text-ink-4">Loading reads…</span>
      ) : res.status === 'unsupported' ? (
        <span className="text-ink-4">This hive does not list reads.</span>
      ) : res.status === 'error' && isNotFound(res.error) ? (
        <span className="text-ink-3">These reads are not visible to you.</span>
      ) : res.status === 'error' ? (
        <span className="text-bad">{errorMessage(res.error)}</span>
      ) : res.status === 'empty' ? (
        <span className="text-ink-4">No reads recorded.</span>
      ) : (
        <ul className="space-y-0.5">
          {res.data?.map((r) => (
            <li key={r.id} className="flex gap-2 font-mono text-ink-3">
              <span className="w-32 shrink-0 text-ink-4">{new Date(r.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              <span className="min-w-0 flex-1 truncate">
                {shown(readerName(share))} read {r.returned} atom{r.returned === 1 ? '' : 's'}
                {r.q ? ` matching “${r.q}”` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
