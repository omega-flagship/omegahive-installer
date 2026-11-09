/**
 * Restoring an app's saved presentation once its document is ready (AppFrame, app-ready): the one-time restore entry is
 * consumed (its single use is spent) and, if the host says it is still current, the snapshot is handed to the frame.
 * Identity rule (release baseline r1): every step after an await re-checks that the same sign-in, document and release
 * are current (`current()`), and the restoring consume is sent only after that re-check, so a sign-in change during the
 * consent check sends no restoring consume and restores nothing. Whatever stops it before the consume, the entry is still
 * burnt once (`burn`, best effort, through the client of the sign-in it was saved under) so it can never be replayed.
 */
export interface RestoreSteps {
  /** an app-link entry or normal consent must be checked first */
  needsConsent: boolean
  /** the Ask entry is admitted for this document */
  ensureEntry(): Promise<boolean>
  /** this document's app-link frame id, once registered */
  frame(): Promise<string | null>
  /** the consent check for that frame (an entry's check or the frame's), or null when this client can't check */
  check(frameId: string): Promise<unknown> | null
  /** the same sign-in, document and release are still current */
  current(): boolean
  /** the restoring consume: spends the entry and answers whether its presentation is still current */
  consume(): Promise<unknown>
  /** spend the entry without restoring (best effort, never awaited) */
  burn(): void
  /** hand the saved presentation to the frame */
  restore(): void
}

const isCurrentAnswer = (v: unknown) => !!v && typeof v === 'object' && Object.keys(v).join(',') === 'current' && (v as { current?: unknown }).current === true

export async function restoreAfterConsent(s: RestoreSteps): Promise<void> {
  let consumeStarted = false
  try {
    if (s.needsConsent) {
      if (!await s.ensureEntry()) return
      const fid = await s.frame()
      if (!fid || !s.current()) return
      const pending = s.check(fid)
      const consent = pending ? await pending : null
      if (!isCurrentAnswer(consent)) return
      // the consent check awaited the network: the sign-in may have changed since
      if (!s.current()) return
    }
    consumeStarted = true
    const answer = await s.consume()
    if (!s.current() || !isCurrentAnswer(answer)) return
    s.restore()
  } finally {
    if (!consumeStarted) s.burn()
  }
}
