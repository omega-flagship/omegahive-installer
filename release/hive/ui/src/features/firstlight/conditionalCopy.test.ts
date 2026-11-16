import { describe, expect, it } from 'vitest'
import { outboundCopy, profileSaveCopy, spendingCopy, unknownChargeCopy, unknownRetryCopy, type ProfileSaveState } from './conditionalCopy'
import type { MonthlyLimit } from './host'

const blank = (): ProfileSaveState => ({ name: 'not_sent', purpose: 'not_sent', preferences: 'not_sent', priorLimitSaved: false })
const limit: MonthlyLimit = { done: false, enforced: false, enforced_by: null, limit_usd: null, spent_usd: 0, chosen_usd: null, host_name: null, pending_request: null }

describe('R1.1 conditional copy uses only observed evidence', () => {
  it('distinguishes proposed, saved-unconfirmed, read-back enforced and unknown limits without inventing no-enforcement capability', () => {
    expect(spendingCopy(limit, 5, null)).toBe('Proposed limit: $5 a month. It starts when you save.')
    expect(spendingCopy(limit, 5, 9)).toBe("We couldn't confirm a spending limit here.")
    expect(spendingCopy(limit, 5, 9, true)).toBe('Checking your limit…')
    expect(spendingCopy({ ...limit, enforced: true, enforced_by: 'own', limit_usd: 0 }, 5, null)).toBe('Your minds may spend up to $0 a month.')
    expect(spendingCopy({ ...limit, enforced: true, enforced_by: 'own', limit_usd: 5 }, 9, null, false, true)).toBe("We couldn't confirm a spending limit here.")
    expect(spendingCopy(null, null, null)).toBe("We couldn't confirm a spending limit here.")
    expect(spendingCopy(limit, null, null)).not.toContain("can't enforce")
  })

  it('retained pending/chosen amounts and an old enforced value cannot imply a request is in flight', () => {
    const stale = { ...limit, chosen_usd: 9 }
    expect(spendingCopy(stale, null, 9)).toBe("We couldn't confirm a spending limit here.")
    expect(spendingCopy(stale, 9, null)).toBe('Proposed limit: $9 a month. It starts when you save.')
    expect(spendingCopy({ ...stale, enforced: true, limit_usd: 5 }, 9, 9)).toBe("We couldn't confirm a spending limit here.")
    expect(spendingCopy({ ...stale, enforced: true, limit_usd: 5 }, 9, null, true)).toBe('Checking your limit…')
    for (const words of [spendingCopy(stale, null, 9), spendingCopy(null, null, null)]) {
      expect(words).not.toContain('Checking')
      expect(words).not.toContain("can't enforce")
      expect(words).not.toContain('unlimited')
    }
  })

  it('says Saved only for every requested field acknowledgement, preserving an intentionally unchanged purpose', () => {
    expect(profileSaveCopy({ ...blank(), name: 'saved', purpose: 'saved', preferences: 'saved' })).toBe('Saved.')
    expect(profileSaveCopy({ ...blank(), name: 'saved', purpose: 'unchanged', preferences: 'saved' })).toBe('Saved.')
    expect(profileSaveCopy({ ...blank(), name: 'saved', purpose: 'saved', preferences: 'unknown' })).not.toBe('Saved.')
  })

  it('Nothing changed requires no send and no earlier limit write', () => {
    expect(profileSaveCopy(blank())).toBe("Couldn't save just now. Nothing changed.")
    expect(profileSaveCopy({ ...blank(), priorLimitSaved: true })).not.toContain('Nothing changed')
    expect(profileSaveCopy({ ...blank(), name: 'unknown' })).not.toContain('Nothing changed')
  })

  it('names saved and unsent fields while a sent request with no acknowledgement stays unknown, never falsely not-saved', () => {
    const copy = profileSaveCopy({ ...blank(), name: 'saved', purpose: 'unknown' })
    expect(copy).toContain("name was saved")
    expect(copy).toContain("couldn't confirm what saved for purpose")
    expect(copy).toContain("preferences weren't sent")
    expect(copy).not.toContain("purpose wasn't")
    expect(copy).not.toContain('Nothing changed')
  })

  it('without a charge receipt only the unknown charge text and manual credit warning exist', () => {
    expect(unknownChargeCopy('Wren')).toBe("Wren couldn't finish waking. We couldn't confirm whether this was charged.")
    expect(unknownRetryCopy).toBe('Try again: this may use credit')
    expect(unknownChargeCopy('Wren')).not.toContain('Nothing was charged')
  })

  it('no current outbound-policy field means no universal approval promise', () => {
    expect(outboundCopy).toBe("The outbound-approval policy could not be confirmed here")
    expect(outboundCopy).not.toContain('asks you before anything leaves')
  })
})
