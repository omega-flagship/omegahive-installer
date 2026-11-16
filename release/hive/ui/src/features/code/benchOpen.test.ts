import { describe, expect, it } from 'vitest'
import { benchPlan, lastProject, rememberProject, SYNTHETIC } from './benchOpen'
import type { Target } from './CodePage'

const t = (id: string, openable = true): Target => ({ id, kind: 'repository', label: id, detail: '', source: null, repository_id: id.replace('repo:', ''), repo: { root: '/invented', commit: 'c', branch: 'main', dirty: false, subdir: '' }, owner: 'user:invented', private: false, apply: { how: 'pr', ready: true, note: '' }, openable, closed_reason: openable ? null : 'invented reason' })
const none = () => false

describe('Create’s Code bench opens straight into a project', () => {
  it('prefers the last project, then a saved task, then the only one, then the synthetic one; else a one-tap choice', () => {
    const all = [t('repo:a'), t(SYNTHETIC), t('repo:b')]
    expect(benchPlan(all, none, 'repo:b')).toMatchObject({ kind: 'open', target: { id: 'repo:b' }, reuse: false })
    expect(benchPlan(all, (id) => id === 'repo:a', null)).toMatchObject({ kind: 'open', target: { id: 'repo:a' }, reuse: true })
    expect(benchPlan([t('repo:x', false), t('repo:only')], none, null)).toMatchObject({ kind: 'open', target: { id: 'repo:only' } })
    expect(benchPlan(all, none, null)).toMatchObject({ kind: 'open', target: { id: SYNTHETIC } })
    expect(benchPlan([t('repo:a'), t('repo:b')], none, null)).toMatchObject({ kind: 'choose', targets: [{ id: 'repo:a' }, { id: 'repo:b' }] })
  })
  it('never opens a project that is not editable, and says so when none is', () => {
    expect(benchPlan([t('repo:a', false)], none, 'repo:a')).toEqual({ kind: 'none' })
    expect(benchPlan([], none, null)).toEqual({ kind: 'none' })
  })
  it('remembers the last project per sign-in only', () => {
    const m = new Map<string, string>()
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
    rememberProject('user:one', 'repo:a', store)
    expect(lastProject('user:one', store)).toBe('repo:a')
    expect(lastProject('user:two', store)).toBeNull()
    expect(lastProject(null, store)).toBeNull()
  })
})
