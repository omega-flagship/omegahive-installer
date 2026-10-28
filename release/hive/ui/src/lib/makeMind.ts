import type { Agent, CreateAgentBody } from '../api/types'
import { useHive } from '../store/store'

/** Plain words for a mind made on a connection that is no longer the current one. */
export const MADE_ELSEWHERE = 'The connection to the hive changed while the mind was being made; it is not shown here.'

/**
 * Review O-B2: making a mind from an experience (Cosmos's and Flux's forms, Construct's `spawn` … `yes`). The session is
 * taken BEFORE the dispatch, and every step after the await is bound to it:
 * - the store's createAgent already refuses a result that returns into another session (Surface R); this checks again
 *   before anything else happens, so `then` (navigation, closing a sheet) never runs for a mind from another session;
 * - the new mind's token (shown once) is revealed only while that same session is current: at once
 *   (`revealAfterMs` null) or after the experience's settle animation, re-checked when the timer fires, so a switch
 *   during the timer (A→B, and A→B→A, which is a new session) shows nothing.
 * Returns the mind (without its token); throws, with nothing shown, when the session changed.
 */
export async function makeMind(body: CreateAgentBody, then: (agent: Agent) => void, revealAfterMs: number | null): Promise<Agent> {
  const session = useHive.getState().session
  const still = () => useHive.getState().session === session
  const { token, ...agent } = await useHive.getState().createAgent(body)
  if (!still()) throw new Error(MADE_ELSEWHERE)
  then(agent)
  const reveal = () => {
    if (still()) useHive.setState({ reveal: { agent, token } })
  }
  if (revealAfterMs === null) reveal()
  else setTimeout(reveal, revealAfterMs)
  return agent
}
