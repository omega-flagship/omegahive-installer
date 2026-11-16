/**
 * What the gallery (shell/ChangeUi) and the preview bar (shell/LookPreviewBar) do when a person presses Keep or
 * Reset, and what they then SAY. Every caller takes its identity binding BEFORE its await and says (or writes)
 * anything afterwards only through `binding.commit` (r1g): the callee's own 'stale' check runs in an earlier
 * continuation, and a sign-in change can land between it and this one. So a toast for A never reaches B.
 *
 * `ops` is the async look API, injectable so a test can switch identity after the callee's last check and before the
 * caller resumes.
 */
import { bindEpoch } from '../lib/identityEpoch'
import { GENERIC_REFUSAL, keepRequestedOutcome, keptLine, lookStatus, requestState, type KeepOutcome, type LookStatus } from '../features/requestExperience/store'
import { keepLookBound } from './keepBound'
import { DEFAULT_VARIANT, lookName, NotKept, resetLook, type UiPrefs } from './uiVariant'

export type Say = (t: { tone: 'success' | 'info' | 'error'; title: string; body?: string }) => void
type Client = Parameters<typeof keepLookBound>[0]

export interface LookOps {
  keep(client: Client, p: UiPrefs): Promise<'kept' | 'stale'>
  keepRequested(client: Client): Promise<KeepOutcome>
  reset(client: Client): Promise<'done' | 'conflict' | 'stale'>
  /** the look on screen came from the request's words */
  fromWords(p: UiPrefs): boolean
  /** where one of the person's looks is NOW (saved, held for this session, absent): read when a message is said */
  lookStatus(id: string): LookStatus
}
export const LOOK_OPS: LookOps = {
  keep: keepLookBound,
  keepRequested: (c) => keepRequestedOutcome(c as Parameters<typeof keepRequestedOutcome>[0]),
  reset: (c) => resetLook(c),
  fromWords: (p) => requestState().previewing?.prefs === p,
  lookStatus: (id) => lookStatus(id),
}

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** The gallery's "Keep {name}". A look from words is kept as one of the person's looks (the request says so). */
export async function galleryKeep(client: Client, p: UiPrefs, say: Say, ops: LookOps = LOOK_OPS): Promise<void> {
  const binding = bindEpoch()
  if (ops.fromWords(p)) {
    // as the preview bar does: a refusal is ALWAYS said to the person who pressed Keep (its reason, or a plain generic
    // line: Kimi r1h P3), in the same tick as the identity check; a kept look is shown by the request panel itself;
    // a superseded or idle Keep says nothing (keepRequestedOutcome says why)
    const out = await ops.keepRequested(client)
    if (out.kind === 'refused') binding.commit(() => say({ tone: 'error', title: 'Could not keep this look', body: out.reason ?? GENERIC_REFUSAL }))
    return
  }
  try {
    if ((await ops.keep(client, p)) === 'stale') return
    binding.commit(() => say({ tone: 'success', title: `${lookName(p)} kept`, body: 'Change it any time from You & your keys, or the command palette.' }))
  } catch (e) {
    // a conflict is said by the one look notice (Use mine), not here
    if (e instanceof NotKept) return
    binding.commit(() => say({ tone: 'error', title: 'Could not keep this look', body: errMessage(e) }))
  }
}

/** The gallery's "Reset to OmegaHive". */
export async function galleryReset(client: Client, say: Say, ops: LookOps = LOOK_OPS): Promise<void> {
  const binding = bindEpoch()
  // a conflict is said by the one notice (the host kept another look); stale says nothing
  if ((await ops.reset(client)) !== 'done') return
  binding.commit(() => say({ tone: 'info', title: `Back to ${DEFAULT_VARIANT.name}`, body: 'The Classic hive in the OmegaHive look.' }))
}

/** The preview bar's Keep (`name`: the look's name, for "Ember Forge kept"). */
export async function barKeep(client: Client, p: UiPrefs, name: string, say: Say, ops: LookOps = LOOK_OPS): Promise<void> {
  const binding = bindEpoch()
  try {
    if (ops.fromWords(p)) {
      const out = await ops.keepRequested(client)
      if (out.kind === 'refused') binding.commit(() => say({ tone: 'error', title: 'Could not keep this look', body: out.reason ?? GENERIC_REFUSAL }))
      if (out.kind !== 'kept') return // refused (said), superseded or idle (nothing to say)
      // what is said about Your looks is DERIVED from where the look is when it is said (stand-in r1p P2, lead r1q): never
      // from a flag captured at the Keep. Held for this session, or not among Your looks (full after the host accepted):
      // said as exactly that; never "kept in Your looks" when it is not saved there
      return void binding.commit(() => {
        const status: LookStatus = ops.lookStatus(p.variant?.id ?? '')
        if (status !== 'saved') return say({ tone: 'info', title: `${name} kept`, body: keptLine(name, out.shown, status) })
        // kept but not on screen (a newer choice is showing): said as exactly that (Kimi r1j #2)
        if (!out.shown) return say({ tone: 'success', title: `${name} kept in Your looks`, body: 'A newer choice is on screen now.' })
        say({ tone: 'success', title: `${name} kept` })
      })
    } else if ((await ops.keep(client, p)) === 'stale') return
    binding.commit(() => say({ tone: 'success', title: `${name} kept` }))
  } catch (e) {
    // a conflict is said by the one look notice (Use mine), not here
    if (e instanceof NotKept) return
    binding.commit(() => say({ tone: 'error', title: 'Could not keep this look', body: errMessage(e) }))
  }
}
