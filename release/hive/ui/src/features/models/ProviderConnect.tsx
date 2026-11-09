import { AnimatePresence, m } from 'framer-motion'
import { useState, type FormEvent } from 'react'
import type { ProviderStatus } from '../../api/types'
import { hsl } from '../../lib/color'
import { cx } from '../../lib/cx'
import { money } from '../../lib/format'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { Button } from '../../ui/primitives'
import { HELP } from './modelUtil'

/**
 * Paste a provider key. It is verified against the provider and kept in the hive; minds and this UI
 * only ever see the last four characters afterwards.
 */
export function ProviderConnect({ provider, hue = 252, onDone, autoFocus, compact }: { provider: ProviderStatus; hue?: number; onDone?: (p: ProviderStatus) => void; autoFocus?: boolean; compact?: boolean }) {
  const setKey = useHive((s) => s.setProviderKey)
  const removeKey = useHive((s) => s.removeProviderKey)
  const [key, setKeyText] = useState('')
  const [busy, setBusy] = useState(false)
  const [replacing, setReplacing] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const help = HELP[provider.name]

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!key.trim() || busy) return
    setBusy(true)
    const p = await setKey(provider.name, key.trim())
    setBusy(false)
    if (p) {
      setKeyText('')
      setReplacing(false)
      onDone?.(p)
    }
  }

  const showForm = !provider.connected || replacing
  return (
    <div className={cx('rounded-2xl border border-line bg-tint/[0.03] p-3', compact ? '' : 'md:p-4')} style={{ boxShadow: `0 20px 50px -30px ${hsl(hue, 100, 60, 0.5)}` }}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl border border-line bg-shade/25" style={provider.connected ? { color: hsl(hue, 100, 78) } : undefined}>
          <Icon name={provider.connected ? 'link' : 'token'} size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="font-display text-[15px] font-semibold">{provider.label}</span>
            <StatusChip provider={provider} />
          </div>
          <p className="mt-0.5 text-[12px] leading-snug text-ink-3">
            {provider.connected ? (
              <>
                Key {provider.key_hint || 'set'}
                {provider.source === 'env' ? ` from ${provider.key_env} in the hive's environment` : ' stored in the hive'}
                {provider.account?.label ? ` · ${provider.account.label}` : ''}
                {provider.account && provider.account.limit != null && provider.account.usage != null ? ` · ${money(provider.account.usage)} of ${money(provider.account.limit)} used` : ''}
              </>
            ) : provider.needs_key ? (
              <>Paste a key to use {provider.label} models. It stays in the hive; minds call through the gateway and never see it.</>
            ) : (
              <>Needs no key.</>
            )}
          </p>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {showForm && provider.needs_key && (
          <m.form
            key="form"
            onSubmit={submit}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                data-autofocus={autoFocus ? '' : undefined}
                autoFocus={autoFocus}
                aria-label={`${provider.label} API key`}
                placeholder={help ? `${help.prefix}…` : 'API key'}
                value={key}
                onChange={(e) => setKeyText(e.target.value)}
                className="min-h-11 min-w-0 flex-1 basis-full sm:basis-0 rounded-xl border border-line bg-shade/25 px-3 font-mono text-[13px] text-ink outline-none placeholder:text-ink-4 focus:border-line-2"
              />
              <Button type="submit" variant="primary" hue={hue} disabled={!key.trim() || busy} icon={busy ? undefined : 'link'}>
                {busy ? 'Checking…' : replacing ? 'Replace' : 'Connect'}
              </Button>
              {replacing && (
                <Button type="button" variant="ghost" onClick={() => (setReplacing(false), setKeyText(''))}>
                  Cancel
                </Button>
              )}
            </div>
            {help && (
              <p className="mt-1.5 text-[11px] text-ink-4">
                Find it at {help.where}.{' '}
                <a href={help.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-ink-3 underline-offset-2 hover:text-ink hover:underline">
                  Open <Icon name="external" size={11} />
                </a>
              </p>
            )}
          </m.form>
        )}
      </AnimatePresence>

      {provider.connected && provider.needs_key && !replacing && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <Button variant="ghost" onClick={() => setReplacing(true)} className="min-h-9 px-3 text-[12.5px]">
            Replace key
          </Button>
          {provider.source === 'stored' &&
            (confirmRemove ? (
              <>
                <Button variant="danger" className="min-h-9 px-3 text-[12.5px]" onClick={async () => (await removeKey(provider.name), setConfirmRemove(false))}>
                  Remove key
                </Button>
                <Button variant="ghost" className="min-h-9 px-3 text-[12.5px]" onClick={() => setConfirmRemove(false)}>
                  Keep
                </Button>
              </>
            ) : (
              <Button variant="ghost" className="min-h-9 px-3 text-[12.5px] text-ink-3" onClick={() => setConfirmRemove(true)}>
                Remove
              </Button>
            ))}
        </div>
      )}
    </div>
  )
}

export function StatusChip({ provider }: { provider: ProviderStatus }) {
  const on = provider.connected
  const color = on ? '#4ade80' : '#8a89b3'
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-tint/[0.04] px-2 py-0.5 text-[11px] font-medium text-ink-2">
      <span className="size-1.5 rounded-full" style={{ background: color, boxShadow: on ? `0 0 8px ${color}` : undefined }} />
      {on ? (provider.local || !provider.needs_key ? 'Ready' : 'Connected') : 'Not connected'}
    </span>
  )
}
