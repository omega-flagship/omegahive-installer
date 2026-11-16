/**
 * Run an action with a busy flag that is always cleared, whatever the action does. Returns whether it worked;
 * a rejection becomes `{ ok: false }` with a plain message, never an unhandled error or a stuck spinner.
 */
export async function withBusy<T>(setBusy: (b: boolean) => void, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  setBusy(true)
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    return { ok: false, error: err instanceof Error && err.message ? err.message : 'Something went wrong.' }
  } finally {
    setBusy(false)
  }
}
