import { describe, expect, it } from 'vitest'
import mettaSource from './theme.metta?raw'
import { checkLook } from './themeCheck'
import rules from './theme.rules.json'
import seeds from '../shell/uiVariants.seed.json'
import { blockedReason, DEFAULT_VARIANT } from '../shell/uiVariant'

/**
 * The theme's rules: theme.metta decides (run through PeTTa into theme.rules.json, so CI needs no PeTTa), the browser
 * measures and repairs (themeCheck.ts), and the host holds stored looks to the same file (hive/core/theme_rules.py).
 */
describe("the theme's rules (theme.metta via PeTTa)", () => {
  it('theme.rules.json is generated from the current theme.metta (re-run scripts/gen-theme-rules.py after editing it)', () => {
    // every rule is pinned: roles, surfaces, floors, repair policy, derived tokens and give-up-after. The checks are the
    // same join as theme.metta's checks-for (role → kind → against × floor × repair), done here over the facts.
    const src = mettaSource as string
    const facts = (head: string) => [...src.matchAll(new RegExp(`^\\(${head} (\\S+) ([^\\s)]+)\\)`, 'gm'))].map((m) => [m[1], m[2]] as [string, string])
    const roles = Object.fromEntries(facts('role')), floors = Object.fromEntries(facts('floor')), repairs = Object.fromEntries(facts('repair'))
    const checks = facts('role').flatMap(([token, kind]) => facts('against').filter(([k]) => k === kind).map(([, against]) => ({ token, against, floor: Number(floors[kind]), repair: repairs[kind] })))
    const r = rules as { roles: Record<string, string>; checks: unknown[]; derive: Record<string, string>; giveUpAfter: number }
    expect(r.roles).toEqual(roles)
    expect(r.checks).toEqual(checks)
    expect(r.derive).toEqual(Object.fromEntries(facts('derive')))
    expect(r.giveUpAfter).toBe(Number(src.match(/^\(give-up-after ([\d.]+)\)/m)?.[1]))
  })
  it('every built-in look can be read without repair', () => {
    for (const v of [DEFAULT_VARIANT, ...(seeds as typeof DEFAULT_VARIANT[])]) {
      const r = checkLook(v.colors)
      expect({ id: v.id, failures: r.failures, repaired: r.repaired }).toEqual({ id: v.id, failures: [], repaired: [] })
    }
  })
  it("a person's look that falls a little short is repaired; one that can't be read is refused with the reason", () => {
    const near = checkLook({ ...DEFAULT_VARIANT.colors, ink: '#5a5a72' })                       // ink too dim on void (3.05:1, needs 4.5:1)
    expect(near.failures).toEqual([])
    expect(near.repaired.map((r) => r.token)).toEqual(['ink'])
    const faint = checkLook({ ...DEFAULT_VARIANT.colors, void: '#ffffff', abyss: '#f4f4f4', 'ink-2': '#eeeeee' })
    expect(faint.failures.length).toBeGreaterThan(0)
  })
  it('a colour the rules read that is missing, null or not solid fails closed, never skipped', () => {
    const nul = checkLook({ ...DEFAULT_VARIANT.colors, ink: null as unknown as string })
    expect(nul.failures.some((f) => f.token === 'ink' && f.ratio === null)).toBe(true)
    const grounds = checkLook({ ...DEFAULT_VARIANT.colors, ink: '#000000', void: null as unknown as string, abyss: null as unknown as string })
    expect(grounds.failures.length).toBeGreaterThan(0)
    expect(blockedReason({ ...DEFAULT_VARIANT, colors: { ...DEFAULT_VARIANT.colors, ink: null as unknown as string } })).toMatch(/ink/)
  })
  it('the floor is decided on the exact ratio (2.9997:1 is short of 3:1), as the host decides it', () => {
    // accent-2 #725180 on abyss #080822 is 2.9997:1: rounded it reads 3.00, exact it is below the floor, so it is repaired
    const edge = checkLook({ ...DEFAULT_VARIANT.colors, 'accent-2': '#725180' })
    expect(edge.repaired.map((r) => r.token)).toEqual(['accent-2'])
    expect(edge.failures).toEqual([])
  })
  it('the repair searches both ways: on a mid-grey ground, ink passes on the far side', () => {
    // void = abyss = #666 reads as "light" by lightness, so "away" is darker, which can't pass; white gives 5.74:1
    const grey = checkLook({ ...DEFAULT_VARIANT.colors, void: '#666666', abyss: '#666666', ink: '#aaaaaa' })
    expect(grey.failures.filter((f) => f.token === 'ink')).toEqual([])
    expect(grey.repaired.find((r) => r.token === 'ink')?.to).toMatch(/^#[0-9a-f]{6}$/)
  })
})

describe("a look a person makes is data", () => {
  const look = (colors: Record<string, string>, fonts?: Record<string, string>) => ({ ...DEFAULT_VARIANT, id: 'mine', colors: { ...DEFAULT_VARIANT.colors, ...colors }, fonts })
  it("every colour is #rrggbb; only the rules' see-through ones may be rgb(r g b / a) (the host's shape)", () => {
    expect(blockedReason(look({ ink: 'red; background: url(https://example.com/x)' }))).toMatch(/ink/)
    expect(blockedReason(look({ glass: 'url(https://example.com/x)' }))).toMatch(/glass/)
    expect(blockedReason(look({ glass: 'rgb(0 0 0 / 0.5); background:url(x)' }))).toMatch(/glass/)
    expect(blockedReason(look({ ink: 'rgb(236 238 255 / 0.5)' }))).toMatch(/ink/)
    expect(blockedReason(look({ glass: 'rgb(16 16 44 / 0.62)' }))).toBeNull()
    expect(blockedReason(look({ ink: '#f0f0ff' }))).toBeNull()
    expect([...(rules as { translucent: string[] }).translucent].sort()).toEqual([...(mettaSource as string).matchAll(/^\(translucent (\S+)\)/gm)].map((m) => m[1]).sort())
  })
})
