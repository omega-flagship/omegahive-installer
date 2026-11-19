// Purpose: adapt stopped-task receipts into the one screen both conversation surfaces draw.
import type { TaskStop } from '../../api/taskStops'
import type { Compose, ScreenFacts } from '../../screens/screenSpace'

export function stoppedScreen(stops: TaskStop[], compose: Compose, busy: string | null = null, error = ''): { data: Record<string, unknown>; facts: ScreenFacts } {
  return {
    data: {
      'stopped.rows': stops.map((stop) => ({ id: stop.id, plan: compose('stopped-task', {}),
        data: { title: stop.title, state: stop.status === 'stalled' ? 'Stalled' : 'Could not finish', reason: stop.reason, busy: busy === stop.id } })),
      'stopped.error': error,
    },
    facts: { counts: { stopped: stops.length }, flags: { 'stopped.error': !!error } },
  }
}
