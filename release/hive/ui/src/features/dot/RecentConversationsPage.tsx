import { useMemo } from 'react'
import { experienceById } from '../../experiences/registry'
import { navigate } from '../../lib/router'
import { useMe } from '../../lib/useAdmin'
import { Screen } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { useLook } from '../../shell/uiVariant'
import { useHive } from '../../store/store'
import { Page } from '../../ui/Page'
import { conversationsScreen } from './conversations'
import { chatRoute } from './tabNav'
import { recentChats } from './recent'

/**
 * #/conversations: Recent conversations (mind-chat r1). The minds this person has chatted with lately, newest first;
 * each opens straight into its Chat tab. Reachable in one step from every look's own navigation (feature talk.recent).
 * The screen is atoms (conversations.metta) that MeTTa composes for the look being worn; this page reads the store,
 * states the facts, and carries out a press.
 */
export default function RecentConversationsPage() {
  const chattedAt = useHive((s) => s.chattedAt)
  const messages = useHive((s) => s.messages)
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const { me } = useMe()
  const look = experienceById(useLook().current?.experience).id
  const compose = useCompose(look)
  const { plan, data } = useMemo(() => {
    const rows = recentChats({ chattedAt, messages, agents }, me?.principal)
    const { data, facts } = conversationsScreen(rows, agents, swarms)
    return { plan: compose('conversations', facts), data }
  }, [chattedAt, messages, agents, swarms, me?.principal, compose])

  return (
    <Page title="Recent conversations" eyebrow="Minds you talked to" label="Recent conversations" onClose={() => navigate({ name: 'hive' })}>
      <div className="mx-auto max-w-xl px-3 pt-2 pb-12 md:px-6">
        <Screen plan={plan} host={{
          data,
          framed: true,
          onOpen: (target, item) => { if (target === 'chat') navigate(chatRoute(String(item.id))) },
          onAction: (action) => { if (action === 'find-mind') navigate({ name: 'hive' }) },
        }} />
      </div>
    </Page>
  )
}
