import { describe, expect, it } from 'vitest'
import { appDocument, frameCsp, framePrefix, isFrameSender, revisionFrame, subscriptionTarget } from './appFrame'
import { htmlReason, partsReason } from './appFrameParts'

const ch = '12345678-1234-1234-1234-123456789abc'
const files = { 'index.html': '<html lang="en"><head><link rel="stylesheet" href="./style.css"></head><body><script type="module" src="./app.js"></script></body></html>', 'app.js': 'x("</script><script>bad</script>")', 'style.css': '/* </style> */' }

describe('app frame document', () => {
  it('inlines pinned files with no network, forms or base changes', () => {
    const d = appDocument(files, 'https://hive.example.test', ch, ch)
    expect(d.html).toContain('connect-src &#39;none&#39;')
    expect(d.html).toContain('form-action &#39;none&#39;')
    expect(d.html).toContain(`data-app-channel="${ch}"`)
    expect(d.html).not.toContain('</script><script>bad')
  })
  it('rejects bad bindings and unexpected formats', () => {
    expect(() => appDocument(files, 'javascript:alert(1)', ch, ch)).toThrow()
    expect(() => appDocument({ ...files, 'index.html': '<html><body></body></html>' }, 'https://h.test', ch, ch)).toThrow()
  })
  it('accepts only the exact frame on its channel from an opaque origin', () => {
    const win = {} as Window
    expect(isFrameSender({ origin: 'null', source: win, data: { channel: ch } }, win, ch)).toBe(true)
    expect(isFrameSender({ origin: 'https://evil.test', source: win, data: { channel: ch } }, win, ch)).toBe(false)
    expect(isFrameSender({ origin: 'null', source: {} as Window, data: { channel: ch } }, win, ch)).toBe(false)
    expect(isFrameSender({ origin: 'null', source: win, data: { channel: 'other' } }, win, ch)).toBe(false)
  })
})

describe('app frame subscribe bridge (r2.8)', () => {
  it('accepts exactly one artifact id', () => {
    expect(subscriptionTarget('subscribe', { artifact_id: 'art_1' })).toBe('art_1')
    expect(subscriptionTarget('unsubscribe', { artifact_id: 'art_1', swarm_id: 's' })).toBe('art_1')
    expect(subscriptionTarget('subscribe', { artifact_id: 'a', other: 1 })).toBeNull()
    expect(subscriptionTarget('subscribe', { artifact_id: 5 as never })).toBeNull()
    expect(subscriptionTarget('view', { artifact_id: 'a' })).toBeNull()
  })
  it('forwards only that artifact in this swarm, with no body', () => {
    const ev = { type: 'artifact.revision', at: 't', swarm_id: 's1', artifact_id: 'a', revision: 3, digest: 'sha256:x', created_at: 'c', body: 'secret' }
    expect(revisionFrame(ev, 's1', 'a')).toEqual({ type: 'artifact.revision', artifact_id: 'a', revision: 3, digest: 'sha256:x', created_at: 'c' })
    expect(revisionFrame(ev, 's1', 'b')).toBeNull()
    expect(revisionFrame(ev, 's2', 'a')).toBeNull()
    expect(revisionFrame({ ...ev, type: 'room' }, 's1', 'a')).toBeNull()
  })
})

describe('app frame script parts (r17)', () => {
  const parts = ['native-three.js', 'native-three-addons.js', 'app.js']
  const page = (names: string[]) =>
    `<html lang="en"><head><link rel="stylesheet" href="./style.css"></head><body>${names.map((n) => `<script type="module" src="./${n}"></script>`).join('')}</body></html>`
  const bundle = (names: string[], html = page(names)) => {
    const out: Record<string, string> = { 'index.html': html, 'style.css': 'body{}' }
    names.forEach((n, i) => { out[n] = `globalThis.part${i} = "${n}"; x("</script><script>bad${i}</script>")` })
    return out as never
  }
  const N = '87654321-4321-4321-4321-cba987654321'
  const inlined = (html: string) => [...html.matchAll(/<script type="module" nonce="([^"]+)">([\s\S]*?)<\/script>/g)].map((m) => [m[1], m[2]])

  it('inlines one listed part with the nonce, like the single-file case', () => {
    const d = appDocument(bundle(['app.js']), 'https://hive.example.test', ch, N, ['app.js'])
    expect(inlined(d.html)).toEqual([[N, 'globalThis.part0 = "app.js"; x("<\\/script><script>bad0<\\/script>")']])
    expect(d.html).not.toContain('src="./')
  })
  it('inlines three parts in the listed order, each with the same nonce, CSP unchanged', () => {
    const d = appDocument(bundle(parts), 'https://hive.example.test', ch, N, parts)
    const got = inlined(d.html)
    expect(got.map(([n]) => n)).toEqual([N, N, N])
    expect(got.map(([, body]) => body.slice(0, body.indexOf(';')))).toEqual(parts.map((p, i) => `globalThis.part${i} = "${p}"`))
    expect(d.html).toContain(`content="${frameCsp(N).replace(/'/g, '&#39;')}"`)
    expect(d.html.match(/<script type="module"/g)).toHaveLength(3)
    expect(d.html).not.toContain('</script><script>bad')
    expect(d.html).not.toContain('src="./')
  })
  it('writes the CSP ahead of all app markup, in both modes (stand-in r17-50d1dda; behaviour in the browser test)', () => {
    const prefix = `<!doctype html><html data-app-host-origin="https://hive.example.test" data-app-channel="${ch}"><head><meta http-equiv="Content-Security-Policy" content="${frameCsp(N).replace(/'/g, '&#39;')}">`
    expect(framePrefix('https://hive.example.test', ch, N)).toBe(prefix)
    const plain = appDocument(files, 'https://hive.example.test', ch, N)
    // the app's markup follows unchanged except for the inlined stylesheet and script
    expect(plain.html).toBe(prefix + `<html lang="en"><head><style nonce="${N}">/* <\\/style> */</style></head><body><script type="module" nonce="${N}">x("<\\/script><script>bad<\\/script>")</script></body></html>`)
    expect(appDocument(bundle(parts), 'https://hive.example.test', ch, N, parts).html.startsWith(prefix)).toBe(true)
    const hostile = { ...files, 'index.html': '<html><body><select><head><link rel="stylesheet" href="./style.css"></select><script type="module" src="./app.js"></script></body></html>' }
    expect(appDocument(hostile, 'https://hive.example.test', ch, N).html.startsWith(prefix)).toBe(true)
    expect(appDocument({ ...files, 'index.html': '<html><body><link rel="stylesheet" href="./style.css"><script type="module" src="./app.js"></script></body></html>' }, 'https://h.test', ch, N).html.startsWith('<!doctype html>')).toBe(true)   // no <head> needed now
  })
  it('refuses bad lists: empty, more than 3, duplicates, app.js not last, odd names', () => {
    const go = (f: never, s: string[]) => () => appDocument(f, 'https://h.test', ch, N, s)
    expect(go(bundle(['app.js']), [])).toThrow(/1 to 3/)
    expect(go(bundle(['a.js', 'b.js', 'c.js', 'app.js']), ['a.js', 'b.js', 'c.js', 'app.js'])).toThrow(/1 to 3/)
    expect(go(bundle(['app.js']), ['app.js', 'app.js'])).toThrow(/twice/)
    expect(go(bundle(['app.js', 'native-three.js']), ['app.js', 'native-three.js'])).toThrow(/app.js is the last of scripts/)
    expect(go(bundle(['app.js']), ['../x.js', 'app.js'])).toThrow(/1 to 3/)
    expect(go(bundle(['app.js']), ['style.css', 'app.js'])).toThrow(/1 to 3/)
  })
  it('refuses missing or unlisted files', () => {
    const f = bundle(parts) as Record<string, string>
    const { 'native-three.js': _gone, ...missing } = f
    expect(() => appDocument(missing as never, 'https://h.test', ch, N, parts)).toThrow(/native-three.js is missing/)
    expect(() => appDocument({ ...f, 'other.js': 'x' } as never, 'https://h.test', ch, N, parts)).toThrow(/unlisted file other.js/)
  })
  it('refuses wrong order, missing, duplicate and unlisted tags', () => {
    const go = (html: string) => () => appDocument(bundle(parts, html), 'https://h.test', ch, N, parts)
    expect(go(page(['native-three-addons.js', 'native-three.js', 'app.js']))).toThrow(/out of their listed order/)
    expect(go(page(['native-three.js', 'app.js']))).toThrow(/exactly one <script type="module" src=".\/native-three-addons.js">/)
    expect(go(page(['native-three.js', 'native-three.js', 'native-three-addons.js', 'app.js']))).toThrow(/exactly one <script type="module" src=".\/native-three.js">/)
    expect(go(page([...parts]).replace('</body>', '<SCRIPT>evil()</SCRIPT></body>'))).toThrow(/script tag for an unlisted file/)
  })
  it('enforces the byte limits itself, in UTF-8 bytes (Kimi 5, stand-in 1)', () => {
    const go = (patch: Record<string, string>) => () => appDocument({ ...(bundle(parts) as Record<string, string>), ...patch } as never, 'https://h.test', ch, N, parts)
    expect(go({ 'native-three.js': 'x'.repeat(600_000) })).not.toThrow()
    expect(go({ 'native-three.js': 'x'.repeat(600_001) })).toThrow(/native-three.js is over 600000 bytes/)
    expect(go({ 'native-three.js': '\u00e9'.repeat(300_001) })).toThrow(/over 600000 bytes/)          // 600,002 bytes, 300,001 chars
    expect(go({ 'native-three.js': 'x'.repeat(600_000), 'native-three-addons.js': 'x'.repeat(600_000), 'app.js': 'x'.repeat(600_000) }))
      .toThrow(/over 1800000 bytes in all/)
    expect(go({ 'style.css': 'x'.repeat(600_001) })).toThrow(/style.css is over/)
  })
  it('validates the server\'s scripts list before inlining anything', () => {
    const go = (s: unknown) => () => appDocument(bundle(parts), 'https://h.test', ch, N, s as string[])
    for (const bad of [null, 'app.js', [], [1, 'app.js'], ['a.b.js', 'app.js'], ['app.min.js'], ['app.js\n']]) expect(go(bad)).toThrow(/1 to 3 plain .js/)
  })
  it('refuses part tags a browser would never run (stand-in 3)', () => {
    const go = (html: string) => () => appDocument(bundle(parts, html), 'https://h.test', ch, N, parts)
    expect(go(page(parts).replace('<body>', '<body><!--').replace('</body>', '--></body>'))).toThrow(/ends with the part tags/)
    expect(go(page(parts).replace('<body>', '<body><!-- x -->'))).toThrow(/comment before the part tags/)
    expect(go(page(parts).replace('<body>', '<body><div title="'))).toThrow(/unclosed <div> tag/)
    expect(go(page(parts).replace('<body>', '<body><template>'))).toThrow(/<template> before/)
  })
  it('refuses <!-- inside a part, which would change where its inlined script ends', () => {
    const f = { ...(bundle(parts) as Record<string, string>), 'native-three.js': 'const s = "<!--<script>"' }
    expect(() => appDocument(f as never, 'https://h.test', ch, N, parts)).toThrow(/native-three.js contains <!--/)
  })
  it('agrees with the host on every shared case (tests/fixtures/ui_parts_cases.json)', async () => {
    const fsName = 'node:fs'
    const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: URL, e: string) => string }
    const cases = JSON.parse(fs.readFileSync(new URL('../../../tests/fixtures/ui_parts_cases.json', import.meta.url), 'utf8')) as
      { html: { name: string; scripts: string[]; html: string; reason: string | null }[]; names: Record<string, boolean> }
    for (const c of cases.html) expect([c.name, htmlReason(c.html, c.scripts)]).toEqual([c.name, c.reason])
    for (const [name, ok] of Object.entries(cases.names)) {
      const scripts = name === 'app.js' ? ['app.js'] : [name, 'app.js']
      const files = Object.fromEntries(['index.html', 'style.css', ...scripts].map((n) => [n, '']))
      expect([name, !/^scripts lists/.test(partsReason(files, scripts) ?? '')]).toEqual([name, ok])
    }
    expect(cases.html.length).toBeGreaterThan(20)
  })
})
