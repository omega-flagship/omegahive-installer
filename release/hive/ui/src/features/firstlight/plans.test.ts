import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { connectedPlans, currentPlan, keyedWays, localModels, modelForKey } from './plans'
import { SingleScreen } from './SingleScreen'
import type { Run } from './store'
import type { ModelOption, ProviderStatus } from '../../api/types'

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
  it('offers only the plan that is connected, no sign-in for the other, and nothing to a guest', () => {
    const one = render(run({ u1: { context: 'known', model: 'openai/x', busy: false, phase: 'editing', error: null, profileSaved: false } } as Partial<Run>), [chatgpt])
    expect(one).toContain('>Think with your ChatGPT plan<')
    expect(one).not.toContain('Sign in with')
    expect(one).toContain('nothing changes until you choose')
    const guest = render(run({ path: 'guest' } as Partial<Run>), [claude, chatgpt])
    expect(guest).not.toContain('Think with your')
  })
})

const option = (id: string, local = false): ModelOption => ({ id, provider: id.split('/')[0], label: id.split('/').slice(1).join('/'), local })

describe('the other ways to think: a key the hive has, a key just pasted, a model on this computer', () => {
  const models = [option('anthropic/claude-opus-5-5'), option('anthropic/claude-sonnet-5-5'), option('openai/gpt-6.1'), option('openai/gpt-5.4'), option('mock/echo', true), option('local/llama-invented', true)]

  it('a key moves the mind onto the remembered default for that provider, else its Sonnet, else its first model', () => {
    expect(modelForKey('anthropic', models, null)).toBe('anthropic/claude-sonnet-5-5')
    expect(modelForKey('openai', models, null)).toBe('openai/gpt-6.1')
    expect(modelForKey('openai', models, 'openai/gpt-5.4')).toBe('openai/gpt-5.4')
    expect(modelForKey('openai', models, 'anthropic/claude-opus-5-5')).toBe('openai/gpt-6.1') // another provider's default
    expect(modelForKey('openrouter', models, null)).toBeNull()
  })

  it('offers each keyed provider that would pay for this person’s mind, owner or not, while it has not been seen failing', () => {
    const keyed = provider('anthropic', { label: 'Anthropic', needs_key: true })
    // the host reads a keyed provider configured to a person, and lists its models, only when it would pay for their
    // mind: for a member of someone else's hive, their own saved key, so a member with a Claude key is offered it
    expect(keyedWays([keyed, claude], models, null)).toEqual([{ provider: 'anthropic', label: 'Anthropic', model: 'anthropic/claude-sonnet-5-5' }])
    for (const providers of [
      [{ ...keyed, configured: false, connected: false }], // nothing would pay for this person's mind with it
      [{ ...keyed, readiness: 'not_answering' as const }],
      [{ ...keyed, test_only: true }],
      [{ ...keyed, name: 'openrouter' }], // configured, but no model of it is listed for this person
    ]) expect(keyedWays(providers, models, null)).toEqual([])
    expect(keyedWays(null, models, null)).toEqual([])
    expect(keyedWays([keyed], null, null)).toEqual([])
  })

  it('lists local models other than the demonstration model, leaving out a provider seen not answering', () => {
    const local = provider('local', { local: true })
    expect(localModels(models, [local]).map((m) => m.id)).toEqual(['local/llama-invented'])
    expect(localModels(models, null).map((m) => m.id)).toEqual(['local/llama-invented'])
    expect(localModels(models, [{ ...local, readiness: 'not_answering' }])).toEqual([])
    expect(localModels(models, [{ ...local, test_only: true }])).toEqual([])
    expect(localModels(null, [local])).toEqual([])
  })
})
