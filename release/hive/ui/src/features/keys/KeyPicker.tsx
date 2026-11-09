import { useEffect } from 'react'
import { hsl } from '../../lib/color'
import { cx } from '../../lib/cx'
import { navigate } from '../../lib/router'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'

/**
 * "Paid by": which key pays for this mind's model calls. The provider's hive default unless a
 * key of its own is picked. Renders nothing for local and offline models.
 */
export function KeyPicker({ provider, value, onChange, hue = 252 }: { provider: string; value?: string; onChange: (key: string | undefined) => void; hue?: number }) {
  const keys = useHive((s) => s.keys)
  const loadKeys = useHive((s) => s.loadKeys)
  useEffect(() => {
    if (!keys) void loadKeys().catch(() => undefined)
  }, [keys, loadKeys])
  if (provider === 'mock' || provider === 'local' || provider === 'ollama') return null
  const mine = (keys ?? []).filter((k) => k.provider === provider)
  const fallback = mine.find((k) => k.default)
  const assigned = value ? mine.find((k) => k.id === value) : undefined

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="eyebrow">Paid by</span>
        <button onClick={() => navigate({ name: 'me' })} className="inline-flex items-center gap-1 text-[11.5px] text-ink-3 hover:text-ink">
          <Icon name="token" size={12} /> Your keys
        </button>
      </div>
      {keys && mine.length === 0 ? (
        <button onClick={() => navigate({ name: 'me' })} className="flex w-full items-center gap-3 rounded-xl border border-dashed border-line px-3 py-2.5 text-left text-[13px] text-ink-2 hover:border-line-2 hover:bg-tint/[0.03]">
          <Icon name="plus" size={15} className="text-ink-3" />
          <span className="min-w-0 flex-1">Add a key for this provider</span>
        </button>
      ) : (
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Key that pays for this mind">
          <Option on={!value} hue={hue} onClick={() => onChange(undefined)} title="Hive default" sub={fallback ? `${fallback.label} ${fallback.hint}` : 'none set'} />
          {mine
            .filter((k) => !k.default || value === k.id)
            .map((k) => (
              <Option key={k.id} on={value === k.id} hue={hue} onClick={() => onChange(k.id)} title={k.label} sub={`${k.hint}${k.env ? ' · environment' : ''}`} />
            ))}
          {mine.filter((k) => k.default && value !== k.id).map((k) => (
            <Option key={k.id} on={false} hue={hue} onClick={() => onChange(k.id)} title={k.label} sub={`${k.hint} · pin it`} />
          ))}
        </div>
      )}
      {value && !assigned && keys && <p className="mt-1.5 text-[11.5px] text-warn">The assigned key is gone. Pick another, or the calls will be refused.</p>}
    </div>
  )
}

function Option({ on, hue, onClick, title, sub }: { on: boolean; hue: number; onClick: () => void; title: string; sub: string }) {
  return (
    <button
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={cx('flex min-h-11 items-center gap-2 rounded-xl border px-3 text-left transition-all', on ? 'bg-tint/[0.08]' : 'border-line bg-tint/[0.02] hover:border-line-2')}
      style={on ? { borderColor: hsl(hue, 90, 70, 0.55), boxShadow: `0 0 0 1px ${hsl(hue, 90, 70, 0.25)} inset` } : undefined}
    >
      <span className={cx('flex size-4 shrink-0 items-center justify-center rounded-full border', on ? 'border-transparent' : 'border-line-2')} style={on ? { background: hsl(hue, 100, 75) } : undefined}>
        {on && <span className="size-1.5 rounded-full bg-primary-ink" />}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[12.5px] text-ink">{title}</span>
        <span className="block truncate font-mono text-[10.5px] text-ink-4">{sub}</span>
      </span>
    </button>
  )
}
