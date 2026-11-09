import { afterEach, describe, expect, it, vi } from 'vitest'
import { answererChoice } from './answererChoice'
import type { AskContext } from '../../api/ask'
const page: AskContext = { route: 'hive', experience: 'classic' }
afterEach(() => answererChoice.clear())
describe('explicit per-thread answerer choice', () => {
  it('names the selected swarm without a preference write or mutation of the original context', () => {
    const original = Object.freeze({ ...page, swarm_id: 's_page' })
    answererChoice.select({ kind: 'swarm', swarm: 's_chosen', name: 'Chosen' }, () => true)
    expect(answererChoice.apply(original)).toMatchObject({ swarm_id: 's_chosen' })
    expect(original.swarm_id).toBe('s_page')
  })
  it('never overrides a typed address or mind selection', () => {
    answererChoice.select({ kind: 'swarm', swarm: 's_chosen', name: 'Chosen' }, () => true)
    const addressed = { ...page, mind: 'a_explicit' }
    const selected = { ...page, selection: [{ kind: 'mind' as const, ref: 'a_explicit' }] }
    expect(answererChoice.apply(addressed)).toBe(addressed)
    expect(answererChoice.apply(selected)).toBe(selected)
  })
  it('preserves exact private context and never claims a private one-shot override', () => {
    answererChoice.select({ kind: 'own', mind: 'a_own', swarm: 's_own', name: 'Ada' }, () => true)
    const privateContext = Object.freeze({ private: true as const })
    expect(answererChoice.apply(privateContext)).toBe(privateContext)
    expect(answererChoice.matches(privateContext)).toBe(false)
    expect(answererChoice.expectedOwn(privateContext)).toBeUndefined()
  })
  it('an identity/thread-origin change removes the old choice from every read and route', () => {
    let current = true
    answererChoice.select({ kind: 'swarm', swarm: 's_old', name: 'Old' }, () => current)
    current = false
    expect(answererChoice.get()).toBeNull()
    expect(answererChoice.apply(page)).toBe(page)
    expect(answererChoice.select({ kind: 'swarm', swarm: 's_stale', name: 'Stale' }, () => false)).toBe(false)
  })
  it('own selection removes the page swarm and pins only matching own routes for revalidation', () => {
    answererChoice.select({ kind: 'own', mind: 'a_own', swarm: 's_own', name: 'Ada' }, () => true)
    const routed = answererChoice.apply({ ...page, swarm_id: 's_page' })
    expect(routed).toMatchObject({ mind: 'a_own', swarm_id: 's_own' })
    expect(answererChoice.expectedOwn(routed)).toBe('a_own')
    expect(answererChoice.expectedOwn({ ...page, mind: 'a_typed' })).toBeUndefined()
  })
  it('closing or replacing the thread clears selection and publishes once', () => {
    const changed = vi.fn(), off = answererChoice.subscribe(changed)
    answererChoice.select({ kind: 'thread', mind: 'a_current', name: 'Vega' }, () => true)
    answererChoice.clear()
    expect(answererChoice.get()).toBeNull()
    expect(changed).toHaveBeenCalledTimes(2)
    off()
  })
})

it('an explicit override drops the prior program and all its selection/view references', () => {
  answererChoice.select({ kind: 'swarm', swarm: 's_other', name: 'Other' }, () => true)
  const original: AskContext = { ...page, swarm_id: 's_program', program: 'old_program', selection: [{ kind: 'artifact', ref: 'old-program:file' }], view: { refs: [{ kind: 'item', ref: 'old-program:item' }], acts: ['old-action'] } }
  const next = answererChoice.apply(original)
  expect(next).toMatchObject({ swarm_id: 's_other' })
  expect(next).not.toHaveProperty('program')
  expect(next).not.toHaveProperty('selection')
  expect(next).not.toHaveProperty('view')
  expect(original).toHaveProperty('program', 'old_program')
})
