import { AnimatePresence, m } from 'framer-motion'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { KeyInfo } from '../../api/types'
import { identityLine } from '../../lib/identity'
import { errorMessage, need, useResource } from '../../lib/useResource'
import { hsl } from '../../lib/color'
import { cx } from '../../lib/cx'
import { money } from '../../lib/format'
import { navigate } from '../../lib/router'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { Page } from '../../ui/Page'
import { Button, EmptyState, ErrorState, Orb, Skeleton, Switch } from '../../ui/primitives'
import { shown } from '../../lib/displayName'
import { ClockPref, LookSection } from '../../shell/LookSection'
import { MemorySection } from './AskMemorySection'
import { PersonalMindLink } from '../mind/PersonalMindLink'
import { useUnsaved } from '../ask/dirty'
import { markSaved } from '../../shell/unsavedWork'
import { DemoAskCard } from './DemoAskCard'
import { addKeyRefusalWords } from './ownLimit'
import { OwnMonthlyLimit } from './OwnMonthlyLimit'
import { GoogleConnectorSettings } from '../settings/GoogleConnectorSettings'
import { PersonNotices } from '../settings/PersonNotices'

const PROVIDERS = [
  { name: 'openrouter', label: 'OpenRouter', hue: 262, prefix: 'sk-or-', url: 'https://openrouter.ai/settings/keys' },
  { name: 'anthropic', label: 'Anthropic', hue: 24, prefix: 'sk-ant-', url: 'https://console.anthropic.com/settings/keys' },
  { name: 'openai', label: 'OpenAI', hue: 160, prefix: 'sk-', url: 'https://platform.openai.com/api-keys' },
]
const hueOf = (provider: string) => PROVIDERS.find((p) => p.name === provider)?.hue ?? 252

/** #/me: you, your keys, and which minds each key pays for. */
export default function ProfilePage() {
  const keys = useHive((s) => s.keys)
  const loadKeys = useHive((s) => s.loadKeys)
  const agents = useHive((s) => s.agents)
  const [adding, setAdding] = useState(false)
  const client = useHive((s) => s.client)
  const me = useResource(() => need(client, 'me', 'Who you are')(), { isEmpty: () => false })
  const [keysError, setKeysError] = useState<unknown>(undefined)
  const reloadKeys = () => {
    setKeysError(undefined)
    loadKeys().catch((e) => setKeysError(e))
  }
  useEffect(() => {
    loadKeys().catch((e) => setKeysError(e))
  }, [loadKeys, client])

  const groups = useMemo(() => {
    const by = new Map<string, KeyInfo[]>()
    for (const k of keys ?? []) by.set(k.provider, [...(by.get(k.provider) ?? []), k])
    return [...by.entries()]
  }, [keys])
  const total = (keys ?? []).reduce((t, k) => t + k.spent_usd, 0)
  const paidMinds = Object.values(agents).filter((a) => !/^(mock|local|ollama)\//.test(a.model)).length

  return (
    <Page title="You & your keys" eyebrow="Profile" label="You & your keys" onClose={() => navigate({ name: 'hive' })}>
      <div className="mx-auto max-w-3xl space-y-8 px-4 pt-2 pb-12 md:px-6">
        <section className="flex items-center gap-4 rounded-2xl border border-line bg-white/[0.03] p-4">
          <Orb hue={150} size={52} />
          <div className="min-w-0 flex-1">
            <div className="font-display text-lg font-semibold">{me.data?.person?.name ?? (me.data?.kind === 'password' ? 'Operator' : 'You')}</div>
            <div className="text-[12.5px] text-ink-3">{identityLine(me)}</div>
          </div>
          <SignOut />
        </section>

        <PersonalMindLink />
        <GoogleConnectorSettings />
        <PersonNotices />
        <LookSection />
        <ClockPref />
        <DemoAskCard />
        <MemorySection />

        <section aria-labelledby="keys-h" data-tour="your-keys">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <h2 id="keys-h" className="eyebrow">
                Your keys
              </h2>
              {keys && keys.length > 0 && (
                <p className="mt-1 text-[12px] text-ink-3">
                  {money(total)} spent through this hive · {paidMinds} mind{paidMinds === 1 ? '' : 's'} on paid models
                </p>
              )}
            </div>
            {!adding && (
              <Button variant="primary" hue={262} icon="plus" onClick={() => setAdding(true)}>
                Add a key
              </Button>
            )}
          </div>

          <AnimatePresence initial={false}>
            {adding && (
              <m.div key="add" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                <AddKey onDone={() => setAdding(false)} />
              </m.div>
            )}
          </AnimatePresence>

          {!keys && keysError !== undefined ? (
            <ErrorState title="Could not load your keys" body={errorMessage(keysError)} onRetry={reloadKeys} />
          ) : !keys ? (
            <div className="space-y-3" aria-busy="true">
              {[0, 1].map((i) => (
                <Skeleton key={i} className="h-28" />
              ))}
            </div>
          ) : keys.length === 0 ? (
            <EmptyState icon="token" title="No keys yet" body="Add an OpenRouter key to give minds every major model, or a key straight from Anthropic or OpenAI." />
          ) : (
            <div className="space-y-6">
              {groups.map(([provider, list]) => (
                <div key={provider}>
                  <div className="mb-2 flex items-center gap-2 px-1 text-[12px] text-ink-3">
                    <span className="size-2 rounded-full" style={{ background: hsl(hueOf(provider), 90, 68) }} />
                    {list[0].provider_label}
                  </div>
                  <div className="space-y-2.5">
                    {list.map((k) => (
                      <KeyCard key={k.id} k={k} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="mt-4 text-[12px] leading-relaxed text-ink-4">
            A key stays inside the hive, readable only by the hive process; only its last four characters are shown. Each provider has a default key that pays for any mind without one of its own. Pick a key for a mind in its Model tab, or when you create it.
          </p>
        </section>
        {/* r1.14b: where Studio's "Set your monthly limit" lands (route 'me'): the own-key monthly total, set here */}
        {me.data?.person && <OwnMonthlyLimit />}
      </div>
    </Page>
  )
}

function AddKey({ onDone }: { onDone: () => void }) {
  const addKey = useHive((s) => s.addKey)
  const keys = useHive((s) => s.keys)
  const [provider, setProvider] = useState('openrouter')
  const [label, setLabel] = useState('')
  const [secret, setSecret] = useState('')
  const [makeDefault, setMakeDefault] = useState(false)
  const [busy, setBusy] = useState(false)
  // r1.14b (Dot, the owner's three 409s): the hive's refusal stays under the form, and the same refused key is not sent again
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
    <form onSubmit={submit} data-unsaved-scope="add-key" className="mb-5 rounded-2xl border border-line bg-white/[0.04] p-4" style={{ boxShadow: `0 24px 60px -34px ${hsl(p.hue, 100, 60, 0.6)}` }}>
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
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name it (e.g. Work, Personal)" aria-label="Key name" maxLength={60} className="min-h-11 rounded-xl border border-line bg-black/25 px-3 text-[14px] text-ink outline-none placeholder:text-ink-4 focus:border-line-2" />
        <input type="password" autoComplete="off" spellCheck={false} autoFocus value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={`${p.prefix}…`} aria-label={`${p.label} API key`} className="min-h-11 rounded-xl border border-line bg-black/25 px-3 font-mono text-[13px] text-ink outline-none placeholder:text-ink-4 focus:border-line-2" />
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

function KeyCard({ k }: { k: KeyInfo }) {
  const updateKey = useHive((s) => s.updateKey)
  const refreshKey = useHive((s) => s.refreshKey)
  const removeKey = useHive((s) => s.removeKey)
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(k.label)
  const [confirm, setConfirm] = useState(false)
  const hue = hueOf(k.provider)
  const assigned = k.minds.filter((x) => x.assigned)
  const acct = k.account

  return (
    <div className="rounded-2xl border border-line bg-white/[0.03] p-3.5" style={k.default ? { borderColor: hsl(hue, 80, 70, 0.35) } : undefined}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl border border-line bg-black/25" style={{ color: hsl(hue, 100, 78) }}>
          <Icon name="token" size={17} />
        </span>
        <div className="min-w-0 flex-1">
          {editing ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault()
                if (label.trim() && label.trim() !== k.label) await updateKey(k.id, { label: label.trim() })
                setEditing(false)
              }}
              className="flex gap-1.5"
            >
              <input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} onBlur={() => setEditing(false)} aria-label="Key name" maxLength={60} className="min-h-9 min-w-0 flex-1 rounded-lg border border-line-2 bg-black/30 px-2 text-[14px] text-ink outline-none" />
            </form>
          ) : (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <button disabled={k.env} onClick={() => (setLabel(k.label), setEditing(true))} className="truncate text-left font-display text-[15px] font-semibold enabled:hover:underline" title={k.env ? undefined : 'Rename'}>
                {k.label}
              </button>
              <span className="font-mono text-[11.5px] text-ink-4">{k.hint}</span>
              {k.default && (
                <span className="rounded-full border px-2 py-0.5 text-[10.5px] font-semibold" style={{ color: hsl(hue, 100, 80), borderColor: hsl(hue, 80, 70, 0.4), background: hsl(hue, 90, 60, 0.12) }}>
                  Hive default
                </span>
              )}
              {k.env && <span className="rounded-full border border-line px-2 py-0.5 text-[10.5px] text-ink-3">environment</span>}
            </div>
          )}
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-ink-3">
            <span>
              <span className="text-ink-2">{money(k.spent_usd)}</span> through this hive
            </span>
            {acct && !acct.error && acct.usage != null && (
              <span>
                {money(acct.usage)} used on the account{acct.limit != null ? ` of ${money(acct.limit)}` : ', no limit'}
              </span>
            )}
            {acct?.error && <span className="text-warn">{acct.error}</span>}
          </div>
        </div>
        <button onClick={() => void refreshKey(k.id)} aria-label="Check the key and its credits" title="Check credits" className="flex size-9 items-center justify-center rounded-lg text-ink-3 hover:bg-white/[0.06] hover:text-ink">
          <Icon name="reset" size={15} />
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <span className="text-[11.5px] text-ink-4">Pays for</span>
        {k.minds.length === 0 ? (
          <span className="text-[12px] text-ink-3">no minds yet</span>
        ) : (
          k.minds.map((x) => (
            <button key={x.id} onClick={() => navigate({ name: 'dot', id: x.id, tab: 'model' })} title={`${x.name}${x.assigned ? '' : ' (as the default)'}`} className={cx('flex min-h-8 items-center gap-1.5 rounded-full border px-2 text-[12px]', x.assigned ? 'border-line-2 text-ink' : 'border-dashed border-line text-ink-3')}>
              <Orb hue={x.hue} status={x.status} size={14} />
              {shown(x.name)}
            </button>
          ))
        )}
        <div className="flex-1" />
        {!k.env && !k.default && (
          <Button variant="ghost" className="min-h-9 px-3 text-[12.5px]" onClick={() => void updateKey(k.id, { default: true })}>
            Make default
          </Button>
        )}
        {!k.env &&
          (confirm ? (
            <>
              <Button variant="danger" className="min-h-9 px-3 text-[12.5px]" onClick={async () => (await removeKey(k.id), setConfirm(false))}>
                Remove{assigned.length ? `, move ${assigned.length} to default` : ''}
              </Button>
              <Button variant="ghost" className="min-h-9 px-3 text-[12.5px]" onClick={() => setConfirm(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button variant="ghost" className="min-h-9 px-3 text-[12.5px] text-ink-3" onClick={() => setConfirm(true)}>
              Remove
            </Button>
          ))}
      </div>
    </div>
  )
}

/**
 * Sign out of this hive. The live client tells the hive to end the session (bearer and sign-in cookie) and waits for it
 * briefly; the app then shows the sign-in screen. The page moves to the hive first, so the next person never lands on
 * the previous person's profile.
 */
export function SignOut() {
  const client = useHive((s) => s.client)
  const [busy, setBusy] = useState(false)
  if (!client) return null
  const signOut = async () => {
    if (busy) return
    setBusy(true)
    try {
      await signOutNow(client, navigate)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button variant="ghost" onClick={() => void signOut()} disabled={busy} aria-busy={busy || undefined}>
      <Icon name="logout" size={15} />
      {busy ? 'Signing out…' : 'Sign out'}
    </Button>
  )
}

/** The sign-out itself: leave the profile first, then end the session (awaited where the client waits for the hive). */
export async function signOutNow(client: { logout(): void | Promise<void> }, go: (r: { name: 'hive' }) => void): Promise<void> {
  go({ name: 'hive' })
  await client.logout()
}
