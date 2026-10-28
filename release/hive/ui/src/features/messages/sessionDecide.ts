import type { Decision } from '../../store/store'

/**
 * SessionView's answer to an approval in its timeline (Review D1, Kimi #4 on next22). The answer carries the store
 * session the timeline was read under (`shownUnder`; the store refuses an earlier session's). Whatever the store
 * returns, taken or refused (an earlier session, a request no longer pending, a lost answer), the timeline is read
 * again so the person sees what is true now, not the request as it was. Nothing is sent before the timeline was read.
 */
export async function answerShown(
  id: string,
  d: Decision,
  shownUnder: string | null,
  decide: (id: string, d: Decision, minutes: number | undefined, session: string) => Promise<unknown>,
  reload: () => void,
): Promise<void> {
  if (shownUnder === null) return
  try {
    await decide(id, d, undefined, shownUnder)
  } finally {
    reload()
  }
}
