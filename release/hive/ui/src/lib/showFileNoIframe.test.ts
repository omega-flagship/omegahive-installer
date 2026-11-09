import { describe, expect, it, vi } from 'vitest'
import { DOWNLOAD_BLOB_TYPE, viewerBlob, viewerPlan } from './frameOps'

// Review I1 (2026-10-05): in real Brave a link inside the unsandboxed PDF iframe navigated the whole host tab. Ruling:
// no inline PDF; PDF is download-only; no show-file path creates an iframe; every iframe in the UI is sandboxed.

const PDF = new TextEncoder().encode('%PDF-1.7\n%invented\n').buffer as ArrayBuffer

async function source(rel: string): Promise<string> {
  const fsName = 'node:fs'
  const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string | URL, e: string) => string }
  return fs.readFileSync(new URL(rel, import.meta.url), 'utf8')
}

async function sources(): Promise<{ file: string; text: string }[]> {
  const fsName = 'node:fs'
  const fs = (await import(/* @vite-ignore */ fsName)) as { readdirSync: (p: URL, o: { recursive: true }) => string[]; readFileSync: (p: URL, e: string) => string }
  const root = new URL('../', import.meta.url)
  return fs.readdirSync(root, { recursive: true })
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => ({ file: f, text: fs.readFileSync(new URL(f, root), 'utf8') }))
}

describe('Review I1: show-file never renders a PDF and never creates an iframe', () => {
  it('the plan for a PDF is download-only, for text the escaped text view; neither uses an iframe', () => {
    expect(viewerPlan('pdf')).toEqual({ show: 'download-only', iframe: false })
    expect(viewerPlan('text')).toEqual({ show: 'text', iframe: false })
  })

  it('download blobs are opaque bytes (never application/pdf or text/html), whatever the app declared', () => {
    const made: Blob[] = []
    const create = vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => { made.push(b as Blob); return 'blob:invented' })
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    viewerBlob(PDF, 'application/pdf').close()
    viewerBlob(new TextEncoder().encode('x').buffer as ArrayBuffer, 'text/plain').close()
    expect(made.map((b) => b.type)).toEqual([DOWNLOAD_BLOB_TYPE, DOWNLOAD_BLOB_TYPE])
    expect(DOWNLOAD_BLOB_TYPE).toBe('application/octet-stream')
    create.mockRestore()
    revoke.mockRestore()
  })

  it('the host viewer source has no iframe at all', async () => {
    const viewer = await source('../features/programs/FrameOpsDialogs.tsx')
    expect(viewer).not.toMatch(/<iframe\b/)
    expect(viewer).not.toMatch(/createElement\(\s*['"]iframe['"]/)
  })

  /**
   * Each `<iframe …>` opening tag whole: up to the `>` that closes it, outside any `{…}` expression or quoted string, so
   * an attribute's arrow function (`onLoad={() => …}`) doesn't end the tag early and hide a later sandbox.
   */
  const iframeTags = (text: string): string[] => {
    const out: string[] = []
    for (const m of text.matchAll(/<iframe\b/g)) {
      let depth = 0
      let quote = ''
      let i = m.index! + m[0].length
      for (; i < text.length; i++) {
        const ch = text[i]
        if (quote) {
          if (ch === quote && text[i - 1] !== '\\') quote = ''
        } else if (ch === '"' || ch === "'" || ch === '`') quote = ch
        else if (ch === '{') depth++
        else if (ch === '}') depth--
        else if (ch === '>' && depth === 0) break
      }
      out.push(text.slice(m.index, i + 1))
    }
    return out
  }

  it('the tag reader takes the whole opening tag, past arrow functions in attributes', () => {
    const tags = iframeTags('<iframe onLoad={() => go(a > b)} title="x" sandbox="allow-scripts" />\n<iframe src="s">')
    expect(tags.map((t) => /\bsandbox="([^"]*)"/.exec(t)?.[1] ?? null)).toEqual(['allow-scripts', null])
  })

  /**
   * The one imperative iframe allowed (Codex's browser Ask route 7948bb49): the browser Iter's sibling frame. It is
   * always another origin than the page (iterSiblingOrigin refuses the page's own origin, credentials, paths and plain
   * http off loopback), so its allow-same-origin keeps only the sibling's own storage and workers; it never reaches
   * the hive's. Pinned below: its exact sandbox, and the origin rule, run.
   */
  const IMPERATIVE_OK = new Set(['features/browserIter/frameBridge.ts'])
  it('the browser Iter sibling frame: exactly that sandbox, and never the page’s own origin', async () => {
    const src = (await sources()).find((f) => f.file === 'features/browserIter/frameBridge.ts')!.text
    expect(src.match(/createElement\(\s*['"]iframe['"]\)/g)).toHaveLength(1)
    expect(src).toMatch(/frame\.setAttribute\('sandbox', 'allow-scripts allow-same-origin'\)/)
    expect(src).toMatch(/const origin = iterSiblingOrigin\(page\.location\.href, opts\.origin\)\n\s*if \(!origin/)
    const { iterSiblingOrigin } = await import('../features/browserIter/siblingOrigin')
    expect(iterSiblingOrigin('https://hive.example/app', 'https://hive.example/')).toBeNull()   // the page's own origin: refused
    expect(iterSiblingOrigin('http://localhost:5173/', 'http://localhost:5173/')).toBeNull()
    expect(iterSiblingOrigin('http://iter.localhost:5173/', undefined)).toBeNull()              // a page on the sibling host
    expect(iterSiblingOrigin('https://hive.example/', undefined)).toBeNull()                   // no public-host guess
    expect(iterSiblingOrigin('https://hive.example/', 'http://mind.example/')).toBeNull()       // not https off loopback
    expect(iterSiblingOrigin('https://hive.example/', 'https://mind.example/')).toBe('https://mind.example')
  })

  it('every iframe anywhere in the UI source carries a sandbox without allow-same-origin, allow-popups or top navigation', async () => {
    const bad: string[] = []
    let count = 0
    for (const { file, text } of await sources()) {
      if (/createElement\(\s*['"]iframe['"]/.test(text) && !IMPERATIVE_OK.has(file)) bad.push(`${file}: creates an iframe imperatively`)
      for (const tag of iframeTags(text)) {
        count++
        const sb = /\bsandbox="([^"]*)"/.exec(tag)
        if (!sb) bad.push(`${file}: iframe without a literal sandbox`)
        else if (/allow-same-origin|allow-popups|allow-top-navigation/.test(sb[1])) bad.push(`${file}: sandbox "${sb[1]}"`)
      }
    }
    expect(count).toBeGreaterThanOrEqual(2) // AppFrame + Flow studio
    expect(bad, bad.join('\n')).toEqual([])
  })
})
