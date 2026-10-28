import { describe, expect, it } from 'vitest'
import { PLACES } from './world'

/**
 * Town release r2 (stand-in r1 BLOCKING): a released experience never shows, advertises or links to a private app
 * (Atlas, Truth). Town has no place, entrance, room, link, token or art for one; such an app is reached only through the
 * hive's ordinary Apps list where it is installed and permitted, as in every other experience.
 */
const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { readdirSync: (p: string) => string[]; readFileSync: (p: string, e: 'utf8') => string }
const DIR = new URL('.', import.meta.url).pathname
const ASK = new URL('../../features/ask/', import.meta.url).pathname
const PRIVATE = /atlas|truth/i

describe('OmegaTown carries no private app', () => {
  it('no world place is a private app (id, label or words)', () => {
    for (const p of PLACES) expect(`${p.id} ${p.label} ${p.copy}`, p.id).not.toMatch(PRIVATE)
  })
  it("no Town source, style or skin file names one (scene, rooms, links, tokens, art)", () => {
    const files = [
      ...fs.readdirSync(DIR).filter((f) => /\.(tsx?|css)$/.test(f) && !f.endsWith('.test.ts')).map((f) => `${DIR}${f}`),
      `${ASK}townSkin.tsx`, `${ASK}townAsk.css`,
    ]
    expect(files.length).toBeGreaterThanOrEqual(9)
    for (const f of files) expect(fs.readFileSync(f, 'utf8'), f).not.toMatch(PRIVATE)
  })
})
