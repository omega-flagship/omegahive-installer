import { AnimatePresence, m } from 'framer-motion'
import { useEffect, useMemo, useState } from 'react'
import { hsl } from '../../lib/color'
import { cx } from '../../lib/cx'
import { bindEpoch } from '../../lib/identityEpoch'
import { navigate, useRoute } from '../../lib/router'
import { actionFailure, has, need } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { Icon, type IconName } from '../../ui/Icon'
import { Page } from '../../ui/Page'
import { Button, Orb } from '../../ui/primitives'
import { RoleSelect } from '../roles/RoleSelect'
import { InviteSteps, Refusals } from './InviteSteps'
import { freshInvite, HARNESS_TITLE, holdJoining, settleJoining, type Harness } from './joinSteps'
import { OpenInvites } from './OpenInvites'
import { shown } from '../../lib/displayName'
import type { HarnessRefusal } from '../../api/missingUi'

export type HarnessInvite = Invite
interface Invite {
  id: string
  harness: Harness
  harness_label: string
  name: string
  swarm_id: string
  role_id: string | null
  status: 'waiting' | 'connected' | 'expired' | 'revoked'
  expires_at: number
  created_at: string
  agent_id: string | null
  code?: string
  mcp_url?: string
  local_url?: string
}

const KINDS: { id: Harness; title: string; blurb: string; icon: IconName; hue: number; suggest: string }[] = [
  { id: 'claude-code', title: HARNESS_TITLE['claude-code'], blurb: "Anthropic's coding agent, in a terminal or the desktop app", icon: 'terminal', hue: 24, suggest: 'Claude' },
  { id: 'codex', title: HARNESS_TITLE.codex, blurb: "OpenAI's coding agent, CLI or desktop", icon: 'cpu', hue: 160, suggest: 'Codex' },
  { id: 'hermes', title: HARNESS_TITLE.hermes, blurb: "Nous Research's open-source agent", icon: 'sparkles', hue: 280, suggest: 'Hermes' },
  { id: 'mcp', title: HARNESS_TITLE.mcp, blurb: 'Anything that speaks the Model Context Protocol', icon: 'link', hue: 200, suggest: 'Guest' },
]

/** #/connect: add an outside agent (a harness) to a swarm with a one-time join code; watch it connect. */
export default function ConnectHarness() {
  const route = useRoute()
  const client = useHive((s) => s.client)
  const swarms = useHive((s) => s.swarms)
  const agents = useHive((s) => s.agents)
  const toast = useHive((s) => s.toast)
  const swarmList = useMemo(() => Object.values(swarms).sort((a, b) => a.created_at.localeCompare(b.created_at)), [swarms])
  const [kind, setKind] = useState<Harness>('claude-code')
  const [name, setName] = useState('Claude')
  const [swarm, setSwarm] = useState(route.name === 'connect' && route.swarm ? route.swarm : swarmList[0]?.id ?? '')
  const [roleId, setRoleId] = useState<string | null>(null)
  const [days, setDays] = useState('1')
  const [invite, setInvite] = useState<Invite | null>(null)
  const [refusals, setRefusals] = useState<HarnessRefusal[]>([])
  const [busy, setBusy] = useState(false)
  const meta = KINDS.find((k) => k.id === kind)!
  const canInvite = has(client, 'createHarnessInvite')

  useEffect(() => {
    if (!invite || invite.status !== 'waiting' || !client?.harnessInvite) return
    const t = setInterval(() => {
      void client.harnessInvite!(invite.id).then((s) => setInvite((cur) => (cur ? { ...cur, ...s } : cur))).catch(() => undefined)
      // a try that was refused shows here while the person waits (a wrong, withdrawn or expired code)
      if (client.harnessRefusals) void client.harnessRefusals().then(setRefusals).catch(() => undefined)
    }, 2000)
    return () => clearInterval(t)
  }, [invite, client])

  // once the invitation is seen joined, expired or withdrawn, the page lets go of its code
  useEffect(() => {
    if (invite) settleJoining(invite.id, invite.status)
  }, [invite])

  const pickKind = (k: Harness) => {
    setKind(k)
    const s = KINDS.find((x) => x.id === k)!.suggest
    let n = s
    let i = 2
    while (Object.values(agents).some((a) => a.name.toLowerCase() === n.toLowerCase())) n = `${s} ${i++}`
    setName(n)
  }

  // make an invitation and show its steps: from the form, or a fresh code for one that expired
  const create = async (body: { harness: string; name: string; swarm_id: string; role_id: string | null; ttl_minutes: number }) => {
    if (busy) return
    setBusy(true)
    const binding = bindEpoch()
    try {
      const made = await need(client, 'createHarnessInvite', 'Inviting a harness')(body)
      // the code is shown only to the person who made the invitation, and kept for this page so its steps can be shown again
      binding.commit(() => {
        holdJoining(made.id, made)
        setInvite(made)
      })
    } catch (e) {
      toast(actionFailure(e, 'Could not create the invitation'))
    } finally {
      setBusy(false)
    }
  }
  const generate = () => (swarm ? create({ harness: kind, name: name.trim(), swarm_id: swarm, role_id: roleId, ttl_minutes: Number(days) * 24 * 60 }) : undefined)

  const swarmName = swarms[swarm]?.name

  return (
    <Page title="Add an outside agent" eyebrow="Bring any agent into a swarm" label="Add an outside agent" onClose={() => navigate({ name: 'hive' })}>
      <div className="mx-auto max-w-3xl space-y-6 px-4 pt-2 pb-16 md:px-6">
        {!invite ? (
          <>
            <section>
              <h2 className="eyebrow mb-2">Which agent?</h2>
              <div className="grid gap-2 sm:grid-cols-2">
                {KINDS.map((k) => {
                  const on = k.id === kind
                  return (
                    <button key={k.id} onClick={() => pickKind(k.id)} aria-pressed={on} className={cx('flex items-start gap-3 rounded-2xl border p-3.5 text-left transition-all', on ? 'bg-tint/[0.07]' : 'border-line bg-tint/[0.02] hover:border-line-2')} style={on ? { borderColor: hsl(k.hue, 90, 70, 0.55), boxShadow: `0 12px 40px -18px ${hsl(k.hue, 100, 60, 0.7)}` } : undefined}>
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-line bg-shade/25" style={{ color: hsl(k.hue, 100, 78) }}>
                        <Icon name={k.icon} size={17} />
                      </span>
                      <span className="min-w-0">
                        <span className="block font-display text-[15px] font-semibold">{k.title}</span>
                        <span className="mt-0.5 block text-[12.5px] leading-snug text-ink-3">{k.blurb}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </section>
            <section className="grid grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-2">
              <label className="block">
                <span className="eyebrow">Its name in the hive</span>
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} className="mt-2 min-h-11 w-full rounded-xl border border-line bg-shade/25 px-3 font-display text-[16px] text-ink outline-none focus:border-line-2" />
              </label>
              <label className="block">
                <span className="eyebrow">Swarm</span>
                <select value={swarm} onChange={(e) => setSwarm(e.target.value)} className="mt-2 min-h-11 w-full rounded-xl border border-line bg-shade/25 px-2.5 text-[14px] text-ink outline-none focus:border-line-2">
                  {swarmList.map((s) => (
                    <option key={s.id} value={s.id}>
                      {shown(s.name)}
                    </option>
                  ))}
                </select>
              </label>
              <div>
                <span className="eyebrow">Role</span>
                <div className="mt-2">
                  <RoleSelect value={roleId} onChange={setRoleId} />
                </div>
              </div>
              <label className="block">
                <span className="eyebrow">Join code expires in</span>
                <select value={days} onChange={(e) => setDays(e.target.value)} className="mt-2 min-h-11 w-full rounded-xl border border-line bg-shade/25 px-2.5 text-[14px] text-ink outline-none focus:border-line-2">
                  {['0.042', '1', '3', '7'].map((d) => (
                    <option key={d} value={d}>
                      {d === '0.042' ? '1 hour' : `${d} day${d === '1' ? '' : 's'}`}
                    </option>
                  ))}
                </select>
              </label>
            </section>
            <p className="text-[12.5px] leading-relaxed text-ink-3">
              The join code works once and only until it expires. The first time the agent connects with it, it joins {swarmName ?? 'the swarm'} as {name || 'a member'} and the code becomes its key. Once joined, it stays until you remove it: the code expiring does not end its access. It gets the tools any mind has (messages, tasks, beliefs) under the same approval rules, and nothing more. Remove it any time from here or its panel.
            </p>
            <div className="flex justify-end">
              <Button variant="primary" icon="link" size="lg" disabled={!canInvite || !name.trim() || !swarm || busy} onClick={() => void generate()}>
                {busy ? 'Creating…' : `Invite ${name.trim() || meta.title}`}
              </Button>
            </div>
            {!canInvite && <p className="text-right text-[12px] text-warn">Inviting a harness is not available here (this hive or the demo cannot issue codes).</p>}
            <OpenInvites />
          </>
        ) : (
          <AnimatePresence mode="wait">
            <m.div key={invite.status} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">
              <div className="flex items-center gap-4 rounded-2xl border border-line bg-tint/[0.04] p-4" style={{ boxShadow: `0 24px 60px -34px ${hsl(meta.hue, 100, 60, 0.7)}` }}>
                <Orb hue={meta.hue} size={44} status={invite.status === 'connected' ? 'awake' : 'starting'} />
                <div className="min-w-0 flex-1">
                  <div className="font-display text-lg font-semibold">
                    {invite.status === 'connected' ? `${invite.name} is in ${swarmName}` : invite.status === 'waiting' ? `Waiting for ${invite.name} to connect…` : invite.status === 'expired' ? `The code for ${invite.name} expired` : `This invitation is ${invite.status}`}
                  </div>
                  <div className="text-[12.5px] text-ink-3">
                    {invite.harness_label} · {invite.status === 'connected' ? 'joined; stays until you remove it' : invite.status === 'waiting' ? `join code expires ${new Date(invite.expires_at * 1000).toLocaleString()}` : `join code ${invite.status}`}
                  </div>
                </div>
                {invite.status === 'connected' && invite.agent_id && (
                  <Button variant="primary" onClick={() => navigate({ name: 'dot', id: invite.agent_id! })}>
                    Open {shown(invite.name)}
                  </Button>
                )}
              </div>

              {invite.status === 'waiting' && <Refusals refusals={refusals} since={invite.created_at} />}
              {invite.status === 'waiting' && <InviteSteps invite={invite} />}
              {invite.status === 'expired' && (
                <div className="space-y-2" data-expired>
                  <p className="text-[13px] text-ink-2">An unused join code stops working when it expires, so {invite.name} cannot join with this one. A new code comes with its setup steps.</p>
                  <Button variant="primary" icon="link" disabled={busy} onClick={() => void create(freshInvite(invite))}>
                    {busy ? 'Making…' : 'Make a new code'}
                  </Button>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <Button variant="subtle" icon="plus" onClick={() => setInvite(null)}>
                  Invite another
                </Button>
                {invite.status !== 'revoked' && (
                  <Button
                    variant="ghost"
                    className="text-ink-3"
                    onClick={async () => {
                      try {
                        const r = await need(client, 'revokeHarnessInvite', 'Withdrawing a harness invitation')(invite.id)
                        setInvite((cur) => (cur ? { ...cur, ...r } : cur))
                        toast({ tone: 'success', title: invite.status === 'connected' ? `${invite.name} removed from the hive` : 'Invitation withdrawn' })
                      } catch (e) {
                        toast(actionFailure(e, invite.status === 'connected' ? `Could not remove ${invite.name}` : 'Could not withdraw the invitation'))
                      }
                    }}
                  >
                    {invite.status === 'connected' ? `Remove ${invite.name}` : 'Withdraw'}
                  </Button>
                )}
              </div>
            </m.div>
          </AnimatePresence>
        )}
      </div>
    </Page>
  )
}
