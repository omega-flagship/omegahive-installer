import { describe, expect, it } from 'vitest'
import { ApiError } from '../api/client'
import { useHive } from '../store/store'
import { enterFirstRun, firstRunDisposition, isLanding, mayResumeFirstRun } from './firstRun'
import { parse } from '../lib/router'

const record = (status: string) => ({ record: 'first-light.progress/1', version: 0, status })

describe('host First Light takes precedence over browser welcome', () => {
  it('resumes a blank or partial current host record, but never autoopens a completed or explicitly skipped record', async () => {
    for (const status of ['not_started', 'in_progress', 'finished', 'skipped']) {
      const events: string[] = []
      const decision = await enterFirstRun({ onboarding: async () => { events.push('read-host'); return record(status) } }, () => events.push('#/first-light/resume'))
      const needs = status === 'not_started' || status === 'in_progress'
      expect(events).toEqual(needs ? ['read-host', '#/first-light/resume'] : ['read-host'])
      expect(decision).toBe(needs ? 'resume' : 'complete')
    }
  })

  it('unreadable or malformed host state is unknown, never a browser welcome or invented completion', async () => {
    for (const value of [null, {}, { ...record('finished'), record: 'other' }, { ...record('finished'), version: -1 }, record('unknown')]) expect(firstRunDisposition(value)).toBe('unknown')
    const events: string[] = []
    expect(await enterFirstRun({ onboarding: async () => { throw new Error('synthetic read failure') } }, () => events.push('open'))).toBe('unknown')
    expect(await enterFirstRun({}, () => events.push('open'))).toBe('unknown')
    expect(events).toEqual([])
  })

  it('a late old-person result or a component lifetime ending cannot open First Light under another person', async () => {
    for (const stop of ['identity', 'unmount'] as const) {
      let answer: (value: unknown) => void = () => undefined
      let alive = true
      const events: string[] = []
      const pending = enterFirstRun({ onboarding: () => { events.push('read'); return new Promise((resolve) => { answer = resolve }) } }, () => events.push('open'), () => alive)
      expect(events).toEqual(['read'])
      if (stop === 'identity') {
        useHive.setState((s) => ({ inits: s.inits + 1 }))
        expect(await enterFirstRun({ onboarding: async () => { events.push('B-read'); return record('finished') } }, () => events.push('B-open'))).toBe('complete')
      }
      else alive = false
      answer(record('in_progress'))
      expect(await pending).toBe('stopped')
      expect(events).toEqual(stop === 'identity' ? ['read', 'B-read'] : ['read'])
    }
  })

  it('the real typed identity error remains a quiet stop with no route or model dispatch', async () => {
    const events: string[] = []
    const result = await enterFirstRun({ onboarding: async () => { events.push('read'); throw new ApiError(409, 'identity_changed', 'Synthetic prior person') } }, () => events.push('open'))
    expect(result).toBe('stopped')
    expect(events).toEqual(['read'])
  })

  it('a deferred automatic decision yields to manual navigation, an already-open journey or the menu tour', async () => {
    expect(mayResumeFirstRun('#/', '#/', false, false, false)).toBe(true)
    for (const [route, moved, journey, tour] of [['#/me', true, false, false], ['#/', true, false, false], ['#/', false, true, false], ['#/', false, false, true], ['#/first-light/resume', false, false, false]] as const) {
      let answer: (value: unknown) => void = () => undefined
      const events: string[] = []
      const pending = enterFirstRun({ onboarding: () => new Promise((resolve) => { answer = resolve }) }, () => { if (mayResumeFirstRun('#/', route, moved, journey, tour)) events.push('open') })
      answer(record('in_progress'))
      expect(await pending).toBe('resume') // eligible record, but the later UI decision correctly wins
      expect(events).toEqual([])
    }
  })
})

describe('First Light never opens over a deep link (live walk 11-08)', () => {
  const DEEP = ['#/code', '#/code?task=t_invented', '#/code/map/', '#/create/code', '#/me', '#/tasks', '#/swarms/s_invented']
  it('opens by itself only on the landing (#/, # or no hash)', () => {
    for (const h of ['', '#', '#/', '#/?x=1']) {
      expect(isLanding(h)).toBe(true)
      expect(mayResumeFirstRun(h, h, false, false, false)).toBe(true)
    }
    for (const h of [...DEEP, '#/first-light', '#/first-light/resume']) {
      expect(isLanding(h)).toBe(false)
      expect(mayResumeFirstRun(h, h, false, false, false)).toBe(false)
    }
  })

  it('a page load (or re-sign-in) on #/code with an unfinished record leaves the address and the Code page alone', async () => {
    for (const route of DEEP) {
      let hash = route
      const decision = await enterFirstRun({ onboarding: async () => record('in_progress') }, () => {
        if (mayResumeFirstRun(route, hash, false, false, false)) hash = '#/first-light/resume'
      })
      expect(decision).toBe('resume') // the record is still unfinished; the route decides, and it is a deep link
      expect(hash).toBe(route)
    }
    expect(parse('#/code').name).toBe('code')
  })

  it('after "Not now" (status skipped) nothing opens by itself even on the landing', async () => {
    let hash = '#/'
    expect(await enterFirstRun({ onboarding: async () => record('skipped') }, () => { if (mayResumeFirstRun('#/', hash, false, false, false)) hash = '#/first-light/resume' })).toBe('complete')
    expect(hash).toBe('#/')
  })
})
