import { useEffect, useId, useRef, useState } from 'react'
import { ApiError } from '../../api/client'
import { useHive } from '../../store/store'
import { KEY_PROVIDERS, keyForm, orSeparator, readKey, type CopiedKey, type ProviderName } from '../keys/keyProvider'
import { addKeyRefusalWords } from '../keys/ownLimit'
import { startingLimitWords } from '../keys/startingLimit'
import { LEAD_PROVIDER } from './plans'

const OTHERS = KEY_PROVIDERS.filter((p) => p !== LEAD_PROVIDER)

/** One press of the card's Paste button: `key`, the key found in what was copied (null: none, more than one, or the
 *  browser would not read it), and `hint`, the line saying what to do next; `n` counts the presses, so pressing again
 *  pastes again. */
export interface Paste { n: number; key: string | null; hint: string }

/** What the field says after a press of Paste, by what the copied text held (keyIn), or `unreadable` when the browser
 *  would not read it: a key whose start names its provider is in; a word whose start names none is in, but it may be
 *  something else that was copied, such as a password, so the person checks it before it goes; more than one key, so
 *  the person copies just one; or no key, with how to paste by hand. `how`: a Mac (or iPad) keyboard, another
 *  keyboard, or a touch screen. */
export function pasteHint(found: CopiedKey['kind'] | 'unreadable', how: 'mac' | 'ctrl' | 'touch'): string {
  if (found === 'named') return 'Your key is in. Press Add key.'
  if (found === 'unnamed') return `Check this is your ${LEAD_PROVIDER.label} key before pressing Add key.`
  if (found === 'several') return 'What you copied has more than one key in it. Copy just the one you want, then press Paste again.'
  const keys = how === 'touch' ? 'Touch and hold the field, then choose Paste.' : `Click the field and press ${how === 'mac' ? '⌘' : 'Ctrl'} and V together.`
  return found === 'none' ? `There's no key in what you copied. Copy the key, then press Paste again, or ${keys.charAt(0).toLowerCase()}${keys.slice(1)}` : keys
}

/**
 * First Light's own key field: it opens inside the card, so the person never leaves the onboarding to add a key. It asks
 * for an OpenRouter key by name, with OpenRouter's keys page and one line on why. A key from another provider still
 * works: its start names its provider (keys/keyProvider, as You & your keys reads it), and a key whose start names none
 * goes to OpenRouter. The key goes through the hive's one add (store addKey, POST /api/keys) and a refusal stays here
 * under the field. `onSaved` gets the saved key's provider, so First Light can carry on to Wake, and the starting monthly
 * limit the hive set with it, in its own words (startingLimitWords, as the pop-up says it), or null when it set none.
 * A key the person already saved in this hive is theirs to think with: the hive refuses to store their own copy twice
 * (POST /api/keys 409 duplicate_key, `own: true`), so that refusal counts as saved, and `onSaved` says it was `held`.
 * As everywhere in First Light there is no form: Enter sends nothing, and the key goes only with the Add key press.
 * `focus`: the person opened it, so the key goes in at once; a field the card opened by itself leaves the name first.
 * `paste`: the card's Paste button was pressed: the key it found goes in the field (a refusal of an earlier key goes),
 * the cursor goes to the field, and the hint says what to do next. The key still goes only with the Add key press.
 */
export function InlineKey({ disabled, focus, paste, onSaved }: { disabled: boolean; focus: boolean; paste: Paste | null; onSaved: (provider: ProviderName, startingLimit: string | null, held: boolean) => void }) {
  const keys = useHive((s) => s.keys)
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  // the hive's refusal stays under the field, and the same refused key is not sent again
  const [refused, setRefused] = useState<{ secret: string; words: string } | null>(null)
  const input = useRef<HTMLInputElement | null>(null)
  // a new press of Paste puts its key in, once (React's pattern for state that follows a prop, set while rendering); its
  // hint stays while the field holds what the press left in it; a field opened later ignores the presses before it
  const [pasteSeen, setPasteSeen] = useState(() => ({ n: paste?.n ?? 0, secret: '' }))
  if (paste && paste.n !== pasteSeen.n) {
    setPasteSeen({ n: paste.n, secret: paste.key ?? secret })
    if (paste.key) {
      setSecret(paste.key)
      setRefused(null)
    }
  }
  useEffect(() => {
    if (paste?.n) input.current?.focus()
  }, [paste?.n])
  const p = keyForm(secret, LEAD_PROVIDER.name).provider ?? LEAD_PROVIDER
  const reading = readKey(secret)
  // said only when the key is not the OpenRouter key the field asks for, so nobody wonders where it went
  const note = reading.kind === 'known' && p !== LEAD_PROVIDER ? `${p.label} key, read from how it starts (${p.prefix}).`
    : reading.kind === 'unknown' ? `Its start doesn’t match any company’s keys, so it goes to ${LEAD_PROVIDER.label}.` : ''
  const noteId = useId()
  const sent = secret.trim()
  const blocked = disabled || busy || !sent || refused?.secret === sent

  const submit = async () => {
    if (blocked) return
    setBusy(true)
    setRefused(null)
    // the first key for a provider becomes its default, as in You & your keys; a later one leaves the default alone
    const hasDefault = (keys ?? []).some((k) => k.provider === p.name && k.default)
    let held = false
    const k = await useHive.getState().addKey({ provider: p.name, key: sent, default: !hasDefault }, (err) => {
      if (err instanceof ApiError && err.code === 'duplicate_key' && err.envelope?.own === true) held = true
      else setRefused({ secret: sent, words: addKeyRefusalWords(err, p.label) })
    })
    setBusy(false)
    if (!k && !held) return
    setSecret('')
    onSaved(p.name, k ? startingLimitWords(k) : null, held)
  }

  return (
    <div className="fl-u1-key" role="group" aria-label={`Paste an ${LEAD_PROVIDER.label} key`} data-fl-inline-key="">
      <label className="fl-field">
        <span>{p.label} key</span>
        <input ref={input} className="fl-input" type="password" autoComplete="off" spellCheck={false} autoFocus={focus} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={`${p.prefix}…`} aria-describedby={noteId} disabled={disabled || busy} />
      </label>
      <p id={noteId} aria-live="polite" className="fl-small">{note}</p>
      {paste && paste.n === pasteSeen.n && secret === pasteSeen.secret && <p role="status" className="fl-small" data-fl-paste-hint="">{paste.hint}</p>}
      {refused && (
        <p role="alert" className="fl-error" data-fl-key-refused="">
          {refused.words}
          {refused.secret === sent ? ' Paste a different key to try again.' : ''}
        </p>
      )}
      <div className="fl-chips">
        <button type="button" className="fl-btn" data-tone="primary" disabled={blocked} onClick={() => void submit()}>{busy ? 'Checking the key…' : 'Add key'}</button>
      </div>
      <p className="fl-small" data-fl-key-lead="">
        One {LEAD_PROVIDER.label} key reaches every model. Get one at <a href={LEAD_PROVIDER.url} target="_blank" rel="noreferrer">{LEAD_PROVIDER.url.replace(/^https:\/\//, '')}</a>.
      </p>
      <p className="fl-small">
        A key from {OTHERS.map((x, i) => orSeparator(i, OTHERS.length) + x.label).join('')} works too; how it starts says which. Every key is checked with the company it’s from before it’s saved.
      </p>
    </div>
  )
}
