import { useEffect, useState } from 'react'
import { ApiError } from '../../../api/client'
import { cx } from '../../../lib/cx'
import { Icon } from '../../../ui/Icon'
import { useWidth } from '../useWidth'
import type { PcFigure } from './model'

/**
 * "Reported figures" on a recorded research report (lab-figures r1; Design, SURFACE_SAVED_RENDER_REVIEW_20261012):
 * producer content shown with the claim, one figure at a time, its caption verbatim. Desktop: a contained preview.
 * Phone: a short summary and "Open full-size figure". A figure is never a verdict, a run or a qualification.
 *
 * Bytes are read through the client with the session in the Authorization header (never in a URL), checked against
 * the figure's sha256, and shown from a blob: URL that is revoked on unmount and when the identity epoch changes.
 * A read that fails (401, 404, network, wrong bytes) keeps the figure's identity and says it is not available here.
 */

export type FigureFetcher = (readUrl: string) => Promise<Blob>
export type FigureLoad = { status: 'loading' } | { status: 'ready'; url: string } | { status: 'unavailable'; why: string }

export const FIGURE_COPY = {
  title: 'Reported figures',
  unavailable: 'Figure not available here',
  open: 'Open full-size figure',
  close: 'Close full-size figure',
  loading: 'Reading the figure…',
} as const

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')

/** Why a figure read failed, in words; the figure itself stays named. */
export function figureFailure(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return 'you are signed out'
    if (e.status === 404) return 'not found, or not shared with you'
    if (e.status === 0) return 'the hive could not be reached'
    return `the hive answered ${e.status}`
  }
  return e instanceof Error && e.message ? e.message : 'it could not be read'
}

/** Reads one figure for one identity epoch; the blob: URL lives exactly as long as that read is current. */
export function useFigure(fig: PcFigure, fetcher: FigureFetcher | null, identity: string): FigureLoad {
  const key = `${identity}|${fig.sha256}|${fig.readUrl ?? ''}`
  const [got, setGot] = useState<{ key: string; load: FigureLoad } | null>(null)
  const url = fig.readUrl
  useEffect(() => {
    if (!url || !fetcher) return
    let alive = true
    let made: string | null = null
    fetcher(url)
      .then(async (blob) => {
        const digest = hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))
        if (digest !== fig.sha256) return { status: 'unavailable', why: 'its bytes do not match the recorded sha256' } as FigureLoad
        if (!alive) return null
        made = URL.createObjectURL(blob.type === 'image/png' ? blob : new Blob([blob], { type: 'image/png' }))
        return { status: 'ready', url: made } as FigureLoad
      })
      .catch((e: unknown) => ({ status: 'unavailable', why: figureFailure(e) }) as FigureLoad)
      .then((load) => {
        if (alive && load) setGot({ key, load })
      })
    return () => {
      alive = false
      if (made) URL.revokeObjectURL(made)
    }
  }, [url, fetcher, key, fig.sha256])
  if (!url) return { status: 'unavailable', why: 'the host gave no read route for it' }
  if (!fetcher) return { status: 'unavailable', why: 'this hive cannot read figures' }
  return got && got.key === key ? got.load : { status: 'loading' }
}

const firstLine = (s: string) => s.split('\n')[0]
const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`)

export function FiguresSection({ figures, fetcher, identity }: { figures: PcFigure[]; fetcher: FigureFetcher | null; identity: string }) {
  const [at, setAt] = useState(0)
  const [ref, width] = useWidth<HTMLElement>()
  if (!figures.length) return null
  const i = Math.min(at, figures.length - 1)
  // width 0 is "not measured yet" (and static markup): the desktop layout
  const narrow = width > 0 && width < 560
  return (
    <section ref={ref} data-pc-figures={figures.length} aria-labelledby="pc-figures-title" className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h4 id="pc-figures-title" className="text-[11.5px] font-semibold text-ink-3">
          {FIGURE_COPY.title}
        </h4>
        {figures.length > 1 && (
          <span className="flex items-center gap-1 text-[11.5px] text-ink-4">
            <button type="button" data-pc-figure-prev disabled={i === 0} onClick={() => setAt(i - 1)} aria-label="Previous figure" className="flex size-8 items-center justify-center rounded-lg hover:bg-white/[0.06] disabled:opacity-40">
              <Icon name="chevron" size={13} className="rotate-180" />
            </button>
            <span data-pc-figure-pos>
              Figure {i + 1} of {figures.length}
            </span>
            <button type="button" data-pc-figure-next disabled={i === figures.length - 1} onClick={() => setAt(i + 1)} aria-label="Next figure" className="flex size-8 items-center justify-center rounded-lg hover:bg-white/[0.06] disabled:opacity-40">
              <Icon name="chevron" size={13} />
            </button>
          </span>
        )}
      </div>
      <FigureCard key={`${identity}|${figures[i].sha256}`} fig={figures[i]} fetcher={fetcher} identity={identity} narrow={narrow} />
    </section>
  )
}

function FigureCard({ fig, fetcher, identity, narrow }: { fig: PcFigure; fetcher: FigureFetcher | null; identity: string; narrow: boolean }) {
  const load = useFigure(fig, fetcher, identity)
  const [full, setFull] = useState(false)
  return (
    <figure data-pc-figure={fig.sha256} data-pc-figure-state={load.status} className="m-0 rounded-xl border border-line p-3" style={{ background: 'var(--lab-tile-empty)' }}>
      {load.status === 'unavailable' ? (
        <p data-pc-figure-unavailable role="note" className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[12.5px] text-ink-3">
          <b className="font-semibold text-ink-2">{FIGURE_COPY.unavailable}</b> ({load.why}).
        </p>
      ) : load.status === 'loading' ? (
        <p data-pc-figure-loading role="status" className="rounded-lg px-3 py-4 text-center text-[12px] text-ink-4">
          {FIGURE_COPY.loading}
        </p>
      ) : narrow ? (
        <div className="space-y-2">
          <p data-pc-figure-summary className="text-[12.5px] text-ink-2">
            {firstLine(fig.caption)} <span className="text-ink-4">· PNG {fig.width} × {fig.height}</span>
          </p>
          <button type="button" data-pc-figure-open aria-expanded={full} onClick={() => setFull((v) => !v)} className="min-h-10 rounded-xl border border-line px-3 text-[12.5px] font-medium text-accent hover:border-line-2">
            {full ? FIGURE_COPY.close : FIGURE_COPY.open}
          </button>
          {full && (
            <div data-pc-figure-full className="overflow-x-auto rounded-lg bg-black/20">
              <img src={load.url} alt={fig.caption} width={fig.width || undefined} height={fig.height || undefined} className="block max-w-none" />
            </div>
          )}
        </div>
      ) : (
        <div className="flex justify-center rounded-lg bg-black/20 p-2">
          <img data-pc-figure-img src={load.url} alt={fig.caption} className="block h-auto max-h-[420px] w-auto max-w-full object-contain" />
        </div>
      )}
      <figcaption className="mt-2 max-w-[72ch] space-y-1">
        <p data-pc-figure-caption className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-2">
          {fig.caption}
        </p>
        <p className={cx('text-[11px] text-ink-4')}>
          {fig.mime === 'image/png' ? 'PNG' : fig.mime} · {fig.width} × {fig.height} · {size(fig.bytes)} · sha256 <span className="font-mono">{fig.sha256.slice(0, 12)}…</span>
          {fig.sourceLocator ? (
            <>
              {' '}
              · source (recorded, not fetched): <span className="font-mono break-all">{fig.sourceLocator}</span>
            </>
          ) : null}
        </p>
      </figcaption>
    </figure>
  )
}
