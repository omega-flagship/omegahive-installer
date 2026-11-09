import { m } from 'framer-motion'
import { useState, type FormEvent } from 'react'
import { hsl } from '../../lib/color'
import { cx } from '../../lib/cx'
import { markSaved } from '../../shell/unsavedWork'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { Button, Switch } from '../../ui/primitives'
import { useUnsaved } from '../ask/dirty'
import { addKeyRefusalWords } from './ownLimit'

/**
 * The You page's island (profile.metta places it): the form for adding a key. It stays the page's own because what is
 * pasted, and the name typed for it, must never enter the page's data, yet the form needs them as they are typed: to mark
 * the page unsaved, and to refuse sending a key the hive has just refused again.
 */
const PROVIDERS = [
  { name: 'openrouter', label: 'OpenRouter', hue: 262, prefix: 'sk-or-', url: 'https://openrouter.ai/settings/keys' },
  { name: 'anthropic', label: 'Anthropic', hue: 24, prefix: 'sk-ant-', url: 'https://console.anthropic.com/settings/keys' },
  { name: 'openai', label: 'OpenAI', hue: 160, prefix: 'sk-', url: 'https://platform.openai.com/api-keys' },
]

/** The form, opening in place. */
export function AddKeyPanel({ onDone }: { onDone: () => void }) {
  return (
    <m.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="overflow-hidden">
      <AddKey onDone={onDone} />
    </m.div>
  )
}

export function AddKey({ onDone }: { onDone: () => void }) {
  const addKey = useHive((s) => s.addKey)
  const keys = useHive((s) => s.keys)
  const [provider, setProvider] = useState('openrouter')
  const [label, setLabel] = useState('')
  const [secret, setSecret] = useState('')
  const [makeDefault, setMakeDefault] = useState(false)
  const [busy, setBusy] = useState(false)
  // r1.14b (Dot, Jon's three 409s): the hive's refusal stays under the form, and the same refused key is not sent again
  const [refused, setRefused] = useState<{ secret: string; words: string } | null>(null)
  // a key being added lives only here until it is saved: a reload or a proposed move must not drop it
  useUnsaved(!!secret.trim() || !!label.trim())
  const p = PROVIDERS.find((x) => x.name === provider)!
  const hasDefault = (keys ?? []).some((k) => k.provider === provider && k.default)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!secret.trim() || busy || refused?.secret === secret.trim()) return
    setBusy(true)
    setRefused(null)
    const sent = secret.trim()
    const k = await addKey({ provider, key: sent, label: label.trim() || undefined, default: hasDefault ? makeDefault : true }, (err) => setRefused({ secret: sent, words: addKeyRefusalWords(err, p.label) }))
    setBusy(false)
    if (!k) return
    markSaved('add-key') // the hive accepted the key: its label and key are saved
    onDone()
  }

  return (
    <form onSubmit={submit} data-unsaved-scope="add-key" className="mb-5 rounded-2xl border border-line bg-tint/[0.04] p-4" style={{ boxShadow: `0 24px 60px -34px ${hsl(p.hue, 100, 60, 0.6)}` }}>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Provider">
        {PROVIDERS.map((x) => (
          <button
            key={x.name}
            type="button"
            role="radio"
            aria-checked={provider === x.name}
            onClick={() => setProvider(x.name)}
            className={cx('flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium', provider === x.name ? 'text-ink' : 'border-line text-ink-3 hover:text-ink-2')}
            style={provider === x.name ? { borderColor: hsl(x.hue, 90, 70, 0.6), background: hsl(x.hue, 90, 60, 0.14) } : undefined}
          >
            {x.label}
          </button>
        ))}
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-[1fr_1.4fr]">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name it (e.g. Work, Personal)" aria-label="Key name" maxLength={60} className="min-h-11 rounded-xl border border-line bg-shade/25 px-3 text-[14px] text-ink outline-none placeholder:text-ink-4 focus:border-line-2" />
        <input type="password" autoComplete="off" spellCheck={false} autoFocus value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={`${p.prefix}…`} aria-label={`${p.label} API key`} className="min-h-11 rounded-xl border border-line bg-shade/25 px-3 font-mono text-[13px] text-ink outline-none placeholder:text-ink-4 focus:border-line-2" />
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        {hasDefault ? (
          <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
            <Switch checked={makeDefault} onChange={setMakeDefault} label="Make it the hive default" hue={p.hue} />
            Make it the {p.label} default
          </label>
        ) : (
          <span className="text-[12px] text-ink-3">It becomes the {p.label} default.</span>
        )}
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" hue={p.hue} disabled={!secret.trim() || busy || refused?.secret === secret.trim()} icon={busy ? undefined : 'check'}>
            {busy ? 'Checking…' : 'Add key'}
          </Button>
        </div>
      </div>
      {refused && (
        <p role="alert" className="mt-3 text-[12.5px] text-bad" data-add-key-refused="">
          {refused.words}
          {refused.secret === secret.trim() ? ' Paste a different key to try again.' : ''}
        </p>
      )}
      <p className="mt-2 text-[11px] text-ink-4">
        The key is checked with {p.label} before it is saved.{' '}
        <a href={p.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-ink-3 hover:text-ink hover:underline">
          Get a key <Icon name="external" size={11} />
        </a>
      </p>
    </form>
  )
}
