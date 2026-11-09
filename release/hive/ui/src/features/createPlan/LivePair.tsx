/**
 * The code beside the running thing: on one side the file a builder is writing now (read-only CodeMirror, in the ink
 * MeTTa chooses for the look: ScreensSpace.codeInk, with the builder's own caret at the end; its text comes through the
 * plan's files route, usePlan), on the other the running page: the current preview's verified files (GET …/preview →
 * frameFiles → lib/appFrame appDocument) in a sandboxed frame (no network, no forms, no host origin). A remounted pair
 * shows the current page at once; only a NEW preview cross-fades in over the last, with a small receipt chip
 * ("+ app.js · tested"). With motion on, new lines flow into the code a line at a time; with reduced motion the same
 * view shows still states.
 */
import { useEffect, useState } from 'react'
import { appDocument } from '../../lib/appFrame'
import { Editor } from '../code/Editor'
import { EMPTY } from '../code/canvas/codePresence'
import type { Layers } from '../code/canvas/layers'
import type { PlanView } from './contract'
import { frameFiles, type CurrentFile } from './planModel'

/** a page to run: a checkpoint's files (the verified preview's) */
export interface PageFrame { ckpt: string; files: Record<string, string> }

const uuid = (): string => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : '00000000-0000-4000-8000-000000000000')
const origin = (): string => (typeof location !== 'undefined' && /^https?:/.test(location.origin) ? location.origin : 'http://localhost')

/** A checkpoint's files as one sandboxed document, or why it cannot be shown yet. */
export function checkpointDocument(files: Record<string, string>): { html: string } | { why: string } {
  const frame = frameFiles(files)
  if (!frame) return { why: 'This version cannot be shown yet; the next one will be.' }
  try {
    return { html: appDocument(frame, origin(), uuid(), uuid()).html }
  } catch {
    return { why: 'This version cannot be shown yet; the next one will be.' }
  }
}

/** what a new preview brought in (files new or changed since the last one) and what its check said */
export function receiptWords(prev: Record<string, string> | null, next: PageFrame, view: PlanView): string | null {
  const changed = Object.keys(next.files).filter((f) => !prev || prev[f] !== next.files[f])
  if (!changed.length) return null
  const check = [...view.checks].reverse().find((c) => c.ckpt === next.ckpt && !c.base)
  const said = check?.state === 'passed' ? 'tested' : check?.state === 'failed' ? 'a check failed' : check?.state === 'running' ? 'checking' : 'put together'
  const names = changed.length > 2 ? `${changed.slice(0, 2).join(', ')} and ${changed.length - 2} more` : changed.join(', ')
  return `+ ${names} · ${said}`
}

/** instant: drawn at once with no fade (the first page a mounted pair shows, or any page under reduced motion) */
interface Layer { ckpt: string; html: string | null; why: string | null; shown: boolean; instant: boolean }
const layerOf = (c: PageFrame, shown: boolean): Layer => {
  const doc = checkpointDocument(c.files)
  return { ckpt: c.ckpt, html: 'html' in doc ? doc.html : null, why: 'why' in doc ? doc.why : null, shown, instant: shown }
}

/** The running page: each preview its own frame; the first shown at once, a newer one fading in over the last, then
 * the last let go. */
export function RunningPage({ frame, receipt, reduced, title = 'The running page' }: { frame: PageFrame; receipt: string | null; reduced: boolean; title?: string }) {
  // mounted (or remounted) with a page: that page shows at once, never hidden until its frame loads
  const [layers, setLayers] = useState<Layer[]>(() => [layerOf(frame, true)])
  const ckpt = frame.ckpt
  // a new preview: its frame joins at once (under reduced motion it replaces the last, already shown)
  if (!layers.some((l) => l.ckpt === ckpt)) setLayers(reduced ? [layerOf(frame, true)] : [...layers.slice(-1), layerOf(frame, false)])
  const newest = layers[layers.length - 1]
  // the frame's load shows it; a frame that never reports its load is shown anyway
  useEffect(() => {
    if (newest.shown) return
    const t = setTimeout(() => setLayers((now) => now.map((l) => (l.ckpt === newest.ckpt ? { ...l, shown: true } : l))), 700)
    return () => clearTimeout(t)
  }, [newest.ckpt, newest.shown])
  // once the newest is in, the older frame goes after the fade
  useEffect(() => {
    if (!newest.shown || layers.length < 2) return
    const t = setTimeout(() => setLayers((now) => now.slice(-1)), reduced ? 0 : 480)
    return () => clearTimeout(t)
  }, [newest.shown, layers.length, reduced])
  return (
    <div className="pl-run" data-reduced={reduced || undefined}>
      <div className="pl-stage">
        {layers.map((l) => l.html !== null
          ? <iframe key={l.ckpt} className="pl-frame" data-ckpt={l.ckpt} data-shown={l.shown || undefined} data-instant={l.instant || undefined} title={title} srcDoc={l.html}
              sandbox="allow-scripts" referrerPolicy="no-referrer"
              onLoad={() => setLayers((now) => now.map((x) => (x.ckpt === l.ckpt ? { ...x, shown: true } : x)))} />
          : <p key={l.ckpt} className="pl-why" data-ckpt={l.ckpt} data-shown="">{l.why}</p>)}
      </div>
      {receipt && <p key={ckpt} className="pl-receipt" role="status">{receipt}</p>}
    </div>
  )
}

/** the end of the next line after `at` (the whole rest when there is no further line break) */
const nextLine = (text: string, at: number) => { const n = text.indexOf('\n', at); return n < 0 ? text.length : n + 1 }

/** lines shown so far: with motion on they catch up a line at a time; reduced, all at once */
function useFlowingText(target: string, key: string, reduced: boolean): string {
  const [flow, setFlow] = useState({ key, upto: target })
  // another file, or a text that is not the shown one grown: shown as it is, at once
  const valid = flow.key === key && target.startsWith(flow.upto)
  if (!valid) setFlow({ key, upto: target })
  const behind = valid && !reduced && flow.upto.length < target.length
  useEffect(() => {
    if (!behind) return
    const t = setInterval(() => setFlow((f) => (f.key === key && target.startsWith(f.upto) && f.upto.length < target.length ? { key, upto: target.slice(0, nextLine(target, f.upto.length)) } : f)), 70)
    return () => clearInterval(t)
  }, [behind, key, target])
  return reduced || !valid ? target : flow.upto
}

export function LivePair({ view, file, frame, reduced }: { view: PlanView; file: CurrentFile | null; frame: PageFrame | null; reduced: boolean }) {
  // what the last preview brought in, worked out when a new one arrives
  const [seen, setSeen] = useState<{ ckpt: string; files: Record<string, string>; receipt: string | null } | null>(frame ? { ckpt: frame.ckpt, files: frame.files, receipt: null } : null)
  if (frame && seen?.ckpt !== frame.ckpt) setSeen({ ckpt: frame.ckpt, files: frame.files, receipt: seen ? receiptWords(seen.files, frame, view) : null })
  const receipt = seen?.receipt ?? null
  const writing = !!file?.writing
  const text = useFlowingText(file?.content ?? '', file ? `${file.piece}:${file.path}` : '', reduced)
  const lines = text.split('\n')
  const layers: Layers | undefined = file?.builder && writing
    ? { changes: [], marks: [], reduced, who: { name: file.builder.name, hue: file.builder.hue },
        presence: { ...EMPTY, caret: { line: lines.length, col16: lines[lines.length - 1].length, caption: `${file.builder.name} · writing` } } }
    : undefined
  return (
    <section className="pl" aria-label="The code and the running page">
      <div className="pl-pane pl-code" style={file?.builder ? { ['--mind-hue' as string]: String(file.builder.hue) } : undefined}>
        <header className="pl-head">
          <span className="pl-path">{file ? file.path : 'No file yet'}</span>
          {file?.builder && <span className="pl-who">{writing ? `${file.builder.name} is writing` : `by ${file.builder.name}`}</span>}
        </header>
        <div className="pl-editor">
          {file
            ? <Editor path={file.path} content={text} readOnly onChange={() => {}} onSave={() => {}} layers={layers} label={`${file.path}, as it is being written`} />
            : <p className="pl-why">The first file appears here as soon as a builder starts writing.</p>}
        </div>
      </div>
      <div className="pl-pane pl-page">
        <header className="pl-head">
          <span className="pl-path">The running page</span>
          {frame && <span className="pl-who">preview</span>}
        </header>
        {frame ? <RunningPage frame={frame} receipt={receipt} reduced={reduced} /> : <p className="pl-why">It runs here once the checks pass and its preview is ready.</p>}
      </div>
    </section>
  )
}
