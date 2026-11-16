// The demo showreel's state machine and what the Ask hears while it shows (Surface demo D4). Pure; INVENTED data.
import { describe, expect, it } from 'vitest'
import { active, dwellMs, IDLE, reduceReel, type Reel, type ReelEvent } from './machine'
import { answerFor, hear, OFF_SCRIPT, startsShowreel } from './words'
import { PLAYLIST, SCENES } from './scenes'

const run = (events: ReelEvent[], from: Reel = IDLE) => events.reduce(reduceReel, from)
const started = run([{ type: 'start', total: 4, loop: false }])

describe('the showreel machine', () => {
  it('plays step by step and ends (no loop), or goes round again (loop)', () => {
    let r = started
    expect([r.status, r.at]).toEqual(['playing', 0])
    for (let i = 1; i < 4; i++) r = reduceReel(r, { type: 'done', token: r.token })
    expect([r.status, r.at]).toEqual(['playing', 3])
    r = reduceReel(r, { type: 'done', token: r.token })
    expect(r.status).toBe('ended')
    let l = run([{ type: 'start', total: 2, loop: true }])
    l = reduceReel(l, { type: 'done', token: l.token })
    l = reduceReel(l, { type: 'done', token: l.token })
    expect([l.status, l.at, l.rounds]).toEqual(['playing', 0, 1])
  })

  it('a late "done" from a superseded step does nothing', () => {
    const r = reduceReel(started, { type: 'next' })
    expect(reduceReel(r, { type: 'done', token: started.token })).toBe(r)
  })

  it('typing into the Ask pauses it; Carry on plays the same step again from its start', () => {
    const p = reduceReel(started, { type: 'pause', why: 'ask' })
    expect([p.status, p.paused, p.at]).toEqual(['paused', 'ask', 0])
    expect(reduceReel(p, { type: 'done', token: started.token })).toBe(p)
    const c = reduceReel(p, { type: 'resume' })
    expect([c.status, c.at, c.token > p.token]).toEqual(['playing', 0, true])
  })

  it('the person’s input takes over (from playing or paused); typing into the Ask afterwards does not undo it', () => {
    const t = reduceReel(started, { type: 'takeover' })
    expect(t.status).toBe('took-over')
    expect(reduceReel(t, { type: 'pause', why: 'ask' })).toBe(t)
    expect(reduceReel(reduceReel(started, { type: 'pause', why: 'layers' }), { type: 'takeover' }).status).toBe('took-over')
    // Carry on after a take-over plays from where it stopped
    expect([reduceReel(t, { type: 'resume' }).status, reduceReel(t, { type: 'resume' }).at]).toEqual(['playing', 0])
  })

  it('next, back and goto stay in range; stop ends; an ended reel only starts again', () => {
    expect(reduceReel(started, { type: 'back' }).at).toBe(0)
    expect(reduceReel(started, { type: 'goto', at: 9 })).toBe(started)
    expect(reduceReel(started, { type: 'goto', at: 2 }).at).toBe(2)
    const e = reduceReel(started, { type: 'stop' })
    expect(e.status).toBe('ended')
    expect(reduceReel(e, { type: 'resume' })).toBe(e)
    expect(active(e)).toBe(false)
    expect(reduceReel(e, { type: 'start', total: 3 }).status).toBe('playing')
  })

  it('a step stays long enough to read', () => {
    expect(dwellMs('short')).toBe(4500)
    expect(dwellMs('x'.repeat(1000))).toBe(12000)
  })
})

describe('what the Ask hears while the showreel shows', () => {
  it('why, what and why-click questions in many phrasings', () => {
    for (const t of ['why?', 'Why', 'why that?', 'what for?']) expect([t, hear(t).kind]).toEqual([t, 'why'])
    for (const t of ['what’s that?', "what's that", 'What is this?', 'what am I looking at?']) expect([t, hear(t).kind]).toEqual([t, 'what'])
    for (const t of ['why did you click that?', 'Why did you open that?', 'what did you click?']) expect([t, hear(t).kind]).toEqual([t, 'click'])
  })
  it('how, deeper and show me more open the layers; carry on, pause, stop, next and back work by word', () => {
    for (const t of ['how?', 'how does that work?', 'deeper', 'show me more about this', 'all the way down']) expect([t, hear(t).kind]).toEqual([t, 'how'])
    expect(hear('carry on').kind).toBe('carry-on')
    expect(hear('Continue.').kind).toBe('carry-on')
    expect(hear('wait').kind).toBe('pause')
    expect(hear('stop').kind).toBe('stop')
    expect(hear('next').kind).toBe('next')
    expect(hear('go back').kind).toBe('back')
  })
  it('anything else is off-script, with one plain line', () => {
    for (const t of ['what is the capital of France', 'make me a poster', 'why is the sky blue']) expect([t, hear(t).kind]).toEqual([t, 'other'])
    expect(OFF_SCRIPT).toBe('I can only explain this demo’s steps here.')
  })
  it('"show me around" starts it; other words do not', () => {
    expect(startsShowreel('show me around')).toBe(true)
    expect(startsShowreel('Show me around!')).toBe(true)
    expect(startsShowreel('watch it run')).toBe(true)
    expect(startsShowreel('show me around motivations')).toBe(false)
  })
  it('every answer is the step’s own script', () => {
    for (const { step } of PLAYLIST) {
      expect(answerFor('why', step)).toBe(step.why)
      expect(answerFor('what', step)).toBe(step.seeing)
      expect(answerFor('click', step)).toBe(step.click ?? step.why)
    }
  })
})

describe('the scenes', () => {
  it('cover every scripted feature (r2 on 3eced24: the personal mind and the swarm delete preview are live, so they play too)', () => {
    expect(SCENES.map((s) => s.title)).toEqual(['Your personal mind', 'A swarm’s own room', 'Swarm delete preview', 'Studio save', 'Tools inspect', 'Lab: a stalled run, two versions', 'Health: a spend cap'])
  })
  it('every step says why, what you see, and carries a synthetic trace with all eight layers', () => {
    for (const { scene, i, step } of PLAYLIST) {
      const id = `${scene.id}#${i}`
      expect([id, step.why.length > 20, step.seeing.length > 20]).toEqual([id, true, true])
      expect([id, step.trace.source]).toEqual([id, 'synthetic'])
      for (const k of ['screen', 'code', 'hive', 'mind', 'atomspace', 'reasoning', 'memory', 'files'] as const) expect([id, k, step.trace[k] !== undefined]).toEqual([id, k, true])
    }
    // the maths shows each kind of rule somewhere in the showreel (a page read has no inference: it says so)
    const shown = new Set(PLAYLIST.flatMap((p) => p.step.trace.reasoning ?? []).map((r) => r.case.replace(/-[a-z]+$/, '')))
    expect([...shown].sort()).toEqual(['nal-ded', 'nal-rev', 'pln-abd', 'pln-ded', 'pln-ind', 'pln-mp', 'pln-rev'])
  })
  it('moves only through the conductor’s own acts, and never presses a decision', () => {
    for (const { step } of PLAYLIST) {
      for (const a of [...(step.before ?? []), ...(step.after ?? [])]) expect(['navigate', 'open', 'point', 'highlight', 'team-room', 'design']).toContain(a.kind)
      // the guided step itself moves nothing (the acts above do): `ui: close` only closes what a demo opened
      expect(step.guide.do).toEqual({ ui: 'close' })
      // a warning it opens is only ever the delete preview, opened with the page's own opener (never pressed)
      if (step.dialog) expect(step.dialog).toEqual({ kind: 'swarm-delete', swarm: 's_drift', name: 'Driftwood' })
    }
  })
  it('the personal mind: nothing in it can flip the swarm-talk switch or press Forget (it only moves and points)', () => {
    const mind = PLAYLIST.find((p) => p.scene.id === 'showreel-personal-mind')!.step
    expect(mind.before).toEqual([{ kind: 'navigate', route: '#/me/mind', label: 'Your mind' }])
    expect(mind.after ?? []).toEqual([])
    expect(mind.dialog).toBeUndefined()
  })
})
