/**
 * Reads a hive error body, including OmegaCode errors relayed by /api/code/proxy:
 * - hive errors: {error: {code, message}}
 * - relayed OmegaCode errors (next8, live since 2026-10-05): {error: {code, message, ...details, source: 'omegacode',
 *   upstream_status}}. A service 401 arrives as 403, so it can never look like the hive session ending.
 * A bare {error: "<code>", message} body keeps its code, but is never taken for a relayed service error: the hive no
 * longer relays raw service bodies (the live 60fa650 shape is gone), so nothing special is done for the proxy path.
 * `upstreamStatus` is the service's own status, from the envelope.
 */
export interface ParsedError {
  code: string
  message: string
  source?: 'omegacode'
  upstreamStatus?: number
}

/**
 * Plain words for the hive's 403 grant_scope: a change asked for with read-only code access. The Code relay and
 * capability issuance keep a grant's actions within its scope (platform bfbb100); the grant still works for looking.
 * The host's own message names the method and path, which is not for a person to read.
 */
export const GRANT_SCOPE_WORDS = 'That code access only lets you look, not change code. Nothing was changed.'

export function parseErrorBody(status: number, statusText: string, data: unknown): ParsedError {
  const fallback: ParsedError = { code: `http_${status}`, message: statusText || 'Request failed' }
  if (typeof data !== 'object' || data === null) return fallback
  const body = data as { error?: unknown; message?: unknown }
  if (typeof body.error === 'string') return { code: body.error, message: status === 403 && body.error === 'grant_scope' ? GRANT_SCOPE_WORDS : typeof body.message === 'string' ? body.message : fallback.message }
  if (typeof body.error === 'object' && body.error !== null) {
    const e = body.error as { code?: unknown; message?: unknown; source?: unknown; upstream_status?: unknown }
    const out: ParsedError = { code: typeof e.code === 'string' ? e.code : fallback.code, message: typeof e.message === 'string' ? e.message : fallback.message }
    if (e.source === 'omegacode') {
      out.source = 'omegacode'
      if (typeof e.upstream_status === 'number' && Number.isInteger(e.upstream_status)) out.upstreamStatus = e.upstream_status
    }
    if (status === 403 && out.code === 'grant_scope') out.message = GRANT_SCOPE_WORDS
    return out
  }
  return fallback
}

/** Whether an answer means the person's hive session ended: any 401 (a relayed service 401 arrives as 403). */
export function endsHiveSession(status: number): boolean {
  return status === 401
}
