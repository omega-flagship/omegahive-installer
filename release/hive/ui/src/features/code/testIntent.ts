export const CODE_TEST_UNAVAILABLE = "Testing isn't available on this hive yet"

/** Person Test uses the existing Ask turn/intent ledger. No run endpoint or worker authority. */
export interface CodeTestRequest {
  request_id: string
  proposal_id: string
  selection?: string[]
  test_filter?: string
}
export interface CodeTestIntentBody { kind: 'code.test'; request: CodeTestRequest }
export interface CodeTestIntentClient {
  askRecordCodeTestIntent?: (operation: string, body: CodeTestIntentBody) => Promise<unknown>
  askSubmitIntent?: (intent: string) => Promise<unknown>
}
export interface CodeTestAttempt { operation: string; body: CodeTestIntentBody; intent?: string }
export interface CodeTestQueueReceipt {
  schema: 'hive.code-test-intent-receipt/1'
  kind: 'code.test'
  request_id: string
  proposal_id: string
  lease_id: string
  receiving_goal: string
  controller_id: string
  message_id: string
  state: 'queued'
  tested: false
  accepted_source: false
}
export type CodeTestOutcome =
  | { kind: 'queued'; attempt: CodeTestAttempt; receipt: CodeTestQueueReceipt }
  | { kind: 'unknown'; attempt: CodeTestAttempt }
  | { kind: 'left'; attempted: boolean }
  | { kind: 'unavailable' }

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const reference = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(v)
const exact = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every((k) => Object.hasOwn(v, k))
const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]))
  if (object(a) && object(b)) return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => Object.hasOwn(b, k) && same(a[k], b[k]))
  return false
}
export function codeTestBody(input: CodeTestRequest): CodeTestIntentBody {
  const request: unknown = JSON.parse(JSON.stringify(input))
  if (!object(request) || Object.keys(request).some((k) => !['request_id', 'proposal_id', 'selection', 'test_filter'].includes(k)) || typeof request.request_id !== 'string' || !/^rq_[A-Za-z0-9_-]{1,120}$/.test(request.request_id) || typeof request.proposal_id !== 'string' || !/^suggestion_[a-f0-9]{32}$/.test(request.proposal_id)) throw new Error('No exact proposed change is selected.')
  const utf8 = (v: string) => new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(v)) === v
  const chars = (v: string) => [...v].length
  if (Object.hasOwn(request, 'test_filter') && (typeof request.test_filter !== 'string' || chars(request.test_filter) < 1 || chars(request.test_filter) > 512 || request.test_filter.includes('\0') || !utf8(request.test_filter))) throw new Error('The test filter is not understood.')
  if (Object.hasOwn(request, 'selection')) {
    const selection = request.selection
    if (!Array.isArray(selection) || selection.length < 1 || selection.length > 32 || selection.some((v) => typeof v !== 'string' || chars(v) < 1 || chars(v) > 200 || /[\u0000-\u001f]/.test(v) || !utf8(v)) || new Set(selection).size !== selection.length) throw new Error('The selected test references are not understood.')
  }
  if (new TextEncoder().encode(JSON.stringify(request)).length > 8192) throw new Error('The test request context is too large.')
  return { kind: 'code.test', request: request as unknown as CodeTestRequest }
}
function intentId(raw: unknown, attempt: CodeTestAttempt): string {
  if (!object(raw) || raw.kind !== 'code.test' || typeof raw.intent_id !== 'string' || !/^ai_[a-f0-9]{24}$/.test(raw.intent_id) || raw.request_operation_id !== `ask.${raw.intent_id}` || !same(raw.request, attempt.body.request) || !['pending', 'refused', 'linked'].includes(String(raw.state))) throw new Error('The test intent was not understood.')
  return raw.intent_id
}
export function parseCodeTestQueueReceipt(raw: unknown, request: CodeTestRequest): CodeTestQueueReceipt {
  const fields = ['schema', 'kind', 'request_id', 'proposal_id', 'lease_id', 'receiving_goal', 'controller_id', 'message_id', 'state', 'tested', 'accepted_source']
  if (!object(raw) || !exact(raw, fields) || raw.schema !== 'hive.code-test-intent-receipt/1' || raw.kind !== 'code.test' || raw.request_id !== request.request_id || raw.proposal_id !== request.proposal_id || raw.state !== 'queued' || raw.tested !== false || raw.accepted_source !== false || !['lease_id', 'receiving_goal', 'controller_id', 'message_id'].every((k) => reference(raw[k]))) throw new Error('The test request receipt was not understood.')
  return raw as unknown as CodeTestQueueReceipt
}
/** Explicit recovery repeats the original operation/body/intent. Never creates another Ask turn or retries itself. */
export async function resumeCodeTest(client: CodeTestIntentClient, original: CodeTestAttempt, current: () => boolean): Promise<CodeTestOutcome> {
  if (!client.askRecordCodeTestIntent || !client.askSubmitIntent) return { kind: 'unavailable' }
  if (!current()) return { kind: 'left', attempted: false }
  const attempt: CodeTestAttempt = { operation: original.operation, body: codeTestBody(original.body.request), ...(original.intent ? { intent: original.intent } : {}) }
  if (!reference(attempt.operation) || (attempt.intent && !/^ai_[a-f0-9]{24}$/.test(attempt.intent))) throw new Error('The original test request is unavailable.')
  let attempted = false
  try {
    if (!attempt.intent) {
      attempted = true
      const recorded = await client.askRecordCodeTestIntent(attempt.operation, attempt.body)
      if (!current()) return { kind: 'left', attempted }
      attempt.intent = intentId(recorded, attempt)
    }
    if (!current()) return { kind: 'left', attempted }
    attempted = true
    const raw = await client.askSubmitIntent(attempt.intent)
    if (!current()) return { kind: 'left', attempted }
    return { kind: 'queued', attempt, receipt: parseCodeTestQueueReceipt(raw, attempt.body.request) }
  } catch {
    // No raw exception/HTTP body or token is rendered; lack of an answer never proves no commit.
    return current() ? { kind: 'unknown', attempt } : { kind: 'left', attempted }
  }
}
export async function requestCodeTest(client: CodeTestIntentClient, request: CodeTestRequest, admit: (words: string) => Promise<string>, current: () => boolean): Promise<CodeTestOutcome> {
  const body = codeTestBody(request)
  if (!client.askRecordCodeTestIntent || !client.askSubmitIntent) return { kind: 'unavailable' }
  if (!current()) return { kind: 'left', attempted: false }
  // The Ask itself admits the person's words. Its returned operation is the only one used below.
  const operation = await admit('Run the tests for this proposed change in its isolated copy. Show any failures before applying it.')
  if (!current()) return { kind: 'left', attempted: false }
  return resumeCodeTest(client, { operation, body }, current)
}
