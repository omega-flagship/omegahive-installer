/**
 * J3 r4.3 O3: the Ask's one seam into a live Studio session, kept dependency-free so the Ask's word path (ask/mind.ts)
 * never loads the session store, identity helpers or the confirm UI just to ask "is a session being directed?". The
 * session store registers itself here when it loads (it is loaded by the Ask thread and the app frame).
 */
import type { AskContext, AskVia } from '../../api/ask'

export interface StudioRoute {
  directing(): boolean
  steer(text: string, via: AskVia, context: AskContext): Promise<boolean>
}
let route: StudioRoute | null = null
export function registerStudioRoute(r: StudioRoute): void {
  route = r
}
/** The live session's route while one is directed; null otherwise (the Ask does what it always does). */
export function studioRoute(): StudioRoute | null {
  return route && route.directing() ? route : null
}
