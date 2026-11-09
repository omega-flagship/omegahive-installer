import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { connectedPlans, currentPlan } from './plans'
import { SingleScreen } from './SingleScreen'
import type { Run } from './store'
import type { ProviderStatus } from '../../api/types'

const provider = (name: string, over: Partial<ProviderStatus> = {}): ProviderStatus => ({
  name, label: name, local: false, needs_key: false, connected: true, configured: true, readiness: 'unverified', answer_ready: false,
  source: null, keys: 0, key_hint: '', key_env: '', base_url: 'http://127.0.0.1:8011/v1', models: ['invented-model'], ...over,
} as ProviderStatus)
const claude = provider('subscription-cli', { models: ['claude-invented'] })
const chatgpt = provider('subscription-codex', { models: ['gpt-invented'], base_url: 'http://127.0.0.1:8012/v1' })

describe('"Think with your … plan": offered only for a connected subscription, only to the owner', () => {
  it('offers each configured bridge with its first model, Claude first', () => {
    expect(connectedPlans([chatgpt, claude], true)).toEqual([
      { provider: 'subscription-cli', label: 'Think with your Claude plan', model: 'subscription-cli/claude-invented' },
      { provider: 'subscription-codex', label: 'Think with your ChatGPT plan', model: 'subscription-codex/gpt-invented' },
    ])
  })
  it('offers nothing to a member, nothing unconfigured, nothing seen failing, nothing without a model', () => {
    expect(connectedPlans([claude, chatgpt], false)).toEqual([])
    expect(connectedPlans([provider('subscription-cli', { configured: false, connected: false })], true)).toEqual([])
    expect(connectedPlans([provider('subscription-cli', { readiness: 'not_answering' })], true)).toEqual([])
    expect(connectedPlans([provider('subscription-cli', { models: [] })], true)).toEqual([])
    expect(connectedPlans([provider('openai')], true)).toEqual([])
    expect(connectedPlans(null, true)).toEqual([])
  })
  it('knows the plan a mind already thinks with', () => {
    const plans = connectedPlans([claude, chatgpt], true)
    expect(currentPlan('subscription-codex/gpt-invented', plans)?.provider).toBe('subscription-codex')
    expect(currentPlan('openai/x', plans)).toBeNull()
  })
})

const run = (over: Partial<Run> = {}): Run => ({
  id: 1, mode: 'live', path: 'owner', status: 'playing', loadError: null,
  facts: { name: 'Pip', host: 'Pip', mind: { id: 'a_personal', name: 'Wren', status: 'asleep' }, askHow: '', ownKeys: 0, limit: null },
  hello: { hello: null, postedAt: null },
  u1: { context: 'known', model: 'subscription-cli/claude-invented', busy: false, phase: 'editing', error: null, profileSaved: false },
  ...over,
} as unknown as Run)
const render = (r: Run, providers: ProviderStatus[]) => renderToStaticMarkup(createElement(SingleScreen, { run: r, now: 1000, providers }))

describe('the single screen with a connected plan', () => {
  it('shows one tap per plan instead of the disabled sign-in, and marks the one in use', () => {
    const s = render(run(), [claude, chatgpt])
    expect(s).toContain('>Think with your Claude plan<')
    expect(s).toContain('>Think with your ChatGPT plan<')
    expect(s).not.toContain('Sign in with Claude')
    expect(s).not.toContain('Sign in with ChatGPT')
    expect(s).toMatch(/data-u1-plan="subscription-cli"[^>]*aria-pressed="true"/)
    expect(s).toMatch(/data-u1-plan="subscription-codex"[^>]*aria-pressed="false"/)
    expect(s).toContain('Thinking with your Claude plan on this computer')
  })
  it('keeps the other sign-in disabled when only one plan is connected, and offers nothing to a guest', () => {
    const one = render(run({ u1: { context: 'known', model: 'openai/x', busy: false, phase: 'editing', error: null, profileSaved: false } } as Partial<Run>), [chatgpt])
    expect(one).toContain('>Think with your ChatGPT plan<')
    expect(one).toMatch(/disabled=""[^>]*>Sign in with Claude/)
    expect(one).toContain('nothing changes until you choose')
    const guest = render(run({ path: 'guest' } as Partial<Run>), [claude, chatgpt])
    expect(guest).not.toContain('Think with your')
  })
})
