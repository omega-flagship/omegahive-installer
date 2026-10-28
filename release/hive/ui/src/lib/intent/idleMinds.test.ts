import { describe, expect, it, vi } from 'vitest'

vi.mock('../../shell/uiVariant', () => ({ openGallery: () => undefined }))
vi.mock('../../tour/introStore', () => ({ useIntro: { getState: () => ({ setHelp: () => undefined }) } }))
vi.mock('../../store/store', () => ({ useHive: { getState: () => ({ setPalette: () => undefined, setStopAll: () => undefined }) } }))

const { resolve } = await import('./index')
const { featureById } = await import('../../features/registry')
type World = import('./index').World

// INVENTED minds. The flags are the host's answers (Platform r2.4 may_remind / may_sleep / is_mine).
const world: World = {
  minds: [
    { id: 'a_lyra01', name: 'Lyra', awake: true, awakeNow: true, swarm: 'Garden', mayRemind: true, maySleep: true, isMine: false },
    // asleep; the host's may_sleep stays true (permission only, r2.4)
    { id: 'a_moss02', name: 'Moss', awake: false, swarm: 'Garden', mayRemind: false, maySleep: true },
    // someone else's personal mind, as an admin sees it: the host says no to both
    { id: 'a_pip003', name: 'Pip', awake: true, awakeNow: true, swarm: '', personal: true, isMine: false, mayRemind: false, maySleep: false },
    // an older host: no flags at all
    { id: 'a_bare04', name: 'Bare', awake: true, awakeNow: true, swarm: 'Garden' },
    // the viewer's own personal mind
    { id: 'a_wren05', name: 'Wren', awake: true, awakeNow: true, swarm: '', personal: true, isMine: true, mayRemind: true, maySleep: true },
    // starting: awake for the world, not for an action (the one rule: exactly `awake`)
    { id: 'a_fern06', name: 'Fern', awake: true, awakeNow: false, swarm: 'Garden', mayRemind: false, maySleep: true },
  ],
  swarms: [{ id: 's_garden', name: 'Garden' }],
  pending: 0,
}
const top = (text: string) => resolve(text, { experience: 'classic' }, world)[0]
const offered = (text: string) => resolve(text, { experience: 'classic' }, world).filter((c) => c.act && (c.act.do === 'remind' || c.act.do === 'sleep'))

describe('the Ask and idle minds', () => {
  it('"which minds are idle" opens Health at Idle minds', () => {
    const c = top('which minds are idle')
    expect(c.act).toEqual({ do: 'feature', id: 'watch.idle' })
    expect(c.effect).toBe('view')
    expect(featureById('watch.idle')?.classic).toEqual({ name: 'health', section: 'idle' })
  })

  it('"remind Lyra" is a reviewed own action: its exact preview, then Enter', () => {
    const c = top('remind Lyra')
    expect(c.act).toMatchObject({ do: 'remind', mind: { id: 'a_lyra01' } })
    expect(c.effect).toBe('own-action')
    expect(c.parts.map((p) => p.t).join('')).toMatch(/^Have Health remind Lyra/)
    // asleep: Health never wakes one, so nothing is offered to run against it
    expect(top('remind Moss').act).toMatchObject({ do: 'open' })
    // no words of the person's own are added to Health's question
    expect(top('remind Lyra to hurry').limit).toBe(true)
  })

  it('"put Lyra to sleep" confirms first: a preview and Enter, never a silent act', () => {
    const c = top('put Lyra to sleep')
    expect(c.act).toMatchObject({ do: 'sleep', mind: { id: 'a_lyra01' } })
    expect(c.effect).toBe('own-action')
  })

  it('someone else’s personal mind: neither Remind nor Sleep is offered, and the Ask says why', () => {
    expect(offered('remind Pip')).toEqual([])
    expect(offered('put Pip to sleep')).toEqual([])
    const r = top('remind Pip')
    expect(r.limit).toBe(true)
    expect(r.parts.map((p) => p.t).join('')).toMatch(/^Pip .* is someone else’s personal mind; only they can remind it\.$/)
    expect(top('put Pip to sleep').parts.map((p) => p.t).join('')).toMatch(/only they can put it to sleep\.$/)
  })

  it('a missing flag offers nothing (fail closed), said plainly', () => {
    expect(offered('remind Bare')).toEqual([])
    expect(offered('sleep Bare')).toEqual([])
    expect(top('remind Bare').parts.map((p) => p.t).join('')).toMatch(/^The hive does not let you remind Bare/)
  })

  it('an asleep mind with may_sleep true: Sleep is not offered, and the Ask says it is already asleep', () => {
    expect(offered('put Moss to sleep')).toEqual([])
    const c = top('put Moss to sleep')
    expect(c.act).toMatchObject({ do: 'open' })
    expect(c.parts.map((p) => p.t).join('')).toMatch(/^Moss .* is already asleep\.$/)
  })

  it('a starting mind (r1.3, one awake rule): neither Sleep nor Remind is offered, and the Ask says why', () => {
    expect(offered('put Fern to sleep')).toEqual([])
    expect(offered('remind Fern')).toEqual([])
    expect(top('put Fern to sleep').parts.map((p) => p.t).join('')).toMatch(/is still starting\. Sleep works once it is awake\.$/)
  })

  it('the viewer’s own personal mind: both are offered', () => {
    expect(top('remind Wren').act).toMatchObject({ do: 'remind', mind: { id: 'a_wren05' } })
    expect(top('put Wren to sleep').act).toMatchObject({ do: 'sleep', mind: { id: 'a_wren05' } })
  })
})
