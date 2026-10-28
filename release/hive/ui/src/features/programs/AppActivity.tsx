import { plural } from '../../lib/plural'
import { AnimatePresence, m } from 'framer-motion'
import { createPortal } from 'react-dom'
import { useEffect, useId, useRef, useState } from 'react'
import type { AppActivation, AppActivityRow, AppAttachment, AppOffer } from '../../api/moneyWork'
import type { Agent } from '../../api/types'
import { cx } from '../../lib/cx'
import { bindTo, decisionFailure } from '../../lib/decisionGate'
import { shown } from '../../lib/displayName'
import { ago, until } from '../../lib/format'
import { useEscape, useIsDesktop, useReducedMotion } from '../../lib/hooks'
import { principalLabel, usePeopleNames } from '../../lib/personNames'
import { navigate } from '../../lib/router'
import { actionFailure, errorMessage, has, need, useResource } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { DecisionDialog } from '../../ui/DecisionDialog'
import { Icon } from '../../ui/Icon'
import { Button, ModeChip, Segmented, Skeleton } from '../../ui/primitives'
import { useModalContainment } from '../../ui/useModalContainment'
import { AppGrants } from './AppGrants'
import { AppInstall } from './AppInstall'

type Tab = 'install' | 'swarms' | 'minds' | 'activity' | 'access'
const who = (p: string, agents: Record<string, Agent>) => (p.startsWith('agent:') ? shown(agents[p.slice(6)]?.name ?? p.slice(6)) : p.startsWith('user:') ? p.slice(5) : p)
const STATUS_TONE: Record<string, string> = { done: 'text-good', failed: 'text-bad', running: 'text-warn', pending: 'text-ink-3' }

/** "Where it runs": the app's activations, the minds it is attached to, and what it did. */
export function AppAccessButton({ programId, name, className, iconOnly }: { programId: string; name: string; className?: string; iconOnly?: boolean }) {
  const client = useHive((s) => s.client)
  const [open, setOpen] = useState(false)
  if (!has(client, 'programActivations') && !has(client, 'programActivity')) return null
  return (
    <>
      <Button variant="subtle" icon="plug" className={className} aria-label={`Where ${name} runs`} onClick={() => setOpen(true)}>
        {iconOnly ? null : 'Where it runs'}
      </Button>
      <AnimatePresence>{open && <AppAccess programId={programId} name={name} onClose={() => setOpen(false)} />}</AnimatePresence>
    </>
  )
}

export function AppAccess({ programId, name, onClose }: { programId: string; name: string; onClose: () => void }) {
  const client = useHive((s) => s.client)
  const desktop = useIsDesktop()
  const reduced = useReducedMotion()
  const id = useId()
  const head = useRef<HTMLHeadingElement>(null)
  const [tab, setTab] = useState<Tab>('swarms')
  const [deciding, setDeciding] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEscape(onClose, !deciding)
  // a decision opened from here stacks above it; closing that makes this the live layer again
  useModalContainment(box)
  useEffect(() => head.current?.focus(), [])
  const me = useResource(() => need(client, 'me')(), { isEmpty: () => false })
  const admin = me.data ? me.data.kind === 'password' || me.data.role === 'admin' : false
  return createPortal(
    <m.div
      className="xc-dress xc-backdrop fixed inset-0 z-[55] flex items-end justify-center bg-[#03030c]/70 p-3 backdrop-blur-[3px] md:items-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      style={{ paddingBottom: desktop ? undefined : 'calc(var(--sab) + 12px)' }}
    >
      <m.div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-t`}
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, y: reduced ? 0 : 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, transition: { duration: 0.15 } }}
        className="xc-frame glass-strong flex max-h-[min(90dvh,820px)] w-full max-w-[640px] flex-col overflow-hidden rounded-[24px]"
      >
        <div className="flex items-start gap-3 border-b border-line px-5 pt-5 pb-3">
          <div className="min-w-0 flex-1">
            <div className="eyebrow">App access</div>
            <h2 id={`${id}-t`} ref={head} tabIndex={-1} className="mt-0.5 font-display text-[19px] font-semibold outline-none">
              Where {name} runs
            </h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="flex size-10 items-center justify-center rounded-xl text-ink-3 hover:bg-white/[0.07] hover:text-ink">
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="px-5 pt-3">
          <Segmented<Tab>
            label="App access section"
            value={tab}
            onChange={setTab}
            className="w-full"
            options={[
              ...(has(client, 'programInstall') ? [{ value: 'install' as const, label: 'Install' }] : []),
              { value: 'swarms', label: 'Swarms' },
              { value: 'minds', label: 'Minds' },
              { value: 'activity', label: 'What it did' },
              ...(has(client, 'revokeProgramGrants') ? [{ value: 'access' as const, label: 'Its access' }] : []),
            ]}
          />
        </div>
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-5 pt-3 pb-5">
          {tab === 'install' ? <AppInstall programId={programId} name={name} admin={admin} /> : tab === 'access' ? <AppGrants programId={programId} name={name} onDeciding={setDeciding} /> : tab === 'swarms' ? <Activations programId={programId} name={name} admin={admin} onDeciding={setDeciding} /> : tab === 'minds' ? <Attachments programId={programId} name={name} admin={admin} onDeciding={setDeciding} /> : <ActivityList program={programId} />}
        </div>
      </m.div>
    </m.div>,
    document.body,
  )
}

function Activations({ programId, name, admin, onDeciding }: { programId: string; name: string; admin: boolean; onDeciding: (b: boolean) => void }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const swarms = useHive((s) => s.swarms)
  const agents = useHive((s) => s.agents)
  const res = useResource(() => need(client, 'programActivations', 'Activations')(programId), { context: programId })
  const atts = useResource(() => need(client, 'programAttachments', 'Attachments')(programId), { context: programId })
  const [busy, setBusy] = useState<string | null>(null)
  const [off, setOff] = useState<AppActivation | null>(null)
  useEffect(() => onDeciding(!!off), [off, onDeciding])
  if (res.status === 'unsupported') return <p className="text-[13px] text-ink-4">This hive does not list where apps run.</p>
  if (res.status === 'loading') return <Skeleton className="h-24 rounded-xl" />
  if (res.status === 'error') return <p className="text-[13px] text-bad">Could not read activations: {errorMessage(res.error)}</p>
  const rows = res.data ?? []
  const state = (sid: string) => rows.find((r) => r.swarm_id === sid)?.active ?? false
  const liveAtts = (sid: string) => (atts.data ?? []).filter((a) => a.swarm_id === sid && (a.status === 'active' || a.status === 'binding'))
  const activate = async (sid: string) => {
    setBusy(sid)
    try {
      const out = await need(client, 'activateProgram', 'Activating apps')(programId, sid)
      res.mutate((l) => [...(l ?? []).filter((r) => r.swarm_id !== sid), out])
      toast({ tone: 'success', title: `${name} is active in ${shown(swarms[sid]?.name ?? sid)}`, body: 'Minds there still need to be attached, one by one.' })
    } catch (e) {
      toast(actionFailure(e, 'Could not activate'))
    } finally {
      setBusy(null)
    }
  }
  return (
    <>
      <p className="mb-2 text-[12.5px] text-ink-3">An app works in a swarm only once a named admin activates it there. Activating gives no mind access by itself.</p>
      <ul className="overflow-hidden rounded-xl border border-line bg-black/20">
        {Object.values(swarms).map((s, i) => {
          const on = state(s.id)
          return (
            <li key={s.id} className={cx('flex items-center gap-3 px-3 py-2.5', i > 0 && 'border-t border-line')}>
              <span className={cx('size-2 rounded-full', on ? 'bg-good' : 'bg-white/20')} aria-hidden="true" />
              <div className="min-w-0 flex-1 text-[13px]">
                <div className="text-ink">{shown(s.name)}</div>
                <div className="text-meta text-ink-4">{on ? `active · ${liveAtts(s.id).length} mind${liveAtts(s.id).length === 1 ? '' : 's'} attached` : rows.some((r) => r.swarm_id === s.id) ? 'deactivated' : 'never activated'}</div>
              </div>
              {admin &&
                (on ? (
                  has(client, 'deactivateProgram') && (
                    <Button variant="ghost" className="min-h-9 px-2.5 text-[12px]" disabled={!!busy} onClick={() => setOff({ program: programId, swarm_id: s.id, active: true })}>
                      Deactivate…
                    </Button>
                  )
                ) : (
                  has(client, 'activateProgram') && (
                    <Button variant="subtle" className="min-h-9 px-2.5 text-[12px]" disabled={!!busy} onClick={() => void activate(s.id)}>
                      {busy === s.id ? 'Activating…' : 'Activate'}
                    </Button>
                  )
                ))}
            </li>
          )
        })}
      </ul>
      <AnimatePresence>
        {off && (
          <DecisionDialog
            icon="power"
            eyebrow="Deactivate an app"
            title={`Stop ${name} in ${shown(swarms[off.swarm_id]?.name ?? off.swarm_id)}?`}
            facts={[
              ['App', `${name} (${programId})`],
              ['Swarm', shown(swarms[off.swarm_id]?.name ?? off.swarm_id)],
              ['Minds that lose access', liveAtts(off.swarm_id).length ? liveAtts(off.swarm_id).map((a) => `${who(`agent:${a.mind_id}`, agents)}: ${a.actions.join(', ')}`).join('; ') : 'none'],
              ['What happens', 'The app stops working here and every attachment in this swarm is revoked; each mind is told. Activating again later does not restore them: each mind is reviewed afresh.'],
            ]}
            bound={bindTo(off, rows.find((r) => r.swarm_id === off.swarm_id), ['swarm_id', 'active'], (l) => (l.active ? null : 'It is already inactive here.'))}
            thing="This activation"
            onClose={() => setOff(null)}
            actions={[
              {
                label: 'Deactivate',
                busyLabel: 'Deactivating',
                tone: 'danger',
                run: async () => {
                  try {
                    const out = await need(client, 'deactivateProgram', 'Deactivating apps')(programId, off.swarm_id)
                    res.mutate((l) => [...(l ?? []).filter((r) => r.swarm_id !== off.swarm_id), out])
                    atts.reload()
                    toast({ tone: 'info', title: `${name} stopped in ${shown(swarms[off.swarm_id]?.name ?? off.swarm_id)}` })
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
    </>
  )
}

const ATT_WORD: Record<string, string> = { active: 'attached', binding: 'attaching', unbind_pending: 'detaching', revoked: 'revoked' }

function Attachments({ programId, name, admin, onDeciding }: { programId: string; name: string; admin: boolean; onDeciding: (b: boolean) => void }) {
  const client = useHive((s) => s.client)
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const res = useResource(() => need(client, 'programAttachments', 'Attachments')(programId), { context: programId, poll: 20_000 })
  const acts = useResource(() => need(client, 'programActivations', 'Activations')(programId), { context: programId })
  const [detach, setDetach] = useState<AppAttachment | null>(null)
  const [attach, setAttach] = useState<{ mind: Agent; offer: AppOffer } | null>(null)
  const [pick, setPick] = useState('')
  const [offerErr, setOfferErr] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  useEffect(() => onDeciding(!!detach || !!attach), [detach, attach, onDeciding])
  if (res.status === 'unsupported') return <p className="text-[13px] text-ink-4">This hive does not list app attachments.</p>
  if (res.status === 'loading') return <Skeleton className="h-24 rounded-xl" />
  if (res.status === 'error') return <p className="text-[13px] text-bad">Could not read attachments: {errorMessage(res.error)}</p>
  const list = res.data ?? []
  const activeSwarms = new Set((acts.data ?? []).filter((a) => a.active).map((a) => a.swarm_id))
  const attached = new Set(list.filter((a) => a.status === 'active' || a.status === 'binding').map((a) => a.mind_id))
  const candidates = Object.values(agents).filter((a) => a.swarm_id && activeSwarms.has(a.swarm_id) && !attached.has(a.id))

  const ask = async () => {
    const mind = agents[pick]
    if (!mind) return
    setAsking(true)
    setOfferErr(null)
    try {
      const offer = await need(client, 'offerProgram', 'App offers')(programId, mind.id)
      setAttach({ mind: { ...mind }, offer })
    } catch (e) {
      setOfferErr(actionFailure(e, 'Could not ask the app').body)
    } finally {
      setAsking(false)
    }
  }

  return (
    <>
      <p className="mb-2 text-[12.5px] text-ink-3">A mind acts through {name} only when a named admin reviews what the app offers it and attaches a subset. Revoking stops it at once.</p>
      {list.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-3 py-3 text-center text-[12.5px] text-ink-4">No mind has been attached to {name}.</p>
      ) : (
        <ul className="overflow-hidden rounded-xl border border-line bg-black/20">
          {list.map((a, i) => (
            <li key={a.id} className={cx('flex items-start gap-3 px-3 py-2.5 text-[13px]', i > 0 && 'border-t border-line')}>
              <div className="min-w-0 flex-1">
                <div className="text-ink">
                  {who(`agent:${a.mind_id}`, agents)} <span className="text-ink-4">in {shown(swarms[a.swarm_id]?.name ?? a.swarm_id)}</span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1">
                  {a.actions.map((x) => (
                    <span key={x} className="inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-px font-mono text-[11px] text-ink-2">
                      {x}
                      {a.policy[x] && <ModeChip mode={a.policy[x]} />}
                    </span>
                  ))}
                </div>
                <div className="mt-0.5 text-meta text-ink-4">
                  {ATT_WORD[a.status] ?? a.status} · by {who(a.granted_by, agents)}
                  {a.channels?.length ? ` · channels ${a.channels.join(', ')}` : ''}
                  {a.expires_at ? ` · ends ${until(a.expires_at)}` : ''}
                  {a.revoked_by ? ` · revoked by ${who(a.revoked_by, agents)}` : ''}
                </div>
              </div>
              {admin && has(client, 'detachProgram') && (a.status === 'active' || a.status === 'binding') && (
                <Button variant="danger" className="min-h-9 px-2.5 text-[12px]" onClick={() => setDetach({ ...a, actions: [...a.actions], policy: { ...a.policy } })}>
                  Revoke…
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {admin && has(client, 'offerProgram') && has(client, 'attachProgram') && (
        <div className="mt-3 rounded-xl border border-line bg-white/[0.02] p-3">
          <div className="text-[13px] font-medium text-ink">Attach a mind</div>
          {candidates.length === 0 ? (
            <p className="mt-1 text-[12.5px] text-ink-4">{activeSwarms.size ? 'Every mind in the swarms where it is active is attached.' : `Activate ${name} in a swarm first.`}</p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Mind to attach" className="min-h-10 min-w-[180px] flex-1 rounded-xl border border-line bg-black/30 px-2.5 text-[13px] text-ink outline-none focus:border-line-2">
                <option value="">Choose a mind…</option>
                {candidates.map((a) => (
                  <option key={a.id} value={a.id}>
                    {shown(a.name)} · {shown(swarms[a.swarm_id!]?.name ?? '')}
                  </option>
                ))}
              </select>
              <Button variant="subtle" disabled={!pick || asking} onClick={() => void ask()}>
                {asking ? 'Asking the app…' : 'See what it offers…'}
              </Button>
            </div>
          )}
          {offerErr && <p className="mt-1.5 text-[12.5px] text-bad">{offerErr}</p>}
        </div>
      )}
      <AnimatePresence>
        {detach && (
          <DecisionDialog
            icon="ban"
            eyebrow="Revoke an app attachment"
            title={`Stop ${who(`agent:${detach.mind_id}`, agents)} acting through ${name}?`}
            facts={[
              ['Mind', `${who(`agent:${detach.mind_id}`, agents)} (${detach.mind_id})`],
              ['Swarm', shown(swarms[detach.swarm_id]?.name ?? detach.swarm_id)],
              ['May now', detach.actions.map((x) => `${x} (${detach.policy[x] === 'ask' ? 'asks first' : 'without asking'})`).join(', ')],
              ['Channels', detach.channels?.length ? detach.channels.join(', ') : 'none'],
              ['Ends', detach.expires_at ? `${new Date(detach.expires_at).toLocaleString()} (${until(detach.expires_at)})` : 'when revoked'],
              ['Granted by', who(detach.granted_by, agents)],
              ['Attachment', detach.id],
              ['What happens', 'Its rules for this app are removed at once and the mind is told. Attaching again needs a fresh review.'],
            ]}
            bound={bindTo(detach, list.find((a) => a.id === detach.id), ['id', 'status', 'actions', 'policy', 'channels', 'expires_at'], (l) => (l.status === 'active' || l.status === 'binding' ? null : `It is already ${ATT_WORD[l.status] ?? l.status}.`))}
            thing="This attachment"
            onClose={() => setDetach(null)}
            actions={[
              {
                label: 'Revoke access',
                busyLabel: 'Revoking',
                tone: 'danger',
                run: async () => {
                  try {
                    const out = await need(client, 'detachProgram', 'Revoking app access')(programId, detach.id)
                    res.mutate((l) => (l ?? []).map((a) => (a.id === out.id ? out : a)))
                    return true
                  } catch (e) {
                    return decisionFailure(e)
                  }
                },
              },
            ]}
          />
        )}
        {attach && (
          <AttachDialog
            programId={programId}
            name={name}
            mind={attach.mind}
            offer={attach.offer}
            onClose={() => setAttach(null)}
            onDone={(a) => {
              res.mutate((l) => [...(l ?? []), a])
              setPick('')
            }}
          />
        )}
      </AnimatePresence>
    </>
  )
}

function AttachDialog({ programId, name, mind, offer, onClose, onDone }: { programId: string; name: string; mind: Agent; offer: AppOffer; onClose: () => void; onDone: (a: AppAttachment) => void }) {
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const live = useHive((s) => s.agents[mind.id])
  const swarms = useHive((s) => s.swarms)
  const [actions, setActions] = useState<Record<string, 'off' | 'allow' | 'ask'>>(() => Object.fromEntries(offer.actions_offered.map((a) => [a, 'off'])))
  const [channels, setChannels] = useState<string[]>([])
  const [days, setDays] = useState('30')
  const [key] = useState(() => `ui-${mind.id}-${Date.now().toString(36)}`)
  const chosen = Object.entries(actions).filter(([, v]) => v !== 'off')
  const d = Number(days)
  const blocked = !chosen.length ? 'Choose at least one action the mind may take.' : days && (!Number.isFinite(d) || d <= 0 || d > 365) ? 'Days must be between 1 and 365, or empty for no end.' : null
  return (
    <DecisionDialog
      icon="plug"
      eyebrow="Attach a mind to an app"
      title={`Let ${shown(mind.name)} act through ${name}?`}
      facts={[
        ['Mind', `${shown(mind.name)} (${mind.id})`],
        ['Swarm', shown(swarms[mind.swarm_id ?? '']?.name ?? mind.swarm_id ?? '')],
        ['App offers', offer.actions_offered.length ? offer.actions_offered.join(', ') : 'no actions'],
        ['Channels offered', offer.channels_offered.length ? offer.channels_offered.join(', ') : 'none'],
        ['Grant', chosen.length ? chosen.map(([a, mode]) => `${a} (${mode === 'ask' ? 'asks a person each time' : 'without asking'})`).join(', ') : 'nothing yet'],
        ['Ends', days ? `in ${plural(Number(days), 'day')}` : 'when revoked'],
      ]}
      bound={bindTo(mind, live, ['id', 'swarm_id'])}
      thing="This mind"
      onClose={onClose}
      actions={[
        {
          label: 'Attach',
          busyLabel: 'Attaching',
          tone: 'primary',
          blocked,
          run: async () => {
            try {
              const out = await need(client, 'attachProgram', 'Attaching minds')(programId, {
                mind_id: mind.id,
                actions: chosen.map(([a]) => a),
                channels: channels.length ? channels : null,
                policy: Object.fromEntries(chosen.map(([a, v]) => [a, v as 'allow' | 'ask'])),
                expires_at: days ? new Date(Date.now() + d * 86_400_000).toISOString() : null,
                idempotency_key: key,
              })
              onDone(out)
              toast({ tone: 'success', icon: 'plug', title: `${shown(mind.name)} can act through ${name}`, body: chosen.map(([a]) => a).join(', ') })
              return true
            } catch (e) {
              return decisionFailure(e)
            }
          },
        },
      ]}
    >
      <fieldset>
        <legend className="mb-1 text-[12px] text-ink-3">Actions: off, ask a person each time, or allow</legend>
        <ul className="space-y-1">
          {offer.actions_offered.map((a) => (
            <li key={a} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 font-mono text-[12.5px] text-ink">{a}</span>
              <Segmented<'off' | 'ask' | 'allow'>
                label={`${a}`}
                dense
                value={actions[a]}
                onChange={(v) => setActions({ ...actions, [a]: v })}
                options={[
                  { value: 'off', label: 'Off' },
                  { value: 'ask', label: 'Ask' },
                  { value: 'allow', label: 'Allow' },
                ]}
              />
            </li>
          ))}
        </ul>
      </fieldset>
      {offer.channels_offered.length > 0 && (
        <fieldset>
          <legend className="mb-1 text-[12px] text-ink-3">Channels</legend>
          <div className="flex flex-wrap gap-3">
            {offer.channels_offered.map((c) => (
              <label key={c} className="flex items-center gap-1.5 text-[13px] text-ink-2">
                <input type="checkbox" checked={channels.includes(c)} onChange={(e) => setChannels(e.target.checked ? [...channels, c] : channels.filter((x) => x !== c))} className="size-4 accent-[var(--color-accent)]" />
                {c}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <label className="block">
        <span className="text-[12px] text-ink-3">Ends after (days; empty for no end)</span>
        <input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/[^\d]/g, ''))} className="mt-1 min-h-10 w-28 rounded-xl border border-line bg-black/30 px-3 font-mono text-[13px] text-ink outline-none focus:border-line-2" />
      </label>
    </DecisionDialog>
  )
}

/** What apps did, newest first: one app (inside its access sheet) or every app (on the Apps page). */
export function ActivityList({ program, limit = 50, compact }: { program?: string; limit?: number; compact?: boolean }) {
  const client = useHive((s) => s.client)
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const programs = useHive((s) => s.programs)
  // a person by name ("Ada Brightwater"), never their raw principal where the hive says the name
  const names = usePeopleNames()
  const res = useResource(() => need(client, 'programActivity', 'App activity')({ program, limit }), { context: program ?? '', key: limit, poll: 20_000 })
  if (res.status === 'unsupported') return compact ? null : <p className="text-[13px] text-ink-4">This hive does not record app actions.</p>
  if (res.status === 'loading') return <Skeleton className="h-20 rounded-xl" />
  if (res.status === 'error') return <p className="text-[13px] text-bad">Could not read app activity: {errorMessage(res.error)}</p>
  const rows: AppActivityRow[] = res.data ?? []
  if (!rows.length) return <p className="rounded-xl border border-dashed border-line px-3 py-3 text-center text-[12.5px] text-ink-4">No app actions yet.</p>
  return (
    <ul className="overflow-hidden rounded-xl border border-line bg-black/20 text-[12.5px]">
      {rows.map((r, i) => (
        <li key={r.id} className={cx('flex items-start gap-2.5 px-3 py-2', i > 0 && 'border-t border-line')}>
          <span className={cx('mt-0.5 shrink-0 text-[11px] font-semibold', STATUS_TONE[r.status ?? 'pending'] ?? 'text-ink-3')}>{r.status ?? 'pending'}</span>
          <div className="min-w-0 flex-1">
            <div className="text-ink">
              <span className="font-mono">{r.action}</span>
              {r.items.length > 0 && <span className="text-ink-3"> on {r.items.length} item{r.items.length === 1 ? '' : 's'}</span>}
              {!program && (
                <button className="ml-1.5 text-ink-3 hover:underline" onClick={() => navigate({ name: 'program', id: r.program, swarm: r.swarm_id })}>
                  in {shown(programs?.find((p) => p.id === r.program)?.name ?? r.program)}
                </button>
              )}
            </div>
            <div className="text-meta text-ink-4">
              <span data-activity-who="">{principalLabel(r.principal, agents, names)}</span> · {shown(swarms[r.swarm_id]?.name ?? r.swarm_id)} · {ago(r.created_at)}
              {r.approval_id && ' · approved by a person'}
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}
