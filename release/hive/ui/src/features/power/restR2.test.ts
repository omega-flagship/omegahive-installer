import { describe, expect, it } from 'vitest'
import * as rest from './rest'
import type { RestAlert } from './rest'

/** Kimi resting review (FIX-FIRST 1-4), as tests. Synthetic data only. */
const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string, e: 'utf8') => string }
const HERE = new URL('.', import.meta.url).pathname
const src = (p: string) => fs.readFileSync(`${HERE}${p}`, 'utf8')
const r = rest as unknown as Record<string, (...a: unknown[]) => unknown>

const decision = (id: string): RestAlert => ({ kind: 'decision', title: null, key: `decision:${id}` })
const goal = (id: string): RestAlert => ({ kind: 'goal', title: 'G', key: `goal:${id}` })

describe('Kimi 1: counts, lines and buttons always agree', () => {
  it('a decision settled elsewhere leaves no line, no count and no button; a pending one keeps all three', () => {
    const missed = [decision('d1'), goal('g1')]
    const settled = r.liveAlerts(missed, new Set<string>()) as RestAlert[]
    expect(settled.map((a) => a.key)).toEqual(['goal:g1'])
    expect(rest.awaySummary(settled)).not.toMatch(/decision/)
    expect((r.awayChips(settled, 0) as { id: string }[]).map((c) => c.id)).toEqual(['goals'])
    const pending = r.liveAlerts(missed, new Set(['d1'])) as RestAlert[]
    expect(rest.awaySummary(pending)).toMatch(/1 decision waiting/)
    expect((r.awayChips(pending, 1) as { id: string }[]).map((c) => c.id)).toEqual(['decisions', 'goals'])
  })

  it('every chip the away line offers is named in its words, and every kind it names has a chip', () => {
    const all = [decision('d1'), goal('g1'), { kind: 'ask', title: null, key: 'ask:r' }, { kind: 'thread', title: null, key: 'thread:o' }, { kind: 'power', title: null, key: 'power:s' }] as RestAlert[]
    const live = r.liveAlerts(all, new Set(['d1'])) as RestAlert[]
    const words = rest.awaySummary(live)!
    const chips = r.awayChips(live, 1) as { id: string }[]
    const NAME: Record<string, RegExp> = { decisions: /decision/, goals: /\btasks? done/, asks: /\basks? waiting/, answers: /thread/, power: /power/ }
    for (const c of chips) expect(words, c.id).toMatch(NAME[c.id])
    expect(chips).toHaveLength(5)
  })

  it('the host offers the away line’s buttons from the live alerts (r3: its words are the fixed history)', () => {
    const host = src('RestScreen.tsx')
    expect(host).toMatch(/awayChips\(liveMissed, decisions\)/)
  })
})

describe('Kimi 2: a press on the rest can never swallow the wake', () => {
  it('any touch or press on the rest wakes at once (a shield catches its click); a press on an alert goes there', () => {
    expect(rest.wakeFor({ type: 'touchstart', onRest: true }, null)).toMatchObject({ wake: true, shield: true })
    expect(rest.wakeFor({ type: 'pointerdown', onRest: true }, null)).toMatchObject({ wake: true, shield: true })
    expect(rest.wakeFor({ type: 'pointerdown', onRest: true, onChip: true } as never, null)).toMatchObject({ wake: false })
    expect(rest.wakeFor({ type: 'pointerdown', onRest: false }, null)).toMatchObject({ wake: true, shield: false })
  })

  it('a press that never ends cleanly cannot block rest forever: it is released on up, cancel, blur, hiding or a buttonless move (r3), and goes stale', () => {
    expect(r.PRESS_ENDS).toEqual(expect.arrayContaining(['pointerup', 'pointercancel', 'blur', 'visibilitychange']))
    expect(r.pressHeld(null, 1000)).toBe(false)
    expect(r.pressHeld(1000, 1000 + 5_000)).toBe(true)
    expect(r.pressHeld(1000, 1000 + (r.PRESS_STALE_MS as unknown as number) + 1)).toBe(false)
    const host = src('RestScreen.tsx')
    expect(host).toMatch(/PRESS_ENDS\.forEach/)
    // a press on an alert whose click never comes still wakes
    expect(host).toMatch(/chipFallback/)
  })
})

describe('Kimi 3: never resting mid-typing or mid-scroll, by event, not by sampling', () => {
  it('input (dictation, paste) wakes and counts as presence', () => {
    expect(rest.wakeFor({ type: 'input' } as never, null)).toMatchObject({ wake: true })
    expect(src('RestScreen.tsx')).toMatch(/'input'/)
  })

  it('a scroll continuing a person’s own gesture (momentum) counts; a page scrolling itself later does not', () => {
    expect(r.scrollIsPresence(10_000, 9_000)).toBe(true)
    expect(r.scrollIsPresence(10_000, 10_000 - (r.MOMENTUM_MS as unknown as number) - 1)).toBe(false)
    expect(rest.wakeFor({ type: 'scroll' } as never, null)).toMatchObject({ wake: false })
    expect(src('RestScreen.tsx')).toMatch(/'scroll'/)
  })
})

describe('Kimi 4: the counts are only what this viewer may see', () => {
  const core = (p: string) => fs.readFileSync(`${HERE}../../../../core/${p}`, 'utf8')

  it('decisions come only from the viewer’s own filtered reads and filtered stream (server contract, either generation)', () => {
    const app = core('app.py')
    // GET /api/approvals: filtered per person
    expect(app).toMatch(/async def approvals\(request: Request, status: str \| None = None\):[\s\S]{0,200}hive\.visibility\.filter_items\(viewer\(session\), hive\.policy\.approvals\(status\)\)/)
    // the live stream: every frame passes the per-person filter
    expect(app).toMatch(/if hive\.visibility\.event_visible\(who, text\):/)
    const vis = core('visibility.py')
    if (vis.includes('EVENT_RULES')) {
      // the registered generation (live d5f608a): approvals are scoped to the minds this person sees. Checked as rule
      // membership (the names inside the `scoped` group), not its layout: other kinds and comments come and go there.
      // The behaviour itself (a viewer who cannot see the mind never gets its approval frames) is the host's
      // hive/tests/test_visibility.py test_approval_events_reach_only_people_who_see_the_mind.
      const scoped = /\*\*\{k: "scoped" for k in \(([\s\S]*?)\)\}/.exec(vis)?.[1] ?? ''
      const kinds = new Set([...scoped.replace(/#[^\n]*/g, '').matchAll(/"([a-z_.]+)"/g)].map((m) => m[1]))
      expect(kinds.has('approval.created') && kinds.has('approval.updated'), 'approval.created and approval.updated are scoped').toBe(true)
      expect(vis).not.toMatch(/\*\*\{k: "(?:public|admin)" for k in \([^)]*"approval\.(?:created|updated)"/)
    } else {
      // the id-scan generation: an approval names its mind (agent_id), and a frame naming a mind the person cannot see is withheld
      expect(vis).toMatch(/k in \("agent_id", "mind_id", "mind", "about"\)/)
      expect(vis).toMatch(/all\(viewer\.sees\(self\._agent\(a\)\) for a in agent_ids\)/)
    }
  })

  it('health alerts and people’s asks are scoped in the rest itself: admins only (whatever the host sent)', () => {
    const waiting = { decisions: 2, health: 3 }
    const away = [{ kind: 'ask', title: null, key: 'ask:r1' }] as RestAlert[]
    expect(rest.restCounts(waiting, away, false)).toMatchObject({ decisions: 2, health: 0, asks: 0 })
    expect(rest.restCounts(waiting, away, true)).toMatchObject({ decisions: 2, health: 3, asks: 1 })
    expect(r.liveAlerts(away, new Set<string>(), false)).toEqual([])
    expect(src('PowerHost.tsx')).toMatch(/admin=\{view\.admin === true\}/)
  })

  it('the rest reads nothing else: the same store selector as the Inbox badge, no reads of its own', () => {
    const host = src('RestScreen.tsx')
    expect(host).toMatch(/useHive\(\(s\) => countPending\(s\.approvals\)\)/)
    expect(host).not.toMatch(/fetch\(|client\.\w+\(/)
    expect(src('../../shell/Nav.tsx')).toMatch(/countPending\(s\.approvals\)/)
  })
})
