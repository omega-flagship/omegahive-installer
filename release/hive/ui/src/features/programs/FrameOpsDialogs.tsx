import { createPortal } from 'react-dom'
import { useEffect, useId, useMemo, useRef } from 'react'
import { useEscape } from '../../lib/hooks'
import { shown } from '../../lib/displayName'
import { urlParts, viewable, viewerBlob, viewerPlan, type ShowMime } from '../../lib/frameOps'
import { useModalContainment } from '../../ui/useModalContainment'

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`)

/**
 * G4 (PROGRAMS.md §9c): the host's prompt for an app's `open-url`. It shows the full destination origin and the rest of
 * the address (shortened in the middle). Only the person's own click on the link opens it, in a new tab, with no
 * opener and no referrer. The frame itself cannot open windows (its sandbox has no allow-popups).
 */
export function OpenUrlPrompt({ appName, url, onOpened, onCancel }: { appName: string; url: URL; onOpened: () => void; onCancel: () => void }) {
  const id = useId()
  const box = useRef<HTMLDivElement>(null)
  const head = useRef<HTMLHeadingElement>(null)
  const { origin, rest } = useMemo(() => urlParts(url), [url])
  useEscape(onCancel)
  useModalContainment(box)
  useEffect(() => head.current?.focus(), [])
  return createPortal(
    <div className="xc-scrim fixed inset-0 z-[70] flex items-end justify-center p-3 md:items-center" onClick={onCancel}>
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} aria-describedby={`${id}-d`} data-open-url=""
        onClick={(e) => e.stopPropagation()} className="xc-window flex w-full max-w-[520px] flex-col overflow-hidden">
        <div className="px-5 pt-5 pb-3">
          <h2 id={`${id}-t`} ref={head} tabIndex={-1} className="xc-heading text-[18px] leading-tight outline-none focus-visible:underline">
            Open a link from {shown(appName)}?
          </h2>
          <p id={`${id}-d`} className="xc-ink-2 mt-1 text-[13px] leading-snug">It opens outside the hive, in a new tab. The site does not learn which page sent you.</p>
          <div className="xc-raised mt-3 rounded-lg px-3 py-2.5" style={{ background: 'var(--xc-raised)' }}>
            <div className="xc-ink-3 text-[11px] font-semibold tracking-wider uppercase">Goes to</div>
            <div data-url-origin="" className="mt-0.5 font-mono text-[15px] font-semibold break-all">{origin}</div>
            {rest !== '/' && <div data-url-rest="" className="xc-ink-2 mt-0.5 font-mono text-[12.5px] break-all" title={url.href}>{rest}</div>}
          </div>
        </div>
        <div className="xc-divider flex flex-wrap justify-end gap-2 border-t px-5 pt-3 pb-4">
          <button type="button" className="xc-button xc-subtle" onClick={onCancel}>Cancel</button>
          <a className="xc-button xc-primary" href={url.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" onClick={onOpened}>
            Open {url.hostname}
          </a>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * G3 (PROGRAMS.md §9c): the host's viewer for an app's `show-file`. Plain text is shown as text (React escapes it). A PDF
 * (signature checked) is offered as an explicit Download only, never rendered (Review I1: an unsandboxed PDF iframe let
 * a link inside the file navigate the host tab). No show-file path creates an iframe (`viewerPlan`). Nothing is
 * persisted, no URL goes back to the frame, and the download blob (opaque type) is revoked on close.
 */
export function FileViewer({ appName, name, mime, bytes, onClose }: { appName: string; name: string; mime: ShowMime; bytes: ArrayBuffer; onClose: () => void }) {
  const id = useId()
  const box = useRef<HTMLDivElement>(null)
  const head = useRef<HTMLHeadingElement>(null)
  const view = useMemo(() => viewable(mime, bytes), [mime, bytes])
  const save = useRef<HTMLAnchorElement>(null)
  useEscape(onClose)
  useModalContainment(box)
  useEffect(() => head.current?.focus(), [])
  // the blob URL lives only while the viewer is open: set on the viewer's own elements, revoked on close
  useEffect(() => {
    const blob = viewerBlob(bytes, mime)
    if (save.current) save.current.href = blob.url
    return blob.close
  }, [bytes, mime])
  return createPortal(
    <div className="xc-scrim fixed inset-0 z-[70] flex items-stretch justify-center p-2 md:p-6" onClick={onClose}>
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} data-file-viewer=""
        onClick={(e) => e.stopPropagation()} className="xc-window flex w-full max-w-[980px] flex-col overflow-hidden">
        <div className="xc-divider flex items-start gap-3 border-b px-5 pt-4 pb-3">
          <div className="min-w-0 flex-1">
            <h2 id={`${id}-t`} ref={head} tabIndex={-1} className="xc-heading truncate text-[17px] leading-tight outline-none focus-visible:underline">{name}</h2>
            <p className="xc-ink-3 mt-0.5 text-[12.5px]">From {shown(appName)} · {mime === 'application/pdf' ? 'PDF' : 'Text'} · {size(bytes.byteLength)} · not saved anywhere</p>
          </div>
          <button type="button" className="xc-button xc-subtle" onClick={onClose}>Close</button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          {!view.ok ? (
            <p role="status" className="xc-ink-2 p-6 text-[13px]">This file cannot be shown.</p>
          ) : view.kind === 'text' && viewerPlan(view.kind).show === 'text' ? (
            <pre data-file-text="" className="thin-scroll h-full overflow-auto p-5 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap break-words">
              {view.text}
              {view.cut && '\n\n… (the rest is not shown here)'}
            </pre>
          ) : (
            <div data-file-download-only="" role="status" className="xc-ink-2 flex h-full flex-col items-start justify-center gap-2 p-6 text-[13px]">
              <p>PDFs are not opened inside the hive yet. Download it to open it with your own viewer.</p>
              <p className="xc-ink-3 text-[12px]">The file stays on this device only if you save it.</p>
            </div>
          )}
        </div>
        {view.ok && (
          <div className="xc-divider flex justify-end gap-2 border-t px-5 pt-3 pb-4">
            <a ref={save} className="xc-button xc-subtle" download={name}>Download</a>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
