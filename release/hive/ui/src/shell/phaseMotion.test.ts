import { afterEach, describe, expect, it } from 'vitest'
import { MotionGlobalConfig } from 'framer-motion'
import { holdPhaseMotion } from './phaseMotion'

afterEach(() => { delete MotionGlobalConfig.skipAnimations })

describe('the shell owns the hidden Pro motion policy', () => {
  it('does not restore motion while another host still holds it', () => {
    const first = holdPhaseMotion(), second = holdPhaseMotion()
    expect(MotionGlobalConfig.skipAnimations).toBe(true)
    first(); first()
    expect(MotionGlobalConfig.skipAnimations).toBe(true)
    second()
    expect(MotionGlobalConfig.skipAnimations).toBeUndefined()
  })
  it('restores the pre-existing enabled or disabled policy exactly', () => {
    for (const policy of [false, true]) {
      MotionGlobalConfig.skipAnimations = policy
      const release = holdPhaseMotion()
      expect(MotionGlobalConfig.skipAnimations).toBe(true)
      release()
      expect(MotionGlobalConfig.skipAnimations).toBe(policy)
    }
  })
})

it('preserves an external mid-hold policy across release then acquire', () => {
  const release = holdPhaseMotion()
  MotionGlobalConfig.skipAnimations = false
  release()
  expect(MotionGlobalConfig.skipAnimations).toBe(false)
  const again = holdPhaseMotion()
  again()
  expect(MotionGlobalConfig.skipAnimations).toBe(false)
})

it('keeps another owner frozen while retaining a changed external policy for final release', () => {
  const first = holdPhaseMotion(), second = holdPhaseMotion()
  try {
    MotionGlobalConfig.skipAnimations = false
    first()
    expect(MotionGlobalConfig.skipAnimations).toBe(true)
  } finally { first(); second() }
  expect(MotionGlobalConfig.skipAnimations).toBe(false)
})
