import type { Agent, Swarm } from '../../api/types'
import { shown } from '../../lib/displayName'
import { href } from '../../lib/router'
import { sleepingCoordinator } from './pickSwarm'

const SLEEP_WORDS: Record<string, string> = { asleep: 'is asleep', stopped: 'is stopped', error: 'has a problem', created: 'has not started yet', starting: 'is still starting' }

/**
 * An app's swarm whose coordinator is not awake: the page says so, and offers the way to that mind (Studio walk,
 * OI-5 interim; Design's next-action r1). The link opens the existing mind page in a new tab, so the app here (an
 * unsaved creation, a field draft, the Ask) stays as it is; that page's own permissions and controls apply. Nothing
 * is woken from here and no new permission is asked for. Nothing renders while the coordinator is awake or unset.
 */
export function CoordinatorNotice({ swarm, agents }: { swarm: Swarm | null | undefined; agents: Record<string, Agent> }) {
  const sleeper = sleepingCoordinator(swarm ?? undefined, agents)
  if (!sleeper || !swarm) return null
  return (
    <div role="status" data-coordinator-notice="" className="relative z-[1] m-3 rounded-xl border border-warn/25 bg-warn/[0.06] px-3 py-2 text-[12.5px] text-ink-2">
      {shown(sleeper.name)}, who coordinates {shown(swarm.name)}, {SLEEP_WORDS[sleeper.status] ?? 'is not awake'}. Requests made here wait until it is awake.
      <a
        href={href({ name: 'dot', id: sleeper.id, tab: 'mind' })}
        target="_blank"
        rel="noopener noreferrer"
        className="ml-2 inline-block rounded py-1 underline underline-offset-2 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 pointer-coarse:py-2.5"
      >
        View this mind in a new tab
      </a>
    </div>
  )
}
