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

  it('every iframe anywhere in the UI source carries a sandbox without allow-same-origin, allow-popups or top navigation', async () => {
    const bad: string[] = []
    let count = 0
    for (const { file, text } of await sources()) {
      if (/createElement\(\s*['"]iframe['"]/.test(text)) bad.push(`${file}: creates an iframe imperatively`)
      for (const m of text.matchAll(/<iframe\b[\s\S]*?\/?>/g)) {
        count++
        const tag = m[0]
        const sb = /\bsandbox="([^"]*)"/.exec(tag)
        if (!sb) bad.push(`${file}: iframe without a literal sandbox`)
        else if (/allow-same-origin|allow-popups|allow-top-navigation/.test(sb[1])) bad.push(`${file}: sandbox "${sb[1]}"`)
      }
    }
    expect(count).toBeGreaterThanOrEqual(2) // AppFrame + Flow studio
    expect(bad, bad.join('\n')).toEqual([])
  })
})
