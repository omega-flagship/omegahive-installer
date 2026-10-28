import { describe, expect, it } from 'vitest'
import { assertIntegerTokens, byCodePoint, canonicalJson, canonicalJsonText, CONFIRM_MAX_BYTES, ConfirmTooLargeError, ConfirmValueError, confirmPayload, payloadDigest, quote, sha256Hex, wireOf } from './confirmDigest'

// §9d payload digest parity with the hive (Python json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)).
// 1. Platform's shared vectors, vendored UNCHANGED from platform/confirm-token ced0564:
//    hive/tests/fixtures/confirm_digest_vectors.json, sha256 7600dadcae8462118be7d774db5410c34a8fbc49c1423878afe6ed83495996cb
// 2. Surface's supplementary Python-computed vectors (receipts/confirm-token/make_vectors.py), INVENTED payloads.
// 3. When python3 is on PATH, a live cross-check of more payloads through Python itself.

async function node() {
  const fsName = 'node:fs'
  const cpName = 'node:child_process'
  const cryptoName = 'node:crypto'
  const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string | URL, e?: string) => string | Uint8Array }
  const cp = (await import(/* @vite-ignore */ cpName)) as { spawnSync: (cmd: string, args: string[], o: object) => { status: number | null; stdout: string; error?: Error } }
  const nodeCrypto = (await import(/* @vite-ignore */ cryptoName)) as { createHash: (a: string) => { update: (b: Uint8Array) => { digest: (e: string) => string } } }
  return { fs, cp, nodeCrypto }
}

const PLATFORM_SHA = '7600dadcae8462118be7d774db5410c34a8fbc49c1423878afe6ed83495996cb'

interface Vectors {
  vectors: { name: string; payload: unknown; canonical: string; digest: string }[]
  refused?: { name: string; payload_json: string }[]
}

describe('Platform shared vectors (ced0564), byte for byte', () => {
  it('the vendored file is the pinned one, unchanged', async () => {
    const { fs, nodeCrypto } = await node()
    const bytes = fs.readFileSync(new URL('./fixtures/confirm_digest_vectors.json', import.meta.url)) as Uint8Array
    expect(nodeCrypto.createHash('sha256').update(bytes).digest('hex')).toBe(PLATFORM_SHA)
  })

  it('all 11 accepted payloads: the same canonical text and digest as the hive', async () => {
    const { fs } = await node()
    const v = JSON.parse(fs.readFileSync(new URL('./fixtures/confirm_digest_vectors.json', import.meta.url), 'utf8') as string) as Vectors
    expect(v.vectors).toHaveLength(11)
    for (const x of v.vectors) {
      expect(canonicalJson(x.payload), x.name).toBe(x.canonical)
      expect(await payloadDigest(x.payload as never), x.name).toBe(x.digest)
      // and as the host builds it: through the wire once
      expect(canonicalJsonText(JSON.stringify(x.payload)), x.name).toBe(x.canonical)
    }
  })

  it('all 9 refused payloads are refused before anything is sent', async () => {
    const { fs } = await node()
    const v = JSON.parse(fs.readFileSync(new URL('./fixtures/confirm_digest_vectors.json', import.meta.url), 'utf8') as string) as Vectors
    expect(v.refused).toHaveLength(9)
    for (const x of v.refused!) expect(() => canonicalJsonText(x.payload_json), x.name).toThrow(ConfirmValueError)
  })
})

describe('Surface supplementary Python vectors', () => {
  it('every payload: canonical text and digest equal Python’s', async () => {
    const { fs } = await node()
    const v = JSON.parse(fs.readFileSync(new URL('./fixtures/confirm_digest_vectors.python.json', import.meta.url), 'utf8') as string) as Vectors & { file_bytes_utf8: string }
    expect(v.vectors.length).toBeGreaterThanOrEqual(10)
    for (const x of v.vectors) {
      expect(canonicalJson(x.payload), x.name).toBe(x.canonical)
      expect(await payloadDigest(x.payload as never), x.name).toBe(x.digest)
    }
    // the file entry's sha256 is of the bytes as sent
    const file = v.vectors.find((x) => x.name === 'file')!.payload as { file: { sha256: string } }
    expect(`sha256:${await sha256Hex(new TextEncoder().encode(v.file_bytes_utf8))}`).toBe(file.file.sha256)
  })
})

describe('live cross-check through python3 (skipped when python3 is absent)', () => {
  it('canonical text is byte-identical to Python for unicode, nested keys, escapes and integer bounds', async () => {
    const { cp } = await node()
    const payloads = [
      confirmPayload({ items: ['ä', '😀'], params: { 'ｚ': 1, '𝔸': 2, 'a': { 'é': [true, null, -9007199254740991] }, ' ': 'x y' }, base_revision: 'r-ü' }),
      confirmPayload({ items: [], params: { deep: { c: { b: { a: [1, [2, [3]]] } } }, s: '\u0000\u0007\b\f\n\r\t"\\/\u007f' } }),
      confirmPayload({}, { name: 'résumé (draft).txt', mime: 'text/plain', size: 12, sha256: 'sha256:' + '0'.repeat(64) }),
      confirmPayload({ items: ['x'], params: { emoji: '👩‍👩‍👧', cjk: '漢字かなカナ', rtl: 'שלום', keys: { '￿': 0, '\u{10000}': 1, 'Z': 2 } }, base_revision: null }),
    ]
    const script = 'import json,sys\nfor line in sys.stdin:\n    print(json.dumps(json.loads(line), sort_keys=True, separators=(",", ":"), ensure_ascii=False))'
    const r = cp.spawnSync('python3', ['-c', script], { input: payloads.map((p) => JSON.stringify(p)).join('\n') + '\n', encoding: 'utf8' })
    const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
    if (r.error || r.status !== 0) {
      if (env.CONFIRM_REQUIRE_PYTHON) throw new Error(`python3 unavailable: ${r.error?.message ?? r.status}`)
      return   // no python3 here: the vendored vectors above are the proof
    }
    const lines = r.stdout.trimEnd().split('\n')
    expect(lines).toHaveLength(payloads.length)
    payloads.forEach((p, i) => expect(canonicalJson(wireOf(p))).toBe(lines[i]))
  })
})

describe('the string writer (§9d escape set, our own, not JSON.stringify)', () => {
  it('escapes exactly " \\ \\b \\f \\n \\r \\t; other C0 as lowercase \\u00xx; / and U+007F and non-ASCII as they are', () => {
    expect(quote('a"b\\c')).toBe('"a\\"b\\\\c"')
    expect(quote('\b\f\n\r\t')).toBe('"\\b\\f\\n\\r\\t"')
    expect(quote('\u0000\u0007\u000b\u001f')).toBe('"\\u0000\\u0007\\u000b\\u001f"')
    expect(quote('a/b\u007f é 日本 😀 \u2028')).toBe('"a/b\u007f é 日本 😀 \u2028"')
    // every BMP code unit below U+0080, against the escape table written out by hand
    for (let c = 0; c < 0x80; c++) {
      const ch = String.fromCharCode(c)
      const short: Record<number, string> = { 8: '\\b', 9: '\\t', 10: '\\n', 12: '\\f', 13: '\\r', 34: '\\"', 92: '\\\\' }
      const want = short[c] ?? (c < 0x20 ? `\\u${c.toString(16).padStart(4, '0')}` : ch)
      expect(quote(ch), `U+${c.toString(16)}`).toBe(`"${want}"`)
    }
  })
})

describe('the 2 MiB limit (§9d, ced0564): canonical payload, file bytes excluded', () => {
  it('refuses over 2 MiB of canonical UTF-8, accepts at the limit', async () => {
    const pad = (n: number) => confirmPayload({ params: { s: 'x'.repeat(n) } })
    const overhead = new TextEncoder().encode(canonicalJson(pad(0))).byteLength
    await expect(payloadDigest(pad(CONFIRM_MAX_BYTES - overhead))).resolves.toMatch(/^sha256:/)
    await expect(payloadDigest(pad(CONFIRM_MAX_BYTES - overhead + 1))).rejects.toBeInstanceOf(ConfirmTooLargeError)
    // UTF-8 bytes, not characters: 'é' is two bytes
    await expect(payloadDigest(confirmPayload({ params: { s: 'é'.repeat(CONFIRM_MAX_BYTES / 2) } }))).rejects.toBeInstanceOf(ConfirmTooLargeError)
  })
})

describe('the number domain and other refusals (client side, before any call)', () => {
  it('only integers with |n| ≤ 2^53−1; no decimals, −0, NaN, Infinity; no lone surrogates', () => {
    for (const bad of [1.5, 0.1, 1e-7, 2 ** 53, -(2 ** 53), Number.NaN, Number.POSITIVE_INFINITY, -0]) expect(() => canonicalJson({ x: bad })).toThrow(ConfirmValueError)
    for (const ok of [0, 1, -1, 2 ** 53 - 1, -(2 ** 53 - 1)]) expect(canonicalJson({ x: ok })).toBe(`{"x":${ok}}`)
    expect(() => canonicalJson({ x: '\ud800' })).toThrow(ConfirmValueError)
    expect(() => canonicalJson({ '\udc00': 1 })).toThrow(ConfirmValueError)
    expect(canonicalJson({ x: '😀' })).toBe('{"x":"😀"}')
    expect(() => canonicalJson({ x: undefined })).toThrow(ConfirmValueError)
    expect(() => canonicalJson(new Date(0))).toThrow(ConfirmValueError)
  })
  it('the wire text is checked too: 1.0 and exponents are refused even though JS reads them as integers', () => {
    expect(() => assertIntegerTokens('{"x":1.0}')).toThrow(ConfirmValueError)
    expect(() => assertIntegerTokens('{"x":1e3}')).toThrow(ConfirmValueError)
    expect(() => assertIntegerTokens('{"x":"1.5 inside a string is text","y":-3}')).not.toThrow()
    expect(() => assertIntegerTokens('{"x":"esc \\" 2.5","y":[0,-0]}')).not.toThrow()   // -0 as a token is the integer 0 to both sides
    expect(() => wireOf({ x: 1.5 })).toThrow(ConfirmValueError)
  })
  it('keys sort by code point (Python), not by UTF-16 unit (JS default)', () => {
    const keys = ['￿', '\u{10000}', 'a', 'Z', '！']
    expect([...keys].sort(byCodePoint)).toEqual(['Z', 'a', '！', '￿', '\u{10000}'])
    expect([...keys].sort()).not.toEqual([...keys].sort(byCodePoint))   // the default would be wrong here
  })
  it('the payload is normalised as the hive does: missing items [], params {}, base_revision null', () => {
    expect(confirmPayload({})).toEqual({ items: [], params: {}, base_revision: null })
    expect(confirmPayload({ items: [], params: {}, base_revision: 'r1' })).toEqual({ items: [], params: {}, base_revision: 'r1' })
    expect(Object.keys(confirmPayload({}, { name: 'a', mime: 'text/plain', size: 1, sha256: 'sha256:x' }))).toContain('file')
  })
})
