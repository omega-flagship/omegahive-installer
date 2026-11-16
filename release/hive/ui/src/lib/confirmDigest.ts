/**
 * The payload digest a host confirm token binds (PROGRAMS.md §9d): the act's items, params and base_revision as the hive
 * normalises them, plus the file's {name, mime, size, sha256} when one is sent, written as the hive's canonical JSON:
 *
 *   Python  json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
 *
 * and digested as "sha256:" + hex(sha256(utf8(text))). Proven byte-equal against Python-computed vectors
 * (confirmDigest.test.ts).
 *
 * Numbers (Platform B1, 2026-10-05; shared vectors hive/tests/fixtures/confirm_digest_vectors.json at 1e23aa0): a confirmable payload holds integers with |n| ≤ 2^53−1 only. Decimals, −0,
 * NaN/Infinity and larger numbers are refused here before any call (the hive refuses them too, 400
 * `confirm_unsupported_value`), because JavaScript and Python do not write them the same way. Strings with a lone
 * surrogate are refused as well (Python could not encode them as UTF-8).
 */

/** The sentence a person sees when a payload holds a value the hive cannot check exactly. Nothing is sent. */
export const UNSUPPORTED_VALUE = 'This can’t be confirmed: it holds a value the hive can’t check exactly (a decimal or a very large number). Nothing was sent.'

export class ConfirmValueError extends Error {
  constructor(readonly path: string, why: string) {
    super(`${UNSUPPORTED_VALUE} (${path}: ${why})`)
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** Python's str ordering, and §9d's: by Unicode code point via codePointAt (JavaScript's default sort compares UTF-16 units, which differs above U+FFFF). */
export function byCodePoint(a: string, b: string): number {
  const x = [...a]
  const y = [...b]
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!
    if (d) return d
  }
  return x.length - y.length
}

/** The hive's canonical JSON of a JSON value; throws ConfirmValueError for anything it would not write identically. */
export function canonicalJson(value: unknown, path = '$'): string {
  if (value === null) return 'null'
  if (value === true) return 'true'
  if (value === false) return 'false'
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return fail(path, Number.isFinite(value) ? (Number.isInteger(value) ? 'larger than 2^53−1' : 'a decimal') : 'not a finite number')
    if (Object.is(value, -0)) return fail(path, '−0')
    return String(value)
  }
  if (typeof value === 'string') {
    if (LONE_SURROGATE.test(value)) return fail(path, 'a broken character')
    return quote(value)
  }
  if (Array.isArray(value)) return `[${value.map((v, i) => canonicalJson(v, `${path}[${i}]`)).join(',')}]`
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const o = value as Record<string, unknown>
    const keys = Object.keys(o).sort(byCodePoint)
    for (const k of keys) if (LONE_SURROGATE.test(k)) fail(`${path}.${k}`, 'a broken character')
    return `{${keys.map((k) => `${quote(k)}:${canonicalJson(o[k], `${path}.${k}`)}`).join(',')}}`
  }
  return fail(path, `not JSON (${typeof value})`)
}

/**
 * A string as §9d writes it (ced0564), by our own rule rather than JSON.stringify's: escape exactly " \\ \b \f \n \r \t;
 * every other U+0000–U+001F as lowercase \u00xx; `/`, U+007F and all non-ASCII written as they are (UTF-8 once encoded).
 * The caller has already refused lone surrogates.
 */
const SHORT: Record<string, string> = { '"': '\\"', '\\': '\\\\', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t' }
export function quote(s: string): string {
  let out = '"'
  for (const ch of s) {
    const c = ch.charCodeAt(0)
    if (SHORT[ch]) out += SHORT[ch]
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, '0')}`
    else out += ch
  }
  return `${out}"`
}

/** §9d: a confirmed act's canonical payload (file bytes are never in it) is at most 2 MiB of UTF-8, at mint and at act. */
export const CONFIRM_MAX_BYTES = 2 * 1024 * 1024
/** The sentence when a payload is over that limit (refused here before any call, or 413 confirm_payload_too_large). */
export const PAYLOAD_TOO_LARGE = 'This is too large to confirm: what it carries is over 2 MB. Nothing was sent.'
export class ConfirmTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(PAYLOAD_TOO_LARGE)
  }
}
/** The canonical text's UTF-8 size, refused over CONFIRM_MAX_BYTES. */
export function assertConfirmSize(canonical: string): void {
  const n = new TextEncoder().encode(canonical).byteLength
  if (n > CONFIRM_MAX_BYTES) throw new ConfirmTooLargeError(n)
}

function fail(path: string, why: string): never {
  throw new ConfirmValueError(path, why)
}

export interface ConfirmFile {
  name: string
  mime: string
  size: number
  /** "sha256:<hex of the bytes>" */
  sha256: string
}

export interface ConfirmPayload {
  items: unknown
  params: unknown
  base_revision: unknown
  file?: ConfirmFile
}

/** Python truthiness, for the hive's `data.get("items") or []` and `data.get("params") or {}`. */
const falsy = (v: unknown) =>
  v === undefined || v === null || v === false || v === 0 || v === '' || (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0)

/**
 * The payload exactly as the hive builds it from the act body it receives (send this same body): missing or empty
 * items are [], missing or empty params are {}, a missing base_revision is null. The body should already be the
 * JSON the act sends (see wireOf), so nothing undefined or non-JSON is in it.
 */
export function confirmPayload(body: { items?: unknown; params?: unknown; base_revision?: unknown }, file?: ConfirmFile | null): ConfirmPayload {
  const payload: ConfirmPayload = {
    items: falsy(body.items) ? [] : body.items,
    params: falsy(body.params) ? {} : body.params,
    base_revision: body.base_revision === undefined ? null : body.base_revision,
  }
  if (file) payload.file = { name: file.name, mime: file.mime, size: file.size, sha256: file.sha256 }
  return payload
}

/**
 * Every number token in JSON text is a plain integer (`-?(0|[1-9][0-9]*)`): no fraction, no exponent. Parsing alone
 * cannot tell `1.0` from `1`, but the hive's parser can (Python reads `1.0` as a float), so the text is checked too.
 * NaN and Infinity are not JSON (JSON.parse refuses them). Throws ConfirmValueError.
 */
export function assertIntegerTokens(text: string): void {
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '"') {
      // skip the string, escapes included
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++
      i++
      continue
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i, i + 400))
      const tok = m?.[0] ?? c
      if (!/^-?(?:0|[1-9][0-9]*)$/.test(tok)) fail(`@${i}`, `${tok.slice(0, 24)} is not a whole number`)
      i += tok.length
      continue
    }
    i++
  }
}

/** The canonical text of a payload given as JSON text (the shared vectors' refused cases; any received JSON). */
export function canonicalJsonText(text: string): string {
  assertIntegerTokens(text)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return fail('$', 'not JSON')
  }
  return canonicalJson(value)
}

/** What the hive will parse from the body this client sends: the body through JSON once (drops undefined, toJSON...).
 *  Its number tokens are checked as text (see assertIntegerTokens). */
export function wireOf<T>(body: T): T {
  const text = JSON.stringify(body)
  assertIntegerTokens(text)
  return JSON.parse(text) as T
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

/** sha256 hex of bytes or of a string's UTF-8, with WebCrypto. */
export async function sha256Hex(data: string | Uint8Array | ArrayBuffer): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data)
  return hex(await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource))
}

/** "sha256:" + hex(sha256(utf8(canonical(payload)))). Throws ConfirmValueError (before anything is sent) for unsupported values. */
export async function payloadDigest(payload: ConfirmPayload): Promise<string> {
  const text = canonicalJson(payload)
  assertConfirmSize(text)
  return `sha256:${await sha256Hex(text)}`
}

/** The bytes of a base64 string (the act's `file.content_base64`), so the digest is of exactly what is sent. */
export function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
