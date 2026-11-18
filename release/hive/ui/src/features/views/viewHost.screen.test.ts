// Purpose: what views.metta composes for a view in every state: where it opens (view-page, view-chat), the card before it
// runs (view-run), and everything around it while it runs, a view written in MeTTa or an HTML view (view-host): its bar,
// what it asks for, the domains it waits on and why it is not drawn; and that every part of each screen is reachable.
import { describe, expect, it, vi } from 'vitest'
import { screensSpace } from '../../screens/screenSpace'

vi.setConfig({ testTimeout: 20_000 })

type Facts = { flags?: Record<string, boolean>; counts?: Record<string, number>; values?: Record<string, string> }
const parts = (screen: string, facts: Facts, look = 'classic') => screensSpace().compose(screen, look, facts).parts
const drawn = (screen: string, facts: Facts, look = 'classic') => parts(screen, facts, look).map((p) => `${p.order}:${p.block}`)
const host = (flags: Record<string, boolean>, counts: Record<string, number> = {}, look = 'classic') => drawn('view-host', { flags, counts }, look)
const MAKER = { 'view.maker': 1 }

describe('around a view written in MeTTa', () => {
  it('its bar always, the view once drawn, why when it is not, and Start it again when it stopped', () => {
    expect(host({ 'view.starting': true })).toEqual(['5:bar', '10:waiting'])
    expect(host({ 'view.drawn': true }, MAKER)).toEqual(['5:bar', '60:island', '80:note'])
    expect(host({ 'view.drawn': true })).toEqual(['5:bar', '60:island', '81:note'])
    expect(host({ 'view.broken': true }, MAKER)).toEqual(['5:bar', '20:notice', '80:note'])
    expect(host({ 'view.stopped': true }, MAKER)).toEqual(['5:bar', '30:notice', '40:actions', '80:note'])
    expect(host({ 'view.unsafe': true }, MAKER)).toEqual(['5:bar', '50:notice'])
    // full screen gives the view the whole screen: the bar, and the view
    expect(host({ 'view.drawn': true, 'view.full': true }, MAKER)).toEqual(['5:bar', '60:island'])
    // a look of rooms and light draws the same parts
    expect(host({ 'view.drawn': true }, MAKER, 'cosmos')).toEqual(['5:bar', '60:island', '80:note'])
  })

  it('says which change could not be drawn: a press, a newer revision, or a revision that is no longer a MeTTa view', () => {
    expect(host({ 'view.drawn': true, 'view.slipped': true }, MAKER)).toEqual(['5:bar', '60:island', '70:notice', '80:note'])
    expect(host({ 'view.drawn': true, 'view.slipped': true, 'view.newer': true }, MAKER)).toEqual(['5:bar', '60:island', '71:notice', '80:note'])
    expect(host({ 'view.drawn': true, 'view.slipped': true, 'view.newer': true, 'view.other': true }, MAKER)).toEqual(['5:bar', '60:island', '72:notice', '80:note'])
    expect(host({ 'view.broken': true, 'view.newer': true }, MAKER)).toEqual(['5:bar', '21:notice', '80:note'])
    expect(host({ 'view.broken': true, 'view.newer': true, 'view.other': true }, MAKER)).toEqual(['5:bar', '72:notice', '80:note'])
  })
})

describe('around an HTML view', () => {
  it('its bar and frame, the link or file it asks for as alertdialogs, what it reaches, and Show it again once put away or left', () => {
    for (const look of ['classic', 'cosmos']) {
      expect(host({ 'view.drawn': true }, { ...MAKER, 'view.reaches': 1, 'view.refused': 1 }, look)).toEqual(['5:bar', '60:island', '80:note', '82:note', '84:note'])
      expect(host({ 'view.drawn': true, 'view.asks-link': true }, MAKER, look)).toEqual(['5:bar', '60:island', '62:confirm', '80:note'])
      expect(host({ 'view.drawn': true, 'view.asks-file': true }, MAKER, look)).toEqual(['5:bar', '60:island', '64:confirm', '80:note'])
      // what it asks for is answered in full screen too; the notes are not drawn there
      expect(host({ 'view.drawn': true, 'view.full': true, 'view.asks-link': true }, { ...MAKER, 'view.reaches': 1 }, look)).toEqual(['5:bar', '60:island', '62:confirm'])
      // put away or left: no bar, frame or note, only what MeTTa says in its place
      expect(host({ 'view.folded': true }, { 'view.reaches': 1 }, look)).toEqual(['92:actions'])
      expect(host({ 'view.left': true }, {}, look)).toEqual(['90:notice', '92:actions'])
    }
    const prompts = parts('view-host', { flags: { 'view.drawn': true, 'view.asks-link': true } }).concat(parts('view-host', { flags: { 'view.drawn': true, 'view.asks-file': true } }))
      .filter((p) => p.block === 'confirm')
    expect(prompts.map((p) => [p.order, p.props.alert, p.props.label])).toEqual([[62, 'yes', 'Open a link from the view'], [64, 'yes', 'Save a file from the view']])
  })

  it('asks before it loads from the domains it declares, inline, and says when the answer could not be recorded', () => {
    expect(host({ 'view.drawn': true }, { ...MAKER, 'view.asks': 1 })).toEqual(['5:bar', '60:island', '80:note', '86:notice', '87:actions'])
    expect(host({ 'view.drawn': true, 'view.allow-failed': true }, { ...MAKER, 'view.asks': 1 })).toEqual(['5:bar', '60:island', '80:note', '86:notice', '87:actions', '88:notice'])
    expect(host({ 'view.drawn': true, 'view.full': true, 'view.allow-failed': true }, { ...MAKER, 'view.asks': 1 })).toEqual(['5:bar', '60:island'])
  })
})

describe('before a view runs, and where it opens', () => {
  it('a card names its maker, or a mind, and the domains it would reach, with Run it', () => {
    const run = (asks: number, maker: number, failed = false) => drawn('view-run', { counts: { 'view.asks': asks, 'view.maker': maker }, flags: { 'view.failed': failed } })
    expect(run(0, 1)).toEqual(['10:paragraph', '30:actions'])
    expect(run(0, 0)).toEqual(['11:paragraph', '30:actions'])
    expect(run(2, 1)).toEqual(['10:paragraph', '20:note', '30:actions'])
    expect(run(0, 1, true)).toEqual(['10:paragraph', '30:actions', '40:notice'])
  })

  it('on a page: opening it, a hive that cannot show views, a view that could not be opened, then the card or the view', () => {
    const at = (resource: string, flags: Record<string, boolean> = {}) => drawn('view-page', { values: { resource }, flags })
    expect(at('loading')).toEqual(['10:waiting'])
    expect(at('unsupported')).toEqual(['11:notice'])
    expect(at('failed')).toEqual(['20:notice', '22:actions'])
    expect(at('forbidden')).toEqual(['20:notice', '22:actions'])
    expect(at('failed', { 'view.gone': true })).toEqual(['21:notice', '22:actions'])
    expect(at('ready')).toEqual(['30:island'])
    expect(at('ready', { 'view.ran': true })).toEqual(['31:island'])
  })

  it('under a mind’s message: only a view, once in hand, and never a plan’s page', () => {
    const at = (resource: string, flags: Record<string, boolean> = {}) => drawn('view-chat', { values: { resource }, flags })
    for (const resource of ['loading', 'unsupported', 'failed', 'forbidden']) expect(at(resource, { 'view.ran': true })).toEqual([])
    expect(at('ready')).toEqual(['10:island'])
    expect(at('ready', { 'view.ran': true })).toEqual(['11:island'])
    expect(at('ready', { 'view.ran': true, 'view.document': true })).toEqual([])
  })
})

describe('every part can be reached by some state', () => {
  const reached = (screen: string, states: Facts[]) => [...new Set(states.flatMap((f) => parts(screen, f).map((p) => p.order)))].sort((a, b) => a - b)
  const flag = (...on: string[]) => Object.fromEntries(on.map((f) => [f, true]))

  it('view-host', () => {
    const states: Facts[] = [
      ...['view.starting', 'view.broken', 'view.stopped', 'view.unsafe', 'view.folded', 'view.left'].map((f) => ({ flags: flag(f) })),
      { flags: flag('view.drawn'), counts: { ...MAKER, 'view.reaches': 1, 'view.refused': 1, 'view.asks': 1 } },
      { flags: flag('view.drawn', 'view.allow-failed', 'view.asks-link'), counts: { 'view.asks': 1 } },
      { flags: flag('view.drawn', 'view.asks-file', 'view.slipped') },
      { flags: flag('view.drawn', 'view.slipped', 'view.newer') },
      { flags: flag('view.broken', 'view.newer') },
      { flags: flag('view.broken', 'view.newer', 'view.other') },
    ]
    expect(reached('view-host', states)).toEqual(screensSpace().orders('view-host'))
  })

  it('view-page, view-chat and view-run', () => {
    const page = ['loading', 'unsupported', 'failed', 'ready'].flatMap((resource) => [{ values: { resource } }, { values: { resource }, flags: flag('view.gone', 'view.ran') }])
    expect(reached('view-page', page)).toEqual(screensSpace().orders('view-page'))
    expect(reached('view-chat', [{ values: { resource: 'ready' } }, { values: { resource: 'ready' }, flags: flag('view.ran') }])).toEqual(screensSpace().orders('view-chat'))
    const run: Facts[] = [{ counts: { 'view.asks': 1, 'view.maker': 1 }, flags: flag('view.failed') }, { counts: { 'view.maker': 0 } }]
    expect(reached('view-run', run)).toEqual(screensSpace().orders('view-run'))
  })
})
