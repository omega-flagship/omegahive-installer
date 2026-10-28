// The vendored MeTTa is the hive's own, byte for byte (metta/PIN.json), and this package makes no network request.
import { describe, expect, it } from 'vitest'
import { sha256 } from '../askMemory/hash'
import pin from './metta/PIN.json'
import { MIND_SOURCES } from './sources'

const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as {
  existsSync: (p: string | URL) => boolean
  readFileSync: (p: string | URL, e: string) => string
  readdirSync: (p: string | URL) => string[]
}
const bytesHash = (text: string) => sha256(text) // sha256 of the UTF-8 bytes, as shasum -a 256

describe('pins', () => {
  it('every vendored file matches its sha256', () => {
    const src = new Map(MIND_SOURCES)
    for (const [file, p] of Object.entries(pin.files)) {
      expect(bytesHash(src.get(file.replace('.metta', ''))!), file).toBe(p.sha256)
    }
  })

  it('and matches the release it came from, when that checkout is on this machine', () => {
    const release = new URL('../../../../../', import.meta.url)
    for (const [file, p] of Object.entries(pin.files)) {
      const at = new URL(p.from, release)
      if (!fs.existsSync(at)) continue
      expect(bytesHash(fs.readFileSync(at, 'utf8')), `${file} vs ${p.from}`).toBe(p.sha256)
    }
  })
})

describe('no network', () => {
  it('nothing here (or in the engine) can make a request', () => {
    const here = new URL('./', import.meta.url)
    const own = fs.readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    const banned = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\b/
    for (const f of own) expect(banned.test(fs.readFileSync(new URL(f, here), 'utf8')), f).toBe(false)
    for (const pkg of ['core', 'hyperon']) {
      const dist = new URL(`../../../node_modules/@mettascript/${pkg}/dist/`, import.meta.url)
      for (const f of fs.readdirSync(dist).filter((x) => x.endsWith('.js'))) {
        expect(/\bfetch\s*\(|XMLHttpRequest|new WebSocket/.test(fs.readFileSync(new URL(f, dist), 'utf8')), `${pkg}/${f}`).toBe(false)
      }
    }
  })
})
