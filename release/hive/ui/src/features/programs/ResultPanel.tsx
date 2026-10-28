import type { ReactNode } from 'react'
import { cx } from '../../lib/cx'
import { resultBasis, type ResultBasis, type ResultDetail } from '../../store/programSession'
import { Icon } from '../../ui/Icon'

/**
 * What an action returned besides its sources, shown as INERT content: text, key/value structure, and code-like
 * strings as plain preformatted text. Nothing returned is ever interpreted as markup or code (React text only: no
 * innerHTML, no eval, no links made from strings). Bound visibly to its action, items, app, swarm and revision.
 */

const MAX_DEPTH = 5
const MAX_LIST = 50
const MAX_TEXT = 6000

const BASIS: Record<ResultBasis, { label: string; why: string; cls: string }> = {
  banked: { label: 'Banked · not run now', why: 'The app says this was recorded or previewed earlier; this action did not run it.', cls: 'border-accent-2/40 bg-accent-2/[0.08] text-accent-2' },
  current: { label: 'Ran now', why: 'The app says this action ran it now.', cls: 'border-good/40 bg-good/[0.08] text-good' },
  unstated: { label: 'Not stated whether this ran now', why: 'The app did not say whether this was run now or recorded earlier; treat it as uncertain.', cls: 'border-warn/40 bg-warn/[0.08] text-warn' },
}

const fieldLabel = (k: string) => {
  const t = k.replace(/[_-]+/g, ' ').trim()
  return t ? t[0].toUpperCase() + t.slice(1) : k
}

/** Code-like: shown preformatted (still as text). */
const codeLike = (s: string) => s.includes('\n') || /^\s*[([{]/.test(s)

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * An example entry's label. Whether it ran now follows the same executed flags as the result-level label: the entry's
 * own `executed_now`/`executed` when it has one, else the result's basis. Only an example that ran now is "tested";
 * a banked or unstated one reports the outcome the app recorded, never a test made now.
 */
function exampleLabel(v: unknown, basis: ResultBasis): { text: string; tone: 'good' | 'bad' | 'info' | 'warn' } {
  const own = isRecord(v) ? resultBasis(v) : 'unstated'
  const ran = own === 'unstated' ? basis : own
  const passed = isRecord(v) && typeof v.passed === 'boolean' ? v.passed : null
  if (ran === 'current') {
    if (passed === true) return { text: 'Tested example · passed', tone: 'good' }
    if (passed === false) return { text: 'Tested example · did not pass', tone: 'bad' }
    return { text: 'Example · ran now, no pass result given', tone: 'info' }
  }
  if (ran === 'banked') {
    if (passed === true) return { text: 'Banked example · recorded as passed', tone: 'info' }
    if (passed === false) return { text: 'Banked example · recorded as not passing', tone: 'bad' }
    return { text: 'Banked example · expected result only', tone: 'info' }
  }
  if (passed === true) return { text: 'Example · reported as passed; not stated whether run now', tone: 'warn' }
  if (passed === false) return { text: 'Example · reported as not passing; not stated whether run now', tone: 'bad' }
  return { text: 'Example · expected result only; not stated whether run now', tone: 'warn' }
}

const TONE = { good: 'border-good/40 text-good', bad: 'border-bad/40 text-bad', info: 'border-accent-2/40 text-accent-2', warn: 'border-warn/40 text-warn' }

function Text({ s }: { s: string }) {
  const cut = s.length > MAX_TEXT
  const shown = cut ? s.slice(0, MAX_TEXT) : s
  return codeLike(s) ? (
    <pre className="thin-scroll max-w-full overflow-x-auto rounded-lg border border-line bg-black/30 px-2.5 py-1.5 font-mono text-[11.5px] leading-snug whitespace-pre text-ink-2">
      {shown}
      {cut && `\n… ${s.length - MAX_TEXT} more characters not shown`}
    </pre>
  ) : (
    <span className="text-[12.5px] leading-snug break-words whitespace-pre-wrap text-ink-2">
      {shown}
      {cut && ` … ${s.length - MAX_TEXT} more characters not shown`}
    </span>
  )
}

function Scalar({ v }: { v: unknown }) {
  if (typeof v === 'string') return <Text s={v} />
  if (v === null || v === undefined) return <span className="font-mono text-[12px] text-ink-4">none</span>
  return <span className="font-mono text-[12px] text-ink-2 tabular-nums">{String(v)}</span>
}

const isScalar = (v: unknown) => v === null || v === undefined || typeof v !== 'object'

/** Any returned value, recursively, as text. */
function Value({ v, depth = 0, examples = false, basis = 'unstated' }: { v: unknown; depth?: number; examples?: boolean; basis?: ResultBasis }): ReactNode {
  if (isScalar(v)) return <Scalar v={v} />
  if (depth >= MAX_DEPTH) return <Text s={JSON.stringify(v, null, 2) ?? ''} />
  if (Array.isArray(v)) {
    if (!v.length) return <span className="text-[12px] text-ink-4">none</span>
    const shown = v.slice(0, MAX_LIST)
    const more = v.length - shown.length
    if (shown.every((x) => isScalar(x) && !(typeof x === 'string' && codeLike(x)))) {
      return (
        <span className="flex flex-wrap gap-1">
          {shown.map((x, i) => (
            <span key={i} className="max-w-full rounded-md border border-line bg-white/[0.03] px-1.5 py-px font-mono text-[11.5px] break-all text-ink-2">
              {x === null || x === undefined ? 'none' : String(x)}
            </span>
          ))}
          {more > 0 && <span className="text-[11.5px] text-ink-4">and {more} more not shown</span>}
        </span>
      )
    }
    return (
      <ol className="space-y-2">
        {shown.map((x, i) => {
          const tag = examples ? exampleLabel(x, basis) : null
          return (
            <li key={i} className="min-w-0 rounded-xl border border-line bg-white/[0.02] p-2.5" data-result-entry={examples ? 'example' : 'entry'}>
              {tag && <span className={cx('mb-1.5 inline-flex rounded-md border px-1.5 py-px text-[10.5px] font-semibold', TONE[tag.tone])}>{tag.text}</span>}
              <Value v={x} depth={depth + 1} basis={basis} />
            </li>
          )
        })}
        {more > 0 && <li className="text-[11.5px] text-ink-4">and {more} more not shown</li>}
      </ol>
    )
  }
  const entries = Object.entries(v as Record<string, unknown>)
  if (!entries.length) return <span className="text-[12px] text-ink-4">none</span>
  return (
    <dl className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-x-3 gap-y-1.5 sm:grid-cols-[minmax(0,9.5rem)_minmax(0,1fr)]">
      {entries.map(([k, x]) => (
        <div key={k} className="contents">
          <dt className="min-w-0 pt-px text-[11.5px] font-medium break-words text-ink-3">{fieldLabel(k)}</dt>
          <dd className="min-w-0">
            <Value v={x} depth={depth + 1} examples={/example/i.test(k)} basis={basis} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

const short = (r: string | null) => (r ? (r.length > 14 ? `${r.slice(0, 8)}…${r.slice(-4)}` : r) : 'unknown')

export function ResultPanel({ result, currentRevision, itemLabel, onClose, className }: { result: ResultDetail; currentRevision: string | null; itemLabel(id: string): string; onClose(): void; className?: string }) {
  const basis = BASIS[result.basis]
  const scalars = result.fields.filter(([, v]) => isScalar(v))
  const compound = result.fields.filter(([, v]) => !isScalar(v))
  const time = new Date(result.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return (
    <section
      className={cx('min-w-0 rounded-2xl border border-accent-2/25 bg-[#0b0b22]/95 p-3 md:p-3.5', className)}
      aria-label={`Returned by the app: ${result.label}`}
      data-tour="program-result"
      data-result-action={result.action}
      data-result-basis={result.basis}
      data-result-stale={result.stale ? 'true' : 'false'}
    >
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[10.5px] font-semibold tracking-[0.1em] text-accent-2 uppercase">Returned by the app</div>
          <h3 className="mt-0.5 text-[14px] leading-snug font-semibold text-ink">{result.label}</h3>
        </div>
        <button onClick={onClose} className="-mr-1 rounded-lg p-1.5 text-ink-3 hover:bg-white/[0.06] hover:text-ink" aria-label="Close what the app returned">
          <Icon name="x" size={15} />
        </button>
      </header>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className={cx('inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-semibold', basis.cls)} title={basis.why}>
          {basis.label}
        </span>
        {result.stale && (
          <span className="inline-flex items-center gap-1 rounded-md border border-warn/40 bg-warn/[0.08] px-1.5 py-0.5 text-[11px] font-semibold text-warn">
            <Icon name="alert" size={12} />
            Out of date
          </span>
        )}
      </div>
      <p className="mt-1.5 text-[11.5px] leading-snug text-ink-3">{basis.why}</p>
      {result.stale && (
        <p className="mt-1.5 rounded-lg border border-warn/25 bg-warn/[0.06] px-2 py-1.5 text-[11.5px] leading-snug text-ink-2" role="note">
          The app's view changed after this was returned (asked at revision <span className="font-mono">{short(result.revision)}</span>, now <span className="font-mono">{short(currentRevision)}</span>). It may no longer hold; run the action again to see the current answer.
        </p>
      )}
      <p className="mt-1.5 text-[11px] leading-snug break-words text-ink-4" data-result-binding>
        For {result.items.length ? result.items.map(itemLabel).join(', ') : 'no item'} · {result.programId} in {result.swarmId} · revision <span className="font-mono">{short(result.revision)}</span> · {time}
      </p>
      {result.message && <p className="mt-2 text-[12.5px] leading-snug whitespace-pre-wrap text-ink-2">{result.message}</p>}
      {scalars.length > 0 && (
        <div className="mt-2.5">
          <Value v={Object.fromEntries(scalars)} depth={1} />
        </div>
      )}
      {compound.map(([k, v]) => {
        const n = Array.isArray(v) ? v.length : null
        const ex = /example/i.test(k)
        return (
          <details key={k} open className="group mt-2.5 min-w-0" data-result-field={k}>
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12px] font-semibold text-ink select-none">
              <Icon name="chevron" size={12} className="shrink-0 text-ink-4 transition-transform group-open:rotate-90" />
              {fieldLabel(k)}
              {n !== null && <span className="font-normal text-ink-4">{n}</span>}
              {ex && result.basis === 'banked' && <span className="rounded-md border border-accent-2/40 px-1 py-px text-[10px] font-semibold text-accent-2">banked</span>}
            </summary>
            <div className="mt-1.5 min-w-0 pl-[18px]">
              <Value v={v} depth={1} examples={ex} basis={result.basis} />
            </div>
          </details>
        )
      })}
    </section>
  )
}
