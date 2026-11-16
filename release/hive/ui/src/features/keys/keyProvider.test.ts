/**
 * You & your keys reads a pasted key's provider from how the key starts, and asks which provider only for a key whose
 * start names none. Every key here is INVENTED, shaped like its provider's keys.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { KEY_PROVIDERS, keyForm, keyIn, readKey } from './keyProvider'

// AddKey reads the store through the hook (invented: a hive with no keys yet); the rest of the store is the real one
vi.mock('../../store/store', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../store/store')>()
  return { ...real, useHive: Object.assign((sel: (s: unknown) => unknown) => sel({ keys: [], addKey: async () => null }), real.useHive) }
})

const { AddKey } = await import('./AddKeyForm')

/** The provider's name, or the reading's kind when it names none. */
const read = (key: string) => {
  const r = readKey(key)
  return r.kind === 'known' ? r.provider.name : r.kind
}

const SHAPED: Record<string, string[]> = {
  openrouter: ['sk-or-v1-' + '0a9f'.repeat(16)],
  anthropic: ['sk-ant-api03-' + 'Ab9_'.repeat(23) + '-AAAA', 'sk-ant-admin01-' + 'Qx7-'.repeat(20)],
  openai: ['sk-proj-' + 'Zz09'.repeat(30), 'sk-svcacct-' + 'q8W_'.repeat(25), 'sk-admin-' + 'r5Tt'.repeat(20), 'sk-' + 'A1b2'.repeat(12)],
}

/** Seeded random key tails (a 32-bit linear congruential generator), so every run checks the same ones. */
function tails(seed: number, count: number): string[] {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let x = seed >>> 0
  const next = () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0)
  return Array.from({ length: count }, () => Array.from({ length: 1 + (next() % 60) }, () => chars[next() % chars.length]).join(''))
}
const TAILS = tails(0x5eed, 600)
/** True when `t` begins, or could still grow into, the rest of a longer prefix after `sk-`. */
const startsLonger = (t: string) => ['or-', 'ant-'].some((rest) => t.startsWith(rest) || rest.startsWith(t))

describe('a key’s provider, read from how it starts', () => {
  it('names the provider of keys shaped like each provider’s', () => {
    for (const [provider, keys] of Object.entries(SHAPED)) for (const key of keys) expect(read(key), key).toBe(provider)
  })
  it('sk-ant- and sk-or- keys are Anthropic’s and OpenRouter’s whatever follows, though they also start with OpenAI’s sk-', () => {
    for (const t of TAILS) {
      expect(read('sk-ant-' + t)).toBe('anthropic')
      expect(read('sk-or-' + t)).toBe('openrouter')
    }
  })
  it('any other key starting sk- is OpenAI’s', () => {
    const rest = TAILS.filter((t) => !startsLonger(t))
    expect(rest.length).toBeGreaterThan(500)
    for (const t of rest) expect(read('sk-' + t), 'sk-' + t).toBe('openai')
  })
  it('ignores spaces and a line break around a pasted key', () => {
    expect(read(`  ${SHAPED.anthropic[0]}\n`)).toBe('anthropic')
    expect(read(`\t${SHAPED.openrouter[0]} `)).toBe('openrouter')
  })
  it('waits while the text could still become a longer prefix', () => {
    for (const k of ['', '   ', 's', 'sk', 'sk-', 'sk-o', 'sk-or', 'sk-a', 'sk-an', 'sk-ant']) expect(read(k), JSON.stringify(k)).toBe('pending')
  })
  it('names no provider for a key none of them starts like, case included', () => {
    for (const k of ['AIzaSyEXAMPLE000', 'gsk_EXAMPLE000', 'xai-' + 'EXAMPLE000', 'SK-ANT-API03-EXAMPLE', 'Sk-or-v1-EXAMPLE', 'key-sk-ant-EXAMPLE', 'skant-EXAMPLE'])
      expect(read(k), k).toBe('unknown')
    for (const t of TAILS.filter((t) => t[0] !== 's')) expect(read(t), t).toBe('unknown')
  })
  it('typing a key one character at a time never names another provider on the way', () => {
    for (const [provider, keys] of Object.entries(SHAPED))
      for (const key of keys) for (let i = 0; i <= key.length; i++) expect(['pending', provider], key.slice(0, i)).toContain(read(key.slice(0, i)))
  })
})

describe('the key in text a person copied', () => {
  const every = Object.values(SHAPED).flat()
  const messages: ((k: string) => string)[] = [(k) => `Here is your key: ${k}.`, (k) => `"${k}"`, (k) => `(${k}), thanks`, (k) => `chave:\n${k}\nobrigada!`, (k) => `${k} ${k}`]
  it('is the text itself when it is one key, without the spaces and line breaks around it', () => {
    for (const k of every) {
      expect(keyIn(k)).toBe(k)
      expect(keyIn(` \n${k}\t`)).toBe(k)
    }
  })
  it('is the one key inside a message, without the quotes and stops around it, whatever its tail', () => {
    for (const k of [...every, ...TAILS.map((t) => 'sk-or-' + t), ...TAILS.map((t) => 'sk-ant-' + t)])
      for (const say of messages) expect(keyIn(say(k)), say(k)).toBe(k)
  })
  it('is one long word whose start names no provider', () => {
    expect(keyIn('AIzaSyEXAMPLE0000000000000')).toBe('AIzaSyEXAMPLE0000000000000')
  })
  it('is none for words with no key, a short word, a bare prefix, or two different keys', () => {
    for (const t of ['', '   ', 'lunch at noon', 'hello', 'see sk-', 'abc123', `${SHAPED.openrouter[0]} ${SHAPED.anthropic[0]}`]) expect(keyIn(t), t).toBeNull()
  })
})

describe('the add-key form asks for a provider only when the key’s start names none', () => {
  const anthropic = KEY_PROVIDERS.find((p) => p.name === 'anthropic')
  const openai = KEY_PROVIDERS.find((p) => p.name === 'openai')
  it('opens with no provider and asks nothing', () => {
    expect(keyForm('', null)).toEqual({ provider: null, fromKey: false, ask: false, note: 'Paste a key from OpenRouter, Anthropic or OpenAI; how it starts says which.' })
  })
  it('a pasted key’s start chooses its provider, over one picked before', () => {
    for (const picked of [null, 'openrouter', 'openai'] as const)
      expect(keyForm(SHAPED.anthropic[0], picked)).toEqual({ provider: anthropic, fromKey: true, ask: false, note: 'Anthropic key, read from how it starts (sk-ant-).' })
  })
  it('a key whose start names no provider is asked about until one is picked, and then goes to that one', () => {
    expect(keyForm('AIzaSyEXAMPLE000', null)).toEqual({ provider: null, fromKey: false, ask: true, note: 'Which provider is this key for? Its start does not say, so pick one above.' })
    expect(keyForm('AIzaSyEXAMPLE000', 'openai')).toEqual({ provider: openai, fromKey: false, ask: false, note: 'Its start does not say which provider it is for, so it goes to OpenAI, picked above.' })
  })
  it('a pick stands while the key is empty or still being typed', () => {
    expect(keyForm('', 'anthropic').provider).toBe(anthropic)
    expect(keyForm('sk-', 'openai')).toMatchObject({ provider: openai, fromKey: false, ask: false })
  })
  it('first draws no provider chosen, a field named API key, Add key off and every provider’s Get a key link', () => {
    const html = renderToStaticMarkup(createElement(AddKey, { onDone: () => undefined }))
    expect(html.match(/role="radio" aria-checked="false"/g)).toHaveLength(KEY_PROVIDERS.length)
    expect(html).not.toMatch(/aria-checked="true"/)
    expect(html).toMatch(/aria-label="API key"/)
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/)
    expect(html).toContain('Paste a key from OpenRouter, Anthropic or OpenAI; how it starts says which.')
    for (const p of KEY_PROVIDERS) expect(html).toContain(`href="${p.url}"`)
  })
})
