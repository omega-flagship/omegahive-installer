import { m } from 'framer-motion'
import { Fragment, useId, useState, type FormEvent } from 'react'
import { hsl } from '../../lib/color'
import { cx } from '../../lib/cx'
import { adminViewOf, useMe } from '../../lib/useAdmin'
import { markSaved } from '../../shell/unsavedWork'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { Button, Switch } from '../../ui/primitives'
import { useUnsaved } from '../ask/dirty'
import { keyDefault } from './keyDefault'
import { KEY_PROVIDERS, keyForm, orSeparator, type ProviderName } from './keyProvider'
import { addKeyRefusalWords } from './ownLimit'

/**
 * The You page's island (profile.metta places it): the form for adding a key. It stays the page's own because what is
 * pasted, and the name typed for it, must never enter the page's data, yet the form needs them as they are typed: to mark
 * the page unsaved, and to refuse sending a key the hive has just refused again.
 */

/** The form, opening in place. */
export function AddKeyPanel({ onDone }: { onDone: () => void }) {
  return (
    <m.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="overflow-hidden">
      <AddKey onDone={onDone} />
    </m.div>
  )
}

/**
 * Adds a key. The provider is read from how the key starts (keyProvider.ts), so a pasted key needs no provider
 * picked first; the form asks which provider only for a key whose start names none.
 */
export function AddKey({ onDone }: { onDone: () => void }) {
  const addKey = useHive((s) => s.addKey)
  const keys = useHive((s) => s.keys)
  const [picked, setPicked] = useState<ProviderName | null>(null)
  const [label, setLabel] = useState('')
  const [secret, setSecret] = useState('')
  const [makeDefault, setMakeDefault] = useState(false)
  const [busy, setBusy] = useState(false)
  // r1.14b (Dot, Jon's three 409s): the hive's refusal stays under the form, and the same refused key is not sent again
  const [refused, setRefused] = useState<{ secret: string; words: string } | null>(null)
  // a key being added lives only here until it is saved: a reload or a proposed move must not drop it
  useUnsaved(!!secret.trim() || !!label.trim())
  const { provider: p, fromKey, ask, note } = keyForm(secret, picked)
  const noteId = useId()
  // before a provider is known, the colour of the page's own Add a key button
  const hue = p?.hue ?? 262
  const hasDefault = !!p && (keys ?? []).some((k) => k.provider === p.name && k.default)
  // a member (and anyone while /me loads) adds their own key: only an admin sets the hive default (keyDefault.ts)
  const { me, loaded } = useMe()
  const dflt = keyDefault({ admin: adminViewOf({ me, loaded }), hasDefault, makeDefault })

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!secret.trim() || !p || busy || refused?.secret === secret.trim()) return
    setBusy(true)
    setRefused(null)
    const sent = secret.trim()
    const k = await addKey({ provider: p.name, key: sent, label: label.trim() || undefined, default: dflt.send }, (err) => setRefused({ secret: sent, words: addKeyRefusalWords(err, p.label) }))
    setBusy(false)
    if (!k) return
    markSaved('add-key') // the hive accepted the key: its label and key are saved
    onDone()
  }

  const link = (x: { url: string }, text: string) => (
    <a href={x.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-ink-3 hover:text-ink hover:underline">
      {text} <Icon name="external" size={11} />
    </a>
  )

  return (
    <form onSubmit={submit} data-unsaved-scope="add-key" className="mb-5 rounded-2xl border border-line bg-tint/[0.04] p-4" style={{ boxShadow: `0 24px 60px -34px ${hsl(hue, 100, 60, 0.6)}` }}>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Provider" aria-describedby={noteId}>
        {KEY_PROVIDERS.map((x) => {
          const on = p?.name === x.name
          return (
            <button
              key={x.name}
              type="button"
              role="radio"
              aria-checked={on}
              // a key whose start names its provider settles it: no other provider can be picked for that key
              disabled={fromKey && !on}
              onClick={() => setPicked(x.name)}
              className={cx('flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium disabled:opacity-45', on ? 'text-ink' : 'border-line text-ink-3 enabled:hover:text-ink-2')}
              style={on ? { borderColor: hsl(x.hue, 90, 70, 0.6), background: hsl(x.hue, 90, 60, 0.14) } : undefined}
            >
              {x.label}
            </button>
          )
        })}
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-[1fr_1.4fr]">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name it (e.g. Work, Personal)" aria-label="Key name" maxLength={60} className="min-h-11 rounded-xl border border-line bg-shade/25 px-3 text-[14px] text-ink outline-none placeholder:text-ink-4 focus:border-line-2" />
        <input type="password" autoComplete="off" spellCheck={false} autoFocus value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={p ? `${p.prefix}…` : 'Paste the key'} aria-label={p ? `${p.label} API key` : 'API key'} aria-describedby={noteId} className="min-h-11 rounded-xl border border-line bg-shade/25 px-3 font-mono text-[13px] text-ink outline-none placeholder:text-ink-4 focus:border-line-2" />
      </div>
      <p id={noteId} aria-live="polite" className={cx('mt-2 text-[12px]', ask ? 'text-warn' : 'text-ink-3')}>
        {note}
      </p>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        {p &&
          (dflt.choose ? (
            <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
              <Switch checked={makeDefault} onChange={setMakeDefault} label="Make it the hive default" hue={p.hue} />
              Make it the {p.label} default
            </label>
          ) : dflt.send ? (
            <span className="text-[12px] text-ink-3">It becomes the {p.label} default.</span>
          ) : (
            <span className="text-[12px] text-ink-3">It is your own {p.label} key.</span>
          ))}
        <div className="ml-auto flex gap-2">
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" hue={hue} disabled={!secret.trim() || !p || busy || refused?.secret === secret.trim()} icon={busy ? undefined : 'check'}>
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
        {p ? (
          <>
            The key is checked with {p.label} before it is saved. {link(p, 'Get a key')}
          </>
        ) : (
          <>
            The key is checked with its provider before it is saved. Get a key from{' '}
            {KEY_PROVIDERS.map((x, i) => (
              <Fragment key={x.name}>
                {orSeparator(i, KEY_PROVIDERS.length)}
                {link(x, x.label)}
              </Fragment>
            ))}
            .
          </>
        )}
      </p>
    </form>
  )
}
