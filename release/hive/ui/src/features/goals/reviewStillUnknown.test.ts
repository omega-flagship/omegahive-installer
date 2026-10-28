import { it, expect, vi } from 'vitest'
import { SimClient } from '../../api/sim/SimClient'
import { useHive } from '../../store/store'
import { seenOf } from '../../lib/goalDecision'
import { changeGoal } from '../../experiences/still/goalChange'
import sheetsSource from '../../experiences/still/Sheets.tsx?raw'

// Ported from OmegaReview's probe (coordination/receipts-local/omegareview-735d9a9/reviewStillUnknown.test.ts). The
// original read Still's sentence out of Sheets.tsx by regex; Still now words the outcome through goalChange, so the
// probe drives that consumer and also checks Sheets.tsx keeps no "did not take / Nothing changed" sentence. INVENTED DATA.
it('Still must not assure no change when commit happened and re-read fails', async () => {
  vi.stubGlobal('window', { location: { search: '' } })
  const c = new SimClient({ seed: 491, latency: false, autoStart: false, historyDays: 1 })
  try {
    await useHive.getState().init(c)
    const g = Object.values(useHive.getState().goals).find((g) => g.status === 'open')!
    const patch = c.patchGoal.bind(c)
    vi.spyOn(c, 'patchGoal').mockImplementationOnce(async (id, body) => {
      await patch(id, body)
      // a real lost answer (a browser fetch failure); Kimi next22b r2: a plain Error is a programming error, not a loss
      throw new TypeError('Failed to fetch')
    })
    vi.spyOn(c, 'getGoal').mockRejectedValue(Error('read lost'))
    const r = await changeGoal({ id: g.id, to: 'done', seen: seenOf(g), shownAt: 0 }, { at: 10_000 }, () => undefined)
    expect(useHive.getState().goalsUnsure[g.id]).toBe(true)
    expect(r.kind).toBe('sent')
    const text = r.kind === 'sent' ? (r.note?.text ?? '') : ''
    expect(text).not.toContain('Nothing changed')
    expect(text).not.toMatch(/did not take/)
    expect(sheetsSource).not.toMatch(/The hive did not take this change\. Nothing changed\./)
  } finally {
    c.disconnect()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})
