import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GuestLimit, HelloCard, Wake } from './FirstLightLayer'
import { panelParts } from './panel'
import { freshBeats } from './journey'
import type { Hello, MonthlyLimit } from './host'
import { stepsFor, type FlPath } from './script'
import type { Run } from './store'

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

const LIMIT: MonthlyLimit = { done: true, enforced: true, enforced_by: 'invite', limit_usd: 5, spent_usd: 0.02, chosen_usd: null, host_name: 'Hazel', pending_request: null }
const greetedHello: Hello = { mind: { id: 'a_m', name: 'Juno', status: 'awake' }, state: 'greeted', greeting: { id: 'm1', text: 'Hi Juno, I’m awake.', created_at: null }, created: true, retryable: false, requested_at: null }

function run(path: FlPath, over: Partial<Run> = {}, facts: Partial<Run['facts']> = {}): Run {
  const steps = stepsFor(path)
  return {
    id: 1, mode: 'live', persona: null, host: null as unknown as Run['host'], bind: { epoch: 1, current: () => true, commit: (w) => w() } as Run['bind'],
    path, steps, i: 0, status: 'playing', token: 1,
    facts: { name: path === 'guest' ? 'Juno' : 'Pip', host: path === 'guest' ? 'Hazel' : 'Pip Lanternfield', ownKeys: path === 'owner' ? 1 : 0, limit: path === 'guest' ? LIMIT : null, onlyMind: true, mind: { id: 'a_m', name: path === 'guest' ? 'Juno' : 'Pip', status: 'asleep' }, lookKept: false, lookName: null, greeted: false, mindOnScreen: null, apps: null, askSaved: false, askHow: null, ...facts },
    beats: freshBeats(), progress: null, notice: null,
    hello: { hello: null, postedAt: null, refusal: null, busy: false, at: 0 },
    ask: { busy: false, sent: null, error: null, choosing: false }, limit: { busy: false, error: null, other: false },
    askForm: { busy: false, error: null }, loadError: null, from: '#/', lookAtStart: null, galleryOpened: false,
    ...over,
  }
}
const at = (r: Run, id: string): Run => ({ ...r, i: r.steps.findIndex((s) => s.id === id) })

describe('the guest band: on every beat of the guest path (1, 3 and 8 included)', () => {
  it('says whose hive, whose key and the limit, on beats 1, 3 and 8', () => {
    const r = run('guest')
    for (const id of ['1.1g', '1.3', '3.1g', '3.2g', '8.2', '8.3']) {
      const band = panelParts(at(r, id)).band
      expect(band, id).toBe('Guest in Hazel’s hive. Runs on Hazel’s key, not yours. Your limit: $5.00 a month (used $0.02); the hive stops your minds there.')
    }
  })
  it('stays through the hello, after the mind greeted', () => {
    const r = at(run('guest', { hello: { hello: greetedHello, postedAt: 1, refusal: null, busy: false, at: 2 } }, { greeted: true }), '8.4g')
    expect(panelParts(r).band).toMatch(/^Guest in Hazel’s hive\. Runs on Hazel’s key, not yours\./)
  })
  it('an owner has no band; the demo is labelled simulated', () => {
    expect(panelParts(run('owner')).band).toBeNull()
    expect(panelParts(run('owner')).sim).toBeNull()
    expect(panelParts(run('guest', { mode: 'demo', persona: 'juno' })).sim).toBe('Juno Ashdown is invented. Nothing here is real, and nothing is sent or spent.')
  })
})

describe('the guest’s limit card', () => {
  it('the limit, what was used, whose key pays, and that the hive stops minds there', () => {
    const t = text(renderToStaticMarkup(createElement(GuestLimit, { run: at(run('guest'), '3.2g') })))
    expect(t).toContain('$5.00 a month · used $0.02')
    expect(t).toContain('Paid from Hazel’s key. You never see Hazel’s key. The hive stops your minds at $5.00.')
    expect(t).toContain('Ask Hazel for more')
    expect(t).toContain('Start my own hive later')
  })
  it('with no limit in force: no amount named as a limit, and still whose key pays', () => {
    const t = text(renderToStaticMarkup(createElement(GuestLimit, { run: at(run('guest', {}, { limit: { ...LIMIT, enforced: false, enforced_by: null } }), '3.2gn') })))
    expect(t).not.toMatch(/stops your minds at/)
    expect(t).toContain('Hazel’s key pays, not yours.')
    expect(t).toContain('Ask Hazel for a limit')
  })
})

describe('Wake: the person presses it; a refusal shows its reason, never a greeting', () => {
  it('says whose key pays for waking', () => {
    expect(text(renderToStaticMarkup(createElement(Wake, { run: at(run('guest'), '8.2') })))).toContain('Waking it can spend: Hazel’s key pays, not yours.')
    expect(text(renderToStaticMarkup(createElement(Wake, { run: at(run('owner'), '8.2') })))).toContain('Waking it can spend: Your own key pays: you pay the model company directly.')
  })
  it('a refusal: its sentence, an Add a key for an owner, and no Try again', () => {
    const r = at(run('owner', { hello: { hello: null, postedAt: null, refusal: { code: 'no_key', sentence: 'Your mind can’t wake yet: it has nothing to think with. Add a key of your own, then wake it here.' }, busy: false, at: 0 } }), '8.2')
    const t = text(renderToStaticMarkup(createElement(Wake, { run: r })))
    expect(t).toContain('Needs you Your mind can’t wake yet')
    expect(t).toContain('Add a key')
    expect(t).not.toContain('Try again')
    expect(t).not.toMatch(/Hi Pip|I’m awake/)
  })
})

describe('the hello card', () => {
  it('shows the mind’s own words once greeted', () => {
    const r = at(run('guest', { hello: { hello: greetedHello, postedAt: 1, refusal: null, busy: false, at: 2 } }, { greeted: true }), '8.3')
    const html = renderToStaticMarkup(createElement(HelloCard, { run: r, now: 3 }))
    expect(text(html)).toContain('Hi Juno, I’m awake.')
    expect(html).toContain('data-testid="fl-greeting"')
  })
  it('no greeting while waiting, and no Try again unless the host says retryable', () => {
    const waiting: Hello = { ...greetedHello, state: 'waiting', greeting: { id: 'm1', text: 'Hi Juno, I’m awake.', created_at: null }, retryable: false }
    const r = at(run('guest', { hello: { hello: waiting, postedAt: 1, refusal: null, busy: false, at: 2 } }), '8.3')
    const t = text(renderToStaticMarkup(createElement(HelloCard, { run: r, now: 3 })))
    expect(t).not.toContain('Hi Juno')
    expect(t).not.toContain('Try again')
    expect(t).toContain('Juno is waking.')
    const retry = at(run('guest', { hello: { hello: { ...waiting, retryable: true }, postedAt: 1, refusal: null, busy: false, at: 2 } }), '8.3')
    expect(text(renderToStaticMarkup(createElement(HelloCard, { run: retry, now: 3 })))).toContain('Try again')
  })
  it('a refusal: its reason, no greeting, no Try again', () => {
    const r = at(run('guest', { hello: { hello: greetedHello, postedAt: null, refusal: { code: 'spend_limit', sentence: 'You’ve reached your $5.00 limit in Hazel’s hive this month, so your mind can’t wake. Ask Hazel for more, or start your own hive later.' }, busy: false, at: 2 } }), '8.3')
    const t = text(renderToStaticMarkup(createElement(HelloCard, { run: r, now: 3 })))
    expect(t).toContain('You’ve reached your $5.00 limit in Hazel’s hive this month')
    expect(t).not.toContain('Hi Juno')
    expect(t).not.toContain('Try again')
  })
  it('just after our own Wake, a hello not yet on record reads “Still waking…”', () => {
    const r = at(run('owner', { hello: { hello: null, postedAt: 1000, refusal: null, busy: false, at: 1000 } }), '8.3')
    expect(text(renderToStaticMarkup(createElement(HelloCard, { run: r, now: 3000 })))).toContain('Still waking…')
  })
})
