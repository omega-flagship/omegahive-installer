import type { ProgramActBody, ProgramDescription } from '../../api/types'
import { base64Chunked, fileActBody, parseActFile, precheckAct, precheckActFile, releaseBytes, type ActFileRefusal } from '../../lib/frameOps'
import { needsConfirm, personActivity, prepareConfirm, type ConfirmIntent } from '../../lib/hostConfirm'
import type { HostConfirmFinal, HostConfirmShown } from './HostConfirm'

/** The host confirm an app frame asks through (useHostConfirm, bound to the frame's app and swarm). */
export interface FrameConfirmHost {
  ask: (intent: ConfirmIntent, shown?: HostConfirmShown) => Promise<HostConfirmFinal>
  isOpen: () => boolean
}

export type FrameActAdmission =
  /** Refused before any dialog, mint or call: the §9c reason the frame is told. */
  | { kind: 'refused'; reason: ActFileRefusal }
  /** Asked in the host's confirm; the promise says how it ended. */
  | { kind: 'asked'; asked: Promise<HostConfirmFinal> }
  /** No host confirm for this act: it goes to the hive as before. */
  | { kind: 'plain'; body: Record<string, unknown> }

/**
 * How AppFrame admits a frame's `app-request op:'act'` (PROGRAMS.md §9c G2 and §9d). Everything the host can check
 * locally is checked before any dialog or mint (Kimi next22b/23b r2 #1): for a file act the file's shape, the
 * person, then the action and its params against describe and the declared file types and size (precheckActFile);
 * for any other confirm act the person and the action and its params (precheckAct). A refusal tells the frame the
 * documented reason; nothing is shown to the person and no token is minted. Only then is the intent prepared and
 * asked, one at a time (`busy`).
 *
 * `frameBody` is the frame's body; the host fixes the swarm and drops any frame token or key before anything else.
 */
export function admitFrameAct(
  programId: string,
  swarmId: string,
  frameBody: Record<string, unknown>,
  describe: ProgramDescription | null,
  canActFile: boolean,
  host: FrameConfirmHost,
): FrameActAdmission {
  // the host fixes the swarm (the app cannot choose another), and only the host ever adds a confirm token (§9d)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { confirm_token: _frameToken, ...rest0 } = frameBody
  const body: Record<string, unknown> = { ...rest0, swarm_id: swarmId }
  const actions = describe?.actions ?? null
  const action = String(body.action ?? '')
  // G2 (§9c): an act may carry one file from the person; the host checks it, asks the person, then sends it
  if ('file' in body) {
    const { file: raw, ...rest } = body
    const f = parseActFile(raw)
    if (!f.ok) return { kind: 'refused', reason: f.reason }
    const refuse = (reason: ActFileRefusal): FrameActAdmission => {
      releaseBytes(f.file.bytes)
      return { kind: 'refused', reason }
    }
    if (!canActFile) return refuse('person-required')
    const pre = precheckActFile(f.file, action, actions, rest.params)
    if (pre) return refuse(pre)
    if (host.isOpen()) return refuse('busy')
    // encoded once and the frame's buffer detached now: the host keeps only this body until the intent ends
    let content_base64: string
    try {
      content_base64 = base64Chunked(f.file.bytes)
    } finally {
      releaseBytes(f.file.bytes)
    }
    // one idempotency key per confirmed intent (host-made; a frame-sent key is replaced)
    const wire = fileActBody(rest, swarmId, { name: f.file.name, mime: f.file.mime, size: f.file.size, content_base64 }, crypto.randomUUID())
    const p = prepareConfirm(programId, wire, describe)
    if (!p.ok) return { kind: 'refused', reason: p.reason }
    return { kind: 'asked', asked: host.ask(p.intent, { file: { name: f.file.name, mime: f.file.mime, size: f.file.size } }) }
  }
  // §9d: an act on a confirm action (or one describe does not show) is asked in the host first
  if (!needsConfirm(describe, action)) return { kind: 'plain', body }
  if (personActivity(describe, action) && !canActFile) return { kind: 'refused', reason: 'person-required' }
  const pre = precheckAct(action, body.params, actions)
  if (pre) return { kind: 'refused', reason: pre }
  if (host.isOpen()) return { kind: 'refused', reason: 'busy' }
  const p = prepareConfirm(programId, body as unknown as ProgramActBody, describe)
  if (!p.ok) return { kind: 'refused', reason: p.reason }
  return { kind: 'asked', asked: host.ask(p.intent) }
}
