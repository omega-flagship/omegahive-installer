/** The providers You & your keys can add a key for, and how every key of each one starts. */
export const KEY_PROVIDERS = [
  { name: 'openrouter', label: 'OpenRouter', hue: 262, prefix: 'sk-or-', url: 'https://openrouter.ai/keys' },
  { name: 'anthropic', label: 'Anthropic', hue: 24, prefix: 'sk-ant-', url: 'https://console.anthropic.com/settings/keys' },
  { name: 'openai', label: 'OpenAI', hue: 160, prefix: 'sk-', url: 'https://platform.openai.com/api-keys' },
] as const

export type KeyProvider = (typeof KEY_PROVIDERS)[number]
export type ProviderName = KeyProvider['name']

/**
 * What a key's start says about its provider:
 *  - `known`: the provider with the longest prefix the key starts with. Every key here starts with OpenAI's `sk-`, so
 *    the longest one decides: `sk-ant-…` is Anthropic's and `sk-or-…` OpenRouter's, never OpenAI's;
 *  - `pending`: nothing typed yet, or text that can still grow into a longer prefix (`sk-`, `sk-an`);
 *  - `unknown`: no provider's keys start this way.
 */
export type KeyReading = { kind: 'known'; provider: KeyProvider } | { kind: 'pending' } | { kind: 'unknown' }

/** Reads a key as the form sends it, without the spaces around it. */
export function readKey(key: string): KeyReading {
  const k = key.trim()
  if (KEY_PROVIDERS.some((p) => p.prefix.length > k.length && p.prefix.startsWith(k))) return { kind: 'pending' }
  let best: KeyProvider | undefined
  for (const p of KEY_PROVIDERS) if (k.startsWith(p.prefix) && (!best || p.prefix.length > best.prefix.length)) best = p
  return best ? { kind: 'known', provider: best } : { kind: 'unknown' }
}

/**
 * The key in text a person copied. A key often arrives inside a message ("Here is your key: sk-or-v1-…."), so the one
 * word that starts the way a provider's keys start is the key, without the quotes or stops around it; text that is one
 * long word is a key whose start names no provider. Null when the text holds no key, or two different ones.
 * Time: one pass over the words, n = text length.
 */
export function keyIn(text: string): string | null {
  const words = text.split(/\s+/).map((w) => w.replace(/^[^\w-]+|[^\w-]+$/g, '')).filter(Boolean)
  const named = [...new Set(words.filter((w) => readKey(w).kind === 'known'))]
  if (named.length) return named.length === 1 ? named[0] : null
  return words.length === 1 && words[0].length >= 20 ? words[0] : null
}

/** The separator before item `i` of `n` in a list read as "a, b or c". */
export const orSeparator = (i: number, n: number): string => (i === 0 ? '' : i === n - 1 ? ' or ' : ', ')

const ALL = KEY_PROVIDERS.map((p, i) => orSeparator(i, KEY_PROVIDERS.length) + p.label).join('')

export interface KeyForm {
  /** the provider the key goes to: the one its start names, else the one picked, else none yet */
  provider: KeyProvider | null
  /** the key's start named the provider, so no other can be picked for it */
  fromKey: boolean
  /** a typed key's start names no provider and none is picked: the form asks which */
  ask: boolean
  /** the line under the fields saying which of these holds */
  note: string
}

/** The add-key form's decision for the key typed so far and the provider picked, if any. */
export function keyForm(key: string, picked: ProviderName | null): KeyForm {
  const read = readKey(key)
  if (read.kind === 'known') {
    const p = read.provider
    return { provider: p, fromKey: true, ask: false, note: `${p.label} key, read from how it starts (${p.prefix}).` }
  }
  const provider = KEY_PROVIDERS.find((p) => p.name === picked) ?? null
  if (read.kind === 'unknown') {
    return provider
      ? { provider, fromKey: false, ask: false, note: `Its start does not say which provider it is for, so it goes to ${provider.label}, picked above.` }
      : { provider, fromKey: false, ask: true, note: 'Which provider is this key for? Its start does not say, so pick one above.' }
  }
  return { provider, fromKey: false, ask: false, note: `Paste a key from ${ALL}; how it starts says which.` }
}
