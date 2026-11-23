// The simulator's Ask rules are the host's defaults (hive/config.json, the tree layer hive/core/config.py
// load_settings reads), not a copy that can drift from them (T-215 1a).
import { describe, expect, it } from 'vitest'
import hiveConfig from '../../../../config.json'
import { EXPENSIVE_CEILING_USD, EXPENSIVE_TIMES, GO_AHEAD_WAIT_MS, PAID_KEPT, PAID_NEEDED } from './ask'

describe("the simulator's Ask rules", () => {
  it('equal hive/config.json, in the units the sim counts in', () => {
    expect(GO_AHEAD_WAIT_MS).toBe(hiveConfig.HIVE_ASK_GO_AHEAD_SECONDS * 1000)
    expect(EXPENSIVE_CEILING_USD).toBe(hiveConfig.HIVE_ASK_EXPENSIVE_OVER_USD)
    expect(EXPENSIVE_TIMES).toBe(hiveConfig.HIVE_ASK_EXPENSIVE_TIMES)
    expect(PAID_KEPT).toBe(hiveConfig.HIVE_ASK_EXPENSIVE_MEDIANS)
    expect(PAID_NEEDED).toBe(hiveConfig.HIVE_ASK_EXPENSIVE_FEWEST)
  })

  it('are the defaults the host has always had (a renamed key reads as undefined and fails here)', () => {
    expect([GO_AHEAD_WAIT_MS, EXPENSIVE_CEILING_USD, EXPENSIVE_TIMES, PAID_KEPT, PAID_NEEDED]).toEqual([
      5 * 60_000, 1, 10, 20, 5,
    ])
  })
})
