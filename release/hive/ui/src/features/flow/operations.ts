export const FLOW_OPERATIONS = ['validate', 'example', 'templates', 'list', 'publish', 'read', 'layout', 'adopt', 'start', 'run', 'cancel'] as const
export type FlowOperation = typeof FLOW_OPERATIONS[number]
export interface FlowMessage { type: 'omegaflow-request'; id: string; operation: FlowOperation; params: Record<string, unknown> }
/** The frame gets a bounded operation bridge, never a bearer token or arbitrary URL fetch. */
export function isFlowMessage(value: unknown): value is FlowMessage {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.type !== 'omegaflow-request' || typeof v.id !== 'string' || !v.id || v.id.length > 80 ||
      !FLOW_OPERATIONS.includes(v.operation as FlowOperation) || !v.params || typeof v.params !== 'object' || Array.isArray(v.params)) return false
  try { return JSON.stringify(v.params).length <= 300000 } catch { return false }
}
