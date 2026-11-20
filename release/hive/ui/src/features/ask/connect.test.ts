// Purpose: whether the signed-in person has a model the Ask could reach (connect.ts; omegahive-feedback#135), from the
// hive's own list of providers as it states them to that person.
import { describe, expect, it } from 'vitest'
import type { ProviderStatus } from '../../api/types'
import { SCREEN_SOURCES } from '../../screens/screenSpace'
import { connectScreen, needsModel, providerUsable } from './connect'

const p = (name: string, over: Partial<ProviderStatus> = {}): ProviderStatus => ({
  name, label: name, local: false, needs_key: true, connected: false, configured: false, source: null, key_hint: '', key_env: '',
  base_url: '', models: ['some-model'], keys: 0, ...over,
})
const mock = p('mock', { local: true, needs_key: false, connected: true, configured: true, test_only: true, readiness: 'test_only', models: ['echo'] })
/** a hive as installed: keyed providers with no key, the local slot with no model, and the demonstration model */
const bare = [p('openrouter'), p('anthropic'), p('openai'), p('local', { local: true, needs_key: false, connected: true, configured: true, models: [] }), mock]
const withOne = (name: string, over: Partial<ProviderStatus>) => bare.map((x) => (x.name === name ? { ...x, ...over } : x))

describe('needsModel: the hive lists no provider this person can be answered by', () => {
  it('unknown is never "no model": the list not read yet, or an older hive without one', () => {
    expect(needsModel(null)).toBe(false)
    expect(needsModel(undefined)).toBe(false)
  })
  it('a hive as installed, with no key, needs one; the demonstration model and an empty local slot do not count', () => {
    expect(needsModel(bare)).toBe(true)
    expect(needsModel([])).toBe(true)
    expect(needsModel([mock])).toBe(true)
  })
  it('a key this person can pay with opens it, on any keyed provider, proven to answer or not', () => {
    expect(needsModel(withOne('openrouter', { connected: true, configured: true }))).toBe(false)
    expect(needsModel(withOne('anthropic', { connected: true, configured: true, readiness: 'unverified' }))).toBe(false)
    // a key that is failing is still a key: the Ask's own refusal words say what is wrong, not "connect a model"
    expect(needsModel(withOne('openai', { connected: true, configured: true, readiness: 'not_answering' }))).toBe(false)
    // an older hive states only `connected`
    expect(needsModel(withOne('openrouter', { connected: true, configured: undefined }))).toBe(false)
  })
  it('asker pays: a provider the hive says THIS person cannot pay on does not count, whoever else holds its key', () => {
    // the owner's key, as the hive projects it to a member it does not pay for (app.py provider_view)
    expect(needsModel(withOne('openrouter', { connected: false, configured: false, keys: 0, source: null }))).toBe(true)
  })
  it('free inference counts only while the hive offers it to this person with a model and calls a day', () => {
    const free = (over: Partial<ProviderStatus>) => [...bare, p('free', { needs_key: false, connected: true, configured: true, models: ['minimax/minimax-m3.1-flash'], daily_calls: 200, ...over })]
    expect(needsModel(free({}))).toBe(false)
    expect(needsModel(free({ connected: false, configured: false }))).toBe(true)
    expect(needsModel(free({ daily_calls: 0 }))).toBe(true)
    expect(needsModel(free({ models: [] }))).toBe(true)
  })
  it('a plan attached to the hive, or a model on this computer, counts when it lists a model and is not seen failing', () => {
    const plan = (over: Partial<ProviderStatus>) => [...bare, p('subscription-cli', { needs_key: false, connected: true, configured: true, models: ['claude-sonnet-5-5'], ...over })]
    expect(needsModel(plan({}))).toBe(false)
    expect(needsModel(plan({ models: [] }))).toBe(true)
    expect(needsModel(plan({ readiness: 'not_answering' }))).toBe(true)
    expect(needsModel(withOne('local', { models: ['qwen3-14b'] }))).toBe(false)
    expect(needsModel(withOne('local', { models: ['qwen3-14b'], readiness: 'not_answering' }))).toBe(true)
  })
  it('providerUsable never counts the demonstration model, however it is listed', () => {
    expect(providerUsable(p('mock', { needs_key: false, connected: true, configured: true }), [])).toBe(false)
    expect(providerUsable(p('other', { needs_key: false, connected: true, configured: true, test_only: true }), [])).toBe(false)
  })
})

describe('the ask-connect screen', () => {
  it('is one of the screens MeTTa composes, and states only two flags', () => {
    expect(SCREEN_SOURCES.map(([name]) => name)).toContain('ask-connect')
    expect(connectScreen(true, false).facts).toEqual({ flags: { 'ask.needs_model': true, 'ask.held': false } })
    expect(connectScreen(true, true).facts).toEqual({ flags: { 'ask.needs_model': true, 'ask.held': true } })
    expect(connectScreen(false, true).facts).toEqual({ flags: { 'ask.needs_model': false, 'ask.held': false } })
  })
})
