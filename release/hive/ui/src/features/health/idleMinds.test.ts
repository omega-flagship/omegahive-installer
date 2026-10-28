import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type HiveClient } from '../../api/client'
import {
  clipReply, hostAllows, remindButton, readIdleDetail, readIdleMind, readIdleOverview, remindRefusal, REMIND_ONCE_MS, REPLY_MAX, replyWords, showRemind, showSleep, STATUS_LABEL, totalLine, windowSentence,
  type IdleMind, type Viewer,
} from '../../api/idleMinds'
import { SimClient } from '../../api/sim/SimClient'
import { money } from '../../lib/format'
import { href } from '../../lib/router'
import { useHive } from '../../store/store'
import { IdleCard } from './IdleMinds'

// Everything here is INVENTED: minds, people and questions.
const mind = (over: Partial<IdleMind> = {}): IdleMind => ({
  id: 'a_test01', name: 'Lyra', swarm_id: 's_x', mind_status: 'awake', personal: false, idle_calls_24h: 12, idle_spend_24h: 0.4213,
  last_input_at: '2026-10-10T09:12:03.120Z', noticed: true, kind: 'idle', owed: [], question_id: 'hq_1', question: '[HEALTH-QUESTION hq_1] You’ve spent $0.42 over 3 hours with no input: sleep, or tell me what you’re waiting for?',
  question_at: '2026-10-10T10:15:00.000Z', question_by: 'hive:health', reply: null, reply_at: null, status: 'asked', actions: { remind: true, sleep: true },
  may_remind: true, may_sleep: true, is_mine: false, ...over,
})
const ADMIN: Viewer = { principal: 'user:operator', admin: true, auditing: false }
const AUDITOR: Viewer = { ...ADMIN, auditing: true }
const PERSON: Viewer = { principal: 'user:u_ana', admin: false, auditing: false }
const card = (m: IdleMind, viewer: Viewer) => renderToStaticMarkup(createElement(IdleCard, { mind: m, rowAt: 0, viewer, swarmName: 'Garden' }))
beforeEach(() => useHive.setState({ remindedAt: {} }))
// r1.3: the host's flags as GET /api/agents/{id} gives them, read fresh at the press
const allowed = async (id: string) => ({ id, name: 'Lyra', status: 'awake', may_remind: true, may_sleep: true, is_mine: false })

describe('idle minds: reading the host', () => {
  it('keeps the host order and drops malformed entries; window defaults only when missing', () => {
    const o = readIdleOverview({ minds: [{ id: 'a_2', status: 'asked' }, { nope: 1 }, { agent_id: 'a_1', status: 'weird', idle_spend_24h: -3 }], window: { notice_after_s: 1800 } })
    expect(o.minds.map((m) => m.id)).toEqual(['a_2', 'a_1'])
    expect(o.minds[1].status).toBe('quiet')
    expect(o.minds[1].idle_spend_24h).toBe(0)
    expect(o.window).toEqual({ notice_after_s: 1800, ask_quiet_s: 21600, counts_over_s: 86400 })
    const d = readIdleDetail({ id: 'a_1', history: Array.from({ length: 25 }, (_, i) => ({ question_id: `hq_${i}`, status: 'resolved' })) })
    expect(d?.history).toHaveLength(20)
    expect(d?.history[0].question_id).toBe('hq_0')
  })

  it('says the window and the total in plain words', () => {
    expect(windowSentence({ notice_after_s: 3600, ask_quiet_s: 21600, counts_over_s: 86400 })).toBe('Health notices after 1 hour with no input; asks at most every 6 hours.')
    expect(totalLine([{ idle_spend_24h: 3.86 }, { idle_spend_24h: 0.19 }, { idle_spend_24h: 0 }], money)).toBe('Idle spend in the last 24 h: $4.05 across 2 minds')
  })
})

describe('idle minds: "replied" means the mind spoke after the question, not that it agreed', () => {
  it('words it neutrally as Answered, and shows its words as said', () => {
    expect(STATUS_LABEL.replied).toBe('Answered')
    const m = mind({ status: 'replied', reply: 'Waiting for review; I will finish after it.', reply_at: '2026-10-10T10:16:41.007Z' })
    expect(replyWords(m)).toEqual({ label: 'Answered', text: 'Waiting for review; I will finish after it.' })
    const html = card(m, ADMIN)
    expect(html).toContain('Answered')
    expect(html).toContain('Waiting for review; I will finish after it.')
    expect(html).not.toMatch(/agree|accepted|resolved it|done/i)
    expect(replyWords(mind({ status: 'asked' })).label).toBe('No answer yet')
    expect(replyWords(mind({ question: null })).label).toBe('Not asked')
  })
})

describe('idle minds: who sees Remind and Sleep (only the host’s may_remind / may_sleep, Platform r2.4)', () => {
  it('a missing flag shows no action (fail closed), whoever looks and whatever the mind is', () => {
    const bare = readIdleMind({ id: 'a_test01', name: 'Lyra', status: 'asked', actions: { remind: true, sleep: true } })!
    expect(bare.may_remind).toBe(false)
    expect(bare.may_sleep).toBe(false)
    expect(hostAllows({}, 'remind')).toBe(false)
    expect(hostAllows(null, 'sleep')).toBe(false)
    expect(hostAllows({ may_remind: 'yes' } as unknown as { may_remind: boolean }, 'remind')).toBe(false)
    for (const v of [ADMIN, AUDITOR, PERSON]) expect(card(bare, v)).not.toMatch(/data-idle-(remind|sleep)/)
  })

  it('an admin sees someone else’s personal mind read-only: flags false, no buttons, said plainly', () => {
    const p = mind({ personal: true, is_mine: false, may_remind: false, may_sleep: false })
    for (const v of [ADMIN, AUDITOR]) {
      expect(showRemind(p)).toBe(false)
      expect(showSleep(p)).toBe(false)
      const html = card(p, v)
      expect(html).not.toMatch(/data-idle-(remind|sleep)/)
      expect(html).toContain('Someone else’s personal mind')
    }
  })

  it('the owner’s own personal mind gets both actions (no ownership worked out in the UI)', () => {
    const own = readIdleMind({ id: 'a_own', name: 'Wren', personal: true, is_mine: true, may_remind: true, may_sleep: true, mind_status: 'awake', status: 'noticed' })!
    expect(own.is_mine).toBe(true)
    const html = card(own, PERSON)
    expect(html).toContain('data-idle-remind')
    expect(html).toContain('data-idle-sleep')
    expect(html).not.toContain('Someone else’s personal mind')
  })

  it('any other mind: each button follows its own flag, never the actions hint alone', () => {
    expect(card(mind({ may_remind: false }), ADMIN)).not.toContain('data-idle-remind')
    expect(card(mind({ may_remind: false }), ADMIN)).toContain('data-idle-sleep')
    expect(card(mind({ may_sleep: false }), ADMIN)).not.toContain('data-idle-sleep')
    expect(card(mind({ may_sleep: false }), ADMIN)).toContain('data-idle-remind')
  })
})

describe('idle minds: Sleep only for an awake mind (r1.2: the host’s may_sleep is permission only)', () => {
  it('asleep with may_sleep true: no Sleep; awake with may_sleep true: Sleep', () => {
    const asleep = mind({ mind_status: 'asleep', may_sleep: true, may_remind: false })
    expect(showSleep(asleep)).toBe(false)
    expect(card(asleep, ADMIN)).not.toContain('data-idle-sleep')
    expect(card(asleep, ADMIN)).toContain('asleep')
    const awake = mind({ mind_status: 'awake', may_sleep: true })
    expect(showSleep(awake)).toBe(true)
    expect(card(awake, ADMIN)).toContain('data-idle-sleep')
    // r1.4: Remind too is withheld unless the mind is awake (a kept may_remind can be older than the status)
    expect(card(mind({ mind_status: 'asleep', may_remind: true }), ADMIN)).not.toContain('data-idle-remind')
    expect(card(mind({ mind_status: 'awake', may_remind: true }), ADMIN)).toContain('data-idle-remind')
  })
})

describe('idle minds: a long answer is clipped, with the conversation one click away', () => {
  it('at most REPLY_MAX characters, and a link to read it all', () => {
    const long = 'w'.repeat(500)
    const c = clipReply(long)
    expect(c.clipped).toBe(true)
    expect([...c.text!].length).toBeLessThanOrEqual(REPLY_MAX)
    expect(clipReply('short').clipped).toBe(false)
    const html = card(mind({ status: 'replied', reply: long }), ADMIN)
    expect(html).not.toContain(long)
    expect(html).toContain('Read it all in the conversation')
  })
})

describe('idle minds: Remind', () => {
  it('409 not_awake, 403 personal_mind and 404 are said plainly; anything else is not a refusal', () => {
    expect(remindRefusal(new ApiError(409, 'not_awake', 'x'), 'Lyra')).toMatch(/Lyra is not awake, so Health did not ask/)
    expect(remindRefusal(new ApiError(403, 'personal_mind', 'x'), 'Lyra')).toMatch(/Only that person can remind it/)
    expect(remindRefusal(new ApiError(404, 'not_found', 'x'), 'Lyra')).toMatch(/not one you can remind here/)
    expect(remindRefusal(new TypeError('net'), 'Lyra')).toBeNull()
  })

  it('the store keeps the minute by mind id: a double click asks once, and a remount still shows it off', async () => {
    const call = vi.fn(() => Promise.resolve({}))
    useHive.setState({ client: { remindIdle: call, getAgent: allowed } as unknown as HiveClient, session: 's1' })
    const first = useHive.getState().remindIdle('a_test01', 'Lyra')
    const second = await useHive.getState().remindIdle('a_test01', 'Lyra')
    expect(second).toMatchObject({ ok: false, held: true })
    expect((await first)?.ok).toBe(true)
    expect(call).toHaveBeenCalledTimes(1)
    // the minute is the store's, by mind id: a fresh card (a remount, a list reload) computes its button from it
    // (IdleCard: remindButton(useHive remindedAt[id], now)); nothing about it lives in the card
    const fresh = () => remindButton(useHive.getState().remindedAt.a_test01, Date.now())
    expect(fresh()).toMatchObject({ on: false, label: 'Reminded' })
    // another mind is not held
    expect(remindButton(useHive.getState().remindedAt.a_other, Date.now())).toMatchObject({ on: true, label: 'Remind' })
    // after the minute it works again
    useHive.setState({ remindedAt: { a_test01: Date.now() - REMIND_ONCE_MS } })
    expect(fresh()).toMatchObject({ on: true, label: 'Remind' })
    expect(await useHive.getState().remindIdle('a_test01', 'Lyra')).toMatchObject({ ok: true })
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('a 409 through the store is plain words, and still holds the minute', async () => {
    useHive.setState({ client: { remindIdle: () => Promise.reject(new ApiError(409, 'not_awake', 'x')), getAgent: allowed } as unknown as HiveClient, session: 's1' })
    expect(await useHive.getState().remindIdle('a_test01', 'Lyra')).toEqual({ ok: false, text: 'Lyra is not awake, so Health did not ask. Health only asks awake minds and never wakes one.' })
    expect(useHive.getState().remindedAt.a_test01).toBeTypeOf('number')
  })
})

describe('idle minds: the sim fixture (INVENTED)', () => {
  const sim = () => new SimClient({ seed: 3, latency: false, autoStart: false, historyDays: 1 })

  it('shows an asked-and-answered mind and a costly idle one; personal minds only under audit', async () => {
    const c = sim()
    const o = await c.idleMinds()
    const by = Object.fromEntries(o.minds.map((m) => [m.name, m]))
    expect(by.Coral).toMatchObject({ kind: 'idle', status: 'noticed' })
    expect(by.Coral.idle_spend_24h).toBeGreaterThan(1)
    expect(by.Anvil.reply).toBeTruthy()
    expect(by.Vega.status).toBe('asked')
    expect(o.minds.filter((m) => m.personal).map((m) => m.name)).toEqual(['Mira'])
    const audit = await c.idleMinds({ includePersonal: true })
    const pip = audit.minds.find((m) => m.name === 'Pip')
    expect(pip).toMatchObject({ personal: true, is_mine: false, may_remind: false, may_sleep: false })
    // the viewer's own personal mind: both flags true
    expect(audit.minds.find((m) => m.name === 'Mira')).toMatchObject({ personal: true, is_mine: true, may_remind: true, may_sleep: true })
    // agent views carry the flags too (Platform r2.4 agent_view)
    const agents = await c.listAgents()
    expect(agents.find((a) => a.id === 'a_mira04')).toMatchObject({ is_mine: true, may_remind: true, may_sleep: true })
    expect(agents.find((a) => a.id === 'a_coral5')).toMatchObject({ is_mine: false, may_remind: true, may_sleep: true })
    await expect(c.remindIdle(pip!.id)).rejects.toMatchObject({ status: 403, code: 'personal_mind' })
  }, 30_000)

  it('two Reminds within 60 s are one question; a mind that is not awake is 409 not_awake', async () => {
    const c = sim()
    const before = (await c.idleMind('a_coral5'))!.history.length
    await c.remindIdle('a_coral5')
    const after = await c.remindIdle('a_coral5')
    expect(after!.history.length).toBe(before + 1)
    expect(after!.status).toBe('asked')
    await c.agentAction('a_coral5', 'sleep')
    await expect(c.remindIdle('a_coral5')).rejects.toMatchObject({ status: 409, code: 'not_awake' })
  }, 30_000)
})

describe('idle minds: the route', () => {
  it('#/health/idle opens Health at the section', () => expect(href({ name: 'health', section: 'idle' })).toBe('#/health/idle'))
})
