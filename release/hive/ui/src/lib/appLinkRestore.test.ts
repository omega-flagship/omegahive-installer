// The app-link presentation restore (AppFrame, app-ready): a sign-in change during the consent check sends no restoring
// consume and restores nothing; the entry is still burnt once through the client of the sign-in it was saved under.
import { describe, expect, it, vi } from 'vitest'
import { restoreAfterConsent, type RestoreSteps } from './appLinkRestore'

const current = { current: true }
function steps(over: Partial<RestoreSteps> = {}) {
  const s = {
    needsConsent: true,
    ensureEntry: vi.fn(async () => true),
    frame: vi.fn(async () => 'f_1'),
    check: vi.fn(async (_fid: string) => ({ current: true })),
    current: vi.fn(() => current.current),
    consume: vi.fn(async () => ({ current: true })),
    burn: vi.fn(),
    restore: vi.fn(),
    ...over,
  }
  return s
}

describe('restoreAfterConsent', () => {
  it('the normal path: consent, then the restoring consume, then the restore; no burn', async () => {
    current.current = true
    const s = steps()
    await restoreAfterConsent(s)
    expect(s.check).toHaveBeenCalledWith('f_1')
    expect(s.consume).toHaveBeenCalledTimes(1)
    expect(s.restore).toHaveBeenCalledTimes(1)
    expect(s.burn).not.toHaveBeenCalled()
  })

  it('a sign-in change during the consent check: no restoring consume, nothing restored; the entry is burnt once', async () => {
    current.current = true
    const s = steps({ check: vi.fn(async () => { current.current = false; return { current: true } }) })
    await restoreAfterConsent(s)
    expect(s.consume).not.toHaveBeenCalled()
    expect(s.restore).not.toHaveBeenCalled()
    expect(s.burn).toHaveBeenCalledTimes(1)
  })

  it('a sign-in change during the consume: nothing restored, and no second spend', async () => {
    current.current = true
    const s = steps({ consume: vi.fn(async () => { current.current = false; return { current: true } }) })
    await restoreAfterConsent(s)
    expect(s.restore).not.toHaveBeenCalled()
    expect(s.burn).not.toHaveBeenCalled()
  })

  it('refused consent, no frame, no entry, or no way to check: no restoring consume; burnt once', async () => {
    for (const over of [{ check: vi.fn(async () => ({ current: false })) }, { frame: vi.fn(async () => null) }, { ensureEntry: vi.fn(async () => false) }, { check: vi.fn(() => null) }] as Partial<RestoreSteps>[]) {
      current.current = true
      const s = steps(over)
      await restoreAfterConsent(s)
      expect(s.consume).not.toHaveBeenCalled()
      expect(s.burn).toHaveBeenCalledTimes(1)
    }
  })

  it('without a consent step: consume and restore, re-checked after the consume', async () => {
    current.current = true
    const s = steps({ needsConsent: false })
    await restoreAfterConsent(s)
    expect(s.check).not.toHaveBeenCalled()
    expect(s.restore).toHaveBeenCalledTimes(1)
  })

  it('AppFrame wires it: the restoring consume and the burn are the entry’s presentation spend; current() is the document binding', async () => {
    const fsName = 'node:fs'
    const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: URL, e: string) => string }
    const src = fs.readFileSync(new URL('../features/programs/AppFrame.tsx', import.meta.url), 'utf8')
    expect(src).toMatch(/const current = \(\) => !disposed && releaseCurrent && docBinding\.current\(\)/)
    expect(src).toMatch(/consume: \(\) => client\.appLinkPresentation!\(retained\.entryId, true\)/)
    expect(src).toMatch(/burn: \(\) => void client\.appLinkPresentation\?\.\(retained\.entryId, true\)/)
    expect(src).toMatch(/if \(disposed \|\| !releaseCurrent \|\| !docBinding\.current\(\)\) return\n {8}return attachFrame\(livePort\)/)
  })
})
