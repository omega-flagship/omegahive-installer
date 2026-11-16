// Purpose: check that no two modules or folders in one folder of src/ differ only in case, as one import names them.
import { describe, expect, it } from 'vitest'

/**
 * macOS's disk is case-insensitive, and an import names a module without its extension, so ../minds/BeliefLink found
 * beliefLink.ts before BeliefLink.tsx there and every Mac build failed (TS2459), while Linux CI and a PC passed. Two
 * entries clash when their names match ignoring case once a module extension is taken off: a file and another file,
 * or a file and a folder its index would stand for.
 */
const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as {
  readdirSync: (p: string | URL, o: { withFileTypes: true }) => { name: string; isDirectory: () => boolean }[]
}

/** The extensions an import leaves off (TypeScript's and Vite's resolution), longest first so .d.ts goes whole. */
const MODULE_EXT = /\.(d\.ts|tsx|ts|jsx|js|mjs|cjs|mts|cts|json)$/i

/** Each folder's clashes under src/, as "folder: name, name". Time: one readdir per folder under src/. */
function clashes(dir: URL, rel: string): string[] {
  const byKey = new Map<string, string[]>()
  const found: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const key = (entry.isDirectory() ? entry.name : entry.name.replace(MODULE_EXT, '')).toLowerCase()
    byKey.set(key, [...(byKey.get(key) ?? []), entry.name])
    if (entry.isDirectory()) found.push(...clashes(new URL(`${entry.name}/`, dir), `${rel}${entry.name}/`))
  }
  for (const names of byKey.values()) if (names.length > 1) found.push(`${rel || './'}: ${names.sort().join(', ')}`)
  return found
}

describe('module names under src/', () => {
  it('no two in one folder differ only in case, so every import resolves alike on a case-insensitive disk', () => {
    expect(clashes(new URL('./', import.meta.url), '')).toEqual([])
  })
  it('the rule sees the clash that broke the Mac build', () => {
    const key = (name: string) => name.replace(MODULE_EXT, '').toLowerCase()
    expect(key('beliefLink.ts')).toBe(key('BeliefLink.tsx'))
    expect(key('beliefLink.test.ts')).not.toBe(key('BeliefLink.mounted.test.ts'))
    expect(key('types.d.ts')).toBe(key('Types.ts'))
  })
})
