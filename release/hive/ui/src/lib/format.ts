export function money(n: number, opts: { compact?: boolean } = {}): string {
  if (opts.compact && n >= 1000) return `$${(n / 1000).toFixed(1)}K`
  if (n === 0) return '$0'
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n >= 10 && Number.isInteger(n)) return `$${n}`
  if (n < 100) return `$${n.toFixed(2)}`
  return `$${Math.round(n).toLocaleString('en-US')}`
}

export function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}K`
  return Math.round(n).toLocaleString('en-US')
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never'
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}

export function clockTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function modelLabel(id: string): string {
  const name = id.split('/').slice(1).join('/') || id
  return name
}

export const tvText = (f: number, c: number) => `f ${f.toFixed(2)} · c ${c.toFixed(2)}`

/** "in 3h", "in 12m", "in 2d" for future times. */
export function until(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never'
  const s = Math.round((Date.parse(iso) - now) / 1000)
  if (s <= 0) return 'now'
  if (s < 60) return `in ${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `in ${m}m`
  const h = Math.round(m / 60)
  if (h < 36) return `in ${h}h`
  return `in ${Math.round(h / 24)}d`
}

/** Local wall-clock date and time, e.g. "Mon 6 Oct, 09:00". */
export function localWhen(iso: string): string {
  return new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function tokens(n: number | null | undefined): string {
  if (n == null) return '–'
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function seconds(ms: number | null | undefined): string {
  if (ms == null) return '–'
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
}
