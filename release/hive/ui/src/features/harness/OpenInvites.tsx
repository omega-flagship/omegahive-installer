import { AnimatePresence } from 'framer-motion'
import { useEffect, useState } from 'react'
import type { HarnessInviteRow } from '../../api/missingUi'
import { bindTo, decisionFailure } from '../../lib/decisionGate'
import { shown } from '../../lib/displayName'
import { ago } from '../../lib/format'
import { navigate } from '../../lib/router'
import { useMe } from '../../lib/useAdmin'
import { has, need, useResource } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { DecisionDialog } from '../../ui/DecisionDialog'
import { Button } from '../../ui/primitives'
import { ResourceView } from '../../ui/ResourceView'
import { boundRun, type ToastFn } from '../../lib/epochBound'
import type { Stale } from '../../lib/identityEpoch'
import type { HiveClient } from '../../api/client'
import type { DecisionResult } from '../../lib/decisionGate'
import { InviteSteps, Refusals } from './InviteSteps'
import { freshInvite, holdJoining, settleJoining } from './joinSteps'
import { actionFailure } from '../../lib/useResource'
import { bindEpoch } from '../../lib/identityEpoch'

/** Withdrawing or removing an invitation, bound to the identity it was pressed under (r5). */
export function revokeInviteRun(d: { client: HiveClient | null; asking: Pick<HarnessInviteRow, 'id' | 'status' | 'name'>; res: { mutate: (fn: (l: HarnessInviteRow[] | undefined) => HarnessInviteRow[]) => void; reload: () => void }; toast: ToastFn }): () => Promise<DecisionResult | Stale> {
  const { asking, res } = d
  return boundRun(async (binding) => {
    try {
      const out = await need(d.client, 'revokeHarnessInvite', 'Withdrawing an invitation')(asking.id)
      binding.commit(() => {
        res.mutate((l) => (l ?? []).map((x) => (x.id === asking.id ? { ...x, status: out.status, revoked_at: (out as Partial<HarnessInviteRow>).revoked_at ?? new Date().toISOString() } : x)))
        d.toast({ tone: 'success', title: asking.status === 'connected' ? `${shown(asking.name)} removed from the hive` : 'Invitation withdrawn' })
        res.reload()
      })
      return true
    } catch (e) {
      return decisionFailure(e)
    }
  })
}

const ORDER: Record<HarnessInviteRow['status'], number> = { waiting: 0, connected: 1, expired: 2, revoked: 3 }

/** Waiting invitations first (their codes still work), then joined, expired and withdrawn; newest first within. Pure. */
export function sortInvites(rows: HarnessInviteRow[]): HarnessInviteRow[] {
  return [...rows].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.created_at.localeCompare(a.created_at))
}

/** One line for an invitation's state. Pure. */
export function inviteWords(r: HarnessInviteRow, now = Date.now()): string {
  switch (r.status) {
    case 'waiting':
      return `code works until ${new Date(r.expires_at * 1000).toLocaleString()}${r.expires_at * 1000 - now < 3_600_000 ? ' (less than an hour)' : ''}`
    case 'connected':
      return `joined ${r.redeemed_at ? ago(r.redeemed_at, now) : ''}; stays until removed`.replace(' ;', ';')
    case 'expired':
      return 'code expired unused'
    case 'revoked':
      return `withdrawn ${r.revoked_at ? ago(r.revoked_at, now) : ''}`.trim()
  }
}

/**
 * Outside-agent invitations still on record (GET /api/harness-invites; admins; Surface missing-UI batch 1, audit item
 * 10). The join code itself is never listed: the hive keeps only a hash of it. A waiting invitation's setup instructions
 * open from its row, with the code while this page holds it from making the invitation (joinSteps). Withdrawing a
 * waiting code stops it working; withdrawing a joined one removes that agent from the hive (mcp.py revoke), so both are
 * decided.
 */
export function OpenInvites() {
  const client = useHive((s) => s.client)
  const { admin, loaded } = useMe()
  if (!loaded || !admin || !has(client, 'harnessInvites')) return null
  return <InviteList />
}

function InviteList() {
  const client = useHive((s) => s.client)
  const swarms = useHive((s) => s.swarms)
  const toast = useHive((s) => s.toast)
  const res = useResource(() => need(client, 'harnessInvites', 'Invitations')(), { poll: 10_000 })
  const refused = useResource(() => need(client, 'harnessRefusals', 'Refused connections')(), { poll: 10_000 })
  const [asking, setAsking] = useState<HarnessInviteRow | null>(null)
  const [showing, setShowing] = useState<ReadonlySet<string>>(() => new Set())
  const [making, setMaking] = useState<string | null>(null)
  // a code this page holds is let go once its invitation is seen joined, expired or withdrawn
  useEffect(() => {
    for (const r of res.data ?? []) settleJoining(r.id, r.status)
  }, [res.data])
  if (res.status === 'unsupported') return null
  const waiting = res.data?.filter((r) => r.status === 'waiting').length ?? 0
  // refusals matter while an invitation waits: those since the oldest waiting one was made
  const waitingSince = res.data?.filter((r) => r.status === 'waiting').map((r) => r.created_at).sort()[0]
  const toggle = (id: string) =>
    setShowing((cur) => {
      const next = new Set(cur)
      if (!next.delete(id)) next.add(id)
      return next
    })
  // an expired invitation's one tap: a fresh code for the same agent, its steps open under its new row
  const remake = async (r: HarnessInviteRow) => {
    setMaking(r.id)
    const binding = bindEpoch()
    try {
      const made = await need(client, 'createHarnessInvite', 'Making a new code')(freshInvite(r))
      binding.commit(() => {
        holdJoining(made.id, made)
        setShowing((cur) => new Set(cur).add(made.id))
        res.reload()
      })
    } catch (e) {
      toast(actionFailure(e, 'Could not make a new code'))
    } finally {
      setMaking(null)
    }
  }
  return (
    <section aria-labelledby="invites-h" className="space-y-2" data-open-invites>
      <h2 id="invites-h" className="eyebrow">Invitations{res.data ? ` · ${waiting} open` : ''}</h2>
      {waitingSince && refused.data && <Refusals refusals={refused.data} since={waitingSince} />}
      <ResourceView res={res} errorTitle="Could not list invitations" empty={{ title: 'No invitations yet', body: 'Invitations you make appear here until they are used, expire or are withdrawn.' }}>
        {(rows) => (
          <ul className="divide-y divide-line rounded-2xl border border-line bg-tint/[0.02]">
            {sortInvites(rows).map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 text-[13px]">
                <div className="min-w-0 flex-1">
                  <div className="text-ink">
                    {shown(r.name)} <span className="text-ink-4">· {r.harness_label} · {shown(swarms[r.swarm_id]?.name ?? r.swarm_id)}</span>
                  </div>
                  <div className={r.status === 'waiting' ? 'text-[12px] text-ink-2' : 'text-[12px] text-ink-4'}>
                    {r.status} · {inviteWords(r)} · made by {r.created_by.replace(/^user:/, '')} {ago(r.created_at)}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  {r.status === 'waiting' && (
                    <Button variant="subtle" aria-expanded={showing.has(r.id)} onClick={() => toggle(r.id)}>
                      {showing.has(r.id) ? 'Hide setup' : 'Setup instructions'}
                    </Button>
                  )}
                  {r.status === 'expired' && has(client, 'createHarnessInvite') && (
                    <Button variant="subtle" disabled={making !== null} onClick={() => void remake(r)}>
                      {making === r.id ? 'Making…' : 'New code'}
                    </Button>
                  )}
                  {r.status === 'connected' && r.agent_id && (
                    <Button variant="subtle" onClick={() => navigate({ name: 'dot', id: r.agent_id! })}>
                      Open
                    </Button>
                  )}
                  {(r.status === 'waiting' || r.status === 'connected') && has(client, 'revokeHarnessInvite') && (
                    <Button variant="ghost" className="text-ink-3" onClick={() => setAsking({ ...r })}>
                      {r.status === 'connected' ? 'Remove…' : 'Withdraw…'}
                    </Button>
                  )}
                </div>
                {r.status === 'waiting' && showing.has(r.id) && (
                  <div className="min-w-0 basis-full pt-1">
                    <InviteSteps invite={r} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </ResourceView>
      <AnimatePresence>
        {asking && (
          <DecisionDialog
            icon="ban"
            eyebrow="Outside agent"
            title={asking.status === 'connected' ? `Remove ${shown(asking.name)} from the hive?` : `Withdraw the invitation for ${shown(asking.name)}?`}
            facts={[
              ['Agent', `${shown(asking.name)} (${asking.harness_label})`],
              ['Swarm', shown(swarms[asking.swarm_id]?.name ?? asking.swarm_id)],
              ['State', `${asking.status} · ${inviteWords(asking)}`],
              ['Effect', asking.status === 'connected' ? 'Its key stops working at once and it leaves the swarm.' : 'The join code stops working; nobody can join with it.'],
              ['Invitation', <span className="font-mono text-[12px]">{asking.id}</span>],
            ]}
            bound={bindTo(asking, res.data?.find((x) => x.id === asking.id), ['id', 'status', 'agent_id'])}
            thing="This invitation"
            onClose={() => setAsking(null)}
            actions={[
              {
                label: asking.status === 'connected' ? `Remove ${shown(asking.name)}` : 'Withdraw',
                busyLabel: asking.status === 'connected' ? 'Removing' : 'Withdrawing',
                tone: 'danger',
                run: revokeInviteRun({ client, asking, res, toast }),
              },
            ]}
          />
        )}
      </AnimatePresence>
    </section>
  )
}
