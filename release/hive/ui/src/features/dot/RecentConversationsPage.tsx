import { useMemo } from 'react'
import { ago } from '../../lib/format'
import { navigate } from '../../lib/router'
import { useMe } from '../../lib/useAdmin'
import { shown } from '../../lib/displayName'
import { useHive } from '../../store/store'
import { Page } from '../../ui/Page'
import { Button, EmptyState, Orb } from '../../ui/primitives'
import { chatRoute } from './tabNav'
import { recentChats } from './recent'

/**
 * #/conversations: Recent conversations (mind-chat r1). The minds this person has chatted with lately, newest first;
 * each opens straight into its Chat tab. Reachable in one step from every look's own navigation (feature talk.recent).
 */
export default function RecentConversationsPage() {
  const chattedAt = useHive((s) => s.chattedAt)
  const messages = useHive((s) => s.messages)
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const { me } = useMe()
  const rows = useMemo(() => recentChats({ chattedAt, messages, agents }, me?.principal), [chattedAt, messages, agents, me?.principal])

  return (
    <Page title="Recent conversations" eyebrow="Minds you talked to" label="Recent conversations" onClose={() => navigate({ name: 'hive' })}>
      <div className="mx-auto max-w-xl px-3 pt-2 pb-12 md:px-6">
        {rows.length === 0 ? (
          <EmptyState
            icon="chat"
            title="No conversations yet"
            body="When you message a mind, it is listed here so you can go straight back to its chat."
            action={<Button onClick={() => navigate({ name: 'hive' })}>Find a mind</Button>}
          />
        ) : (
          <ul className="space-y-2" aria-label="Recent conversations" data-recent-conversations="">
            {rows.map((r) => {
              const a = agents[r.id]
              const swarm = a.swarm_id ? swarms[a.swarm_id] : undefined
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => navigate(chatRoute(r.id))}
                    data-recent-mind={r.id}
                    className="flex min-h-14 w-full items-center gap-3 rounded-2xl border border-line bg-white/[0.03] px-3.5 py-2.5 text-left hover:border-line-2 hover:bg-white/[0.05]"
                  >
                    <Orb hue={a.hue} status={a.status} size={30} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14.5px] font-medium text-ink">{shown(a.name)}</span>
                      <span className="block truncate text-[12px] text-ink-3">
                        {swarm ? shown(swarm.name) : 'No swarm'} · {a.status} · you wrote {ago(r.at)}
                      </span>
                    </span>
                    <span className="shrink-0 text-[12.5px] text-ink-2">Open chat ›</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Page>
  )
}
