/**
 * The Code canvas's layers inside CodeMirror: what the mind is writing, where it is, its ink and notes, and test
 * results beside the lines they name. One state field, set from React (`setLayers`), drawn as CodeMirror decorations
 * (so they scroll, fold and wrap with the text) plus one ink layer above the text for the hand-drawn marks.
 * Presentation only: nothing here changes the document.
 */
import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, layer, type DecorationSet, type LayerMarker } from '@codemirror/view'
import type { Ink, Presence } from './codePresence'
import { EMPTY } from './codePresence'

export type ChangeState = 'open' | 'keep' | 'skip' | 'accepted' | 'rejected' | 'stale'
export interface ChangeView {
  id: string
  n: number
  /** editor UTF-16 range of the original text */
  from: number
  to: number
  after: string
  state: ChangeState
}
export interface Layers {
  changes: ChangeView[]
  presence: Presence
  who: { name: string; hue: number } | null
  marks: { line: number; text: string; ok: boolean }[]
  reduced: boolean
  /** the exact saved file (path and text) the changes and presence were placed on (r3, stand-in P1-2) */
  for?: { path: string; text: string }
}
export const NO_LAYERS: Layers = { changes: [], presence: EMPTY, who: null, marks: [], reduced: false }

/**
 * What an editor showing `path` with `doc` may draw: changes and presence only when they were placed on exactly this
 * file and text (another file, an older version or unsaved edits draw none of them); marks stay (they name lines).
 */
export function fenceLayers(l: Layers, path: string, doc: string): Layers {
  if (l.for && l.for.path === path && l.for.text === doc) return l
  if (!l.changes.length && !l.presence.caret && !l.presence.selection && !l.presence.inks.length && !l.presence.notes.length) return l
  return { ...l, changes: [], presence: { ...l.presence, caret: null, selection: null, inks: [], notes: [] } }
}

export const setLayers = StateEffect.define<Layers>()

const field = StateField.define<Layers>({
  create: () => NO_LAYERS,
  update: (v, tr) => {
    for (const e of tr.effects) if (e.is(setLayers)) return e.value
    // positions are only valid for the document they were placed on: an edit drops the placed changes and presence
    return tr.docChanged && (v.changes.length || v.presence.caret || v.presence.selection) ? { ...v, changes: [], presence: { ...v.presence, caret: null, selection: null, inks: [] } } : v
  },
})

const chars = (s: string, n: number) => [...s].slice(0, n).join('')

class Written extends WidgetType {
  constructor(readonly text: string, readonly writing: boolean, readonly state: ChangeState, readonly n: number, readonly hue: number) {
    super()
  }
  eq(o: Written) {
    return o.text === this.text && o.writing === this.writing && o.state === this.state && o.n === this.n && o.hue === this.hue
  }
  toDOM() {
    const el = document.createElement('span')
    el.className = `cc-new cc-new-${this.state}`
    el.dataset.change = String(this.n)
    el.style.setProperty('--mind-hue', String(this.hue))
    // whole-line changes carry their indentation; beside the old line it is noise, so it is not drawn
    el.textContent = this.text.replace(/^[ \t]+/, '') || (this.writing ? '' : '∅')
    if (this.writing) {
      const c = document.createElement('span')
      c.className = 'cc-typing'
      el.appendChild(c)
    }
    return el
  }
  ignoreEvent() {
    return true
  }
}

class Caret extends WidgetType {
  constructor(readonly name: string, readonly caption: string | undefined, readonly hue: number) {
    super()
  }
  eq(o: Caret) {
    return o.name === this.name && o.caption === this.caption && o.hue === this.hue
  }
  toDOM() {
    const el = document.createElement('span')
    el.className = 'cc-mcaret'
    el.style.setProperty('--mind-hue', String(this.hue))
    const tag = document.createElement('span')
    tag.className = 'cc-mcaret-tag'
    tag.textContent = this.caption ?? this.name
    el.appendChild(tag)
    return el
  }
  ignoreEvent() {
    return true
  }
}

class Note extends WidgetType {
  constructor(readonly text: string, readonly tone: 'info' | 'warn' | 'ok' | 'bad', readonly who: string | null, readonly hue: number) {
    super()
  }
  eq(o: Note) {
    return o.text === this.text && o.tone === this.tone && o.who === this.who && o.hue === this.hue
  }
  toDOM() {
    const el = document.createElement('div')
    el.className = `cc-note cc-note-${this.tone}`
    el.style.setProperty('--mind-hue', String(this.hue))
    const mark = document.createElement('span')
    mark.className = 'cc-note-mark'
    mark.textContent = this.tone === 'ok' ? '✓' : this.tone === 'bad' ? '✗' : '●'
    mark.setAttribute('aria-hidden', 'true')
    el.appendChild(mark)
    const t = document.createElement('span')
    t.textContent = this.who ? `${this.who} · ${this.text}` : this.text
    el.appendChild(t)
    return el
  }
  ignoreEvent() {
    return true
  }
}

const lineAt = (state: EditorState, n: number) => state.doc.line(Math.min(Math.max(1, n), state.doc.lines))
/** A presence position (line, UTF-16 column) to an editor offset; CodeMirror offsets are UTF-16 too. */
const posAt = (state: EditorState, p: { line: number; col16: number }) => {
  const l = lineAt(state, p.line)
  return Math.min(l.to, l.from + Math.max(0, p.col16))
}

function build(state: EditorState, v: Layers): DecorationSet {
  const out = []
  const hue = v.who?.hue ?? 280
  const len = state.doc.length
  for (const c of v.changes) {
    if (c.from < 0 || c.to > len || c.from > c.to) continue
    const typed = v.presence.typed[c.id]
    const shown = c.state === 'accepted' ? '' : typed === undefined ? c.after : chars(c.after, typed)
    const writing = typed !== undefined && typed < [...c.after].length
    if (c.to > c.from) out.push(Decoration.mark({ class: `cc-old cc-old-${c.state}`, attributes: { 'data-change': String(c.n) } }).range(c.from, c.to))
    if (c.state !== 'accepted') out.push(Decoration.widget({ widget: new Written(shown, writing, c.state, c.n, hue), side: 1 }).range(c.to))
  }
  const sel = v.presence.selection
  if (sel) {
    const a = posAt(state, sel.from)
    const z = posAt(state, sel.to)
    if (z > a) out.push(Decoration.mark({ class: 'cc-mind-sel' }).range(a, z))
  }
  const caret = v.presence.caret
  if (caret && v.who) out.push(Decoration.widget({ widget: new Caret(v.who.name, caret.caption, hue), side: -1 }).range(posAt(state, caret)))
  for (const n of v.presence.notes) out.push(Decoration.widget({ widget: new Note(n.text, n.tone, v.who?.name ?? null, hue), block: true, side: 1 }).range(lineAt(state, n.line).to))
  for (const m of v.marks) {
    const l = lineAt(state, m.line)
    out.push(Decoration.line({ class: m.ok ? 'cc-line-ok' : 'cc-line-bad' }).range(l.from))
    out.push(Decoration.widget({ widget: new Note(m.text, m.ok ? 'ok' : 'bad', null, hue), block: true, side: 2 }).range(l.to))
  }
  return Decoration.set(out, true)
}

const decorations = EditorView.decorations.compute([field, 'doc'], (state) => build(state, state.field(field)))

// ------------------------------------------------------------------ ink

/** A hand-drawn path for an ink shape in a w×h box (pixels), with a slight deterministic wobble. */
export function inkPath(ink: Ink, w: number, h: number, seed = 1): string {
  let s = seed * 9301 + 49297
  const j = (amp: number) => {
    s = (s * 9301 + 49297) % 233280
    return ((s / 233280) * 2 - 1) * amp
  }
  const r = (n: number) => Math.round(n * 10) / 10
  const W = Math.max(8, w)
  const H = Math.max(8, h)
  switch (ink) {
    case 'underline':
      return `M${r(-2 + j(1))} ${r(H + 2 + j(1))} Q${r(W * 0.35)} ${r(H + 5 + j(1.5))} ${r(W * 0.6)} ${r(H + 3 + j(1))} T${r(W + 4)} ${r(H + 2 + j(1))}`
    case 'bracket':
      return `M${r(-6 + j(1))} ${r(-2 + j(1))} Q${r(-14 + j(1))} ${r(-1)} ${r(-13 + j(1))} ${r(H * 0.25)} L${r(-13 + j(1))} ${r(H * 0.42)} Q${r(-13)} ${r(H * 0.5)} ${r(-19 + j(1))} ${r(H * 0.5)} Q${r(-13)} ${r(H * 0.5)} ${r(-13 + j(1))} ${r(H * 0.58)} L${r(-13 + j(1))} ${r(H * 0.75)} Q${r(-14)} ${r(H + 1)} ${r(-6 + j(1))} ${r(H + 2)}`
    case 'circle': {
      const cx = W / 2
      const cy = H / 2
      const rx = W / 2 + 8
      const ry = H / 2 + 6
      return `M${r(cx - rx * 0.2)} ${r(cy - ry + j(1))} C${r(cx + rx * 0.9)} ${r(cy - ry - 2 + j(2))} ${r(cx + rx + 2)} ${r(cy + ry * 0.9 + j(2))} ${r(cx)} ${r(cy + ry + j(1))} C${r(cx - rx - 2)} ${r(cy + ry * 0.8 + j(2))} ${r(cx - rx + j(2))} ${r(cy - ry * 0.9)} ${r(cx + rx * 0.15)} ${r(cy - ry - 3 + j(1))}`
    }
    case 'arrow':
      return `M${r(W + 46)} ${r(H / 2 - 14 + j(2))} Q${r(W + 26)} ${r(H / 2 - 12 + j(2))} ${r(W + 8)} ${r(H / 2 + j(1))} M${r(W + 8)} ${r(H / 2)} l${r(10 + j(1))} ${r(-2 + j(1))} M${r(W + 8)} ${r(H / 2)} l${r(4 + j(1))} ${r(-9 + j(1))}`
    case 'tick':
      return `M${r(W + 10)} ${r(H / 2 + j(1))} l${r(5 + j(1))} ${r(6 + j(1))} l${r(11 + j(1))} ${r(-14 + j(1))}`
    case 'cross':
      return `M${r(W + 10)} ${r(H / 2 - 7)} l${r(13 + j(1))} ${r(13 + j(1))} M${r(W + 23)} ${r(H / 2 - 7)} l${r(-13 + j(1))} ${r(13 + j(1))}`
  }
}

/** How far each ink is drawn past the right of its box (inkPath): the arrow and the tick/cross sit to the right. */
const INK_RIGHT: Record<Ink, number> = { underline: 6, bracket: 0, circle: 12, arrow: 50, tick: 30, cross: 30 }

/**
 * The box width for an ink mark whose lines span `left`..`right`, clamped so the mark (and anything it draws to its
 * right) ends inside the layer at `limit`. All three in the same coordinates. At least 8, so a mark is never lost.
 */
export function inkWidth(ink: Ink, left: number, right: number, limit: number): number {
  return Math.max(8, Math.min(right, limit - INK_RIGHT[ink]) - left)
}

/**
 * The ink actually drawn (r3, Kimi r2 follow-up): when a shape that reaches to the right (arrow, tick, cross, circle)
 * has no room before the edge, it is not squeezed to the 8 px floor (a misplaced arrow or circle); the mark falls back
 * to one that stays on its lines (a bracket at their left for arrow/tick/cross, an underline for a circle).
 */
export function fitInk(ink: Ink, left: number, right: number, limit: number): { ink: Ink; width: number } {
  const room = limit - INK_RIGHT[ink] - left
  const wanted = Math.min(right, limit) - left
  if (INK_RIGHT[ink] > 6 && room < Math.min(wanted, 40)) {
    const fallback: Ink = ink === 'circle' ? 'underline' : 'bracket'
    return { ink: fallback, width: inkWidth(fallback, left, right, limit) }
  }
  return { ink, width: inkWidth(ink, left, right, limit) }
}

class InkMarker implements LayerMarker {
  constructor(readonly id: number, readonly ink: Ink, readonly left: number, readonly top: number, readonly w: number, readonly h: number, readonly hue: number, readonly reduced: boolean) {}
  eq(o: LayerMarker): boolean {
    return o instanceof InkMarker && o.id === this.id && o.left === this.left && o.top === this.top && o.w === this.w && o.h === this.h && o.hue === this.hue
  }
  draw() {
    const pad = 60
    const el = document.createElement('div')
    el.className = 'cc-ink'
    if (this.reduced) el.dataset.reduced = ''
    el.style.cssText = `left:${this.left - pad}px;top:${this.top - pad}px;width:${this.w + pad * 2}px;height:${this.h + pad * 2}px;--mind-hue:${this.hue}`
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('width', String(this.w + pad * 2))
    svg.setAttribute('height', String(this.h + pad * 2))
    svg.setAttribute('aria-hidden', 'true')
    const path = document.createElementNS(ns, 'path')
    path.setAttribute('d', inkPath(this.ink, this.w, this.h, this.id + 1))
    path.setAttribute('transform', `translate(${pad} ${pad})`)
    path.setAttribute('pathLength', '1')
    svg.appendChild(path)
    el.appendChild(svg)
    return el
  }
}

const inkLayer = layer({
  above: true,
  class: 'cc-inklayer',
  update: (u) => u.docChanged || u.viewportChanged || u.geometryChanged || u.transactions.some((t) => t.effects.some((e) => e.is(setLayers))),
  markers: (view) => {
    const v = view.state.field(field)
    if (!v.presence.inks.length) return []
    const rect = view.scrollDOM.getBoundingClientRect()
    const base = { left: rect.left - view.scrollDOM.scrollLeft, top: rect.top - view.scrollDOM.scrollTop }
    const out: LayerMarker[] = []
    for (const ink of v.presence.inks) {
      const a = lineAt(view.state, ink.from_line)
      const z = lineAt(view.state, ink.to_line)
      const indent = a.from + (/^\s*/.exec(a.text)?.[0].length ?? 0)
      const start = view.coordsAtPos(indent)
      const end = view.coordsAtPos(z.to)
      if (!start || !end) continue
      let right = start.left + 40
      for (let n = a.number; n <= Math.min(z.number, a.number + 60); n++) {
        const c = view.coordsAtPos(view.state.doc.line(n).to)
        if (c) right = Math.max(right, c.left)
      }
      // kept inside the visible scroller: an arrow by a long line is drawn short rather than off screen
      const limit = rect.left + view.scrollDOM.clientWidth - 4
      const fit = fitInk(ink.ink, start.left, right, limit)
      out.push(new InkMarker(ink.id, fit.ink, start.left - base.left, start.top - base.top, fit.width, end.bottom - start.top, v.who?.hue ?? 280, v.reduced))
    }
    return out
  },
})

/** The layers extension: include once in the editor. */
export const codeLayers = (): Extension => [field, decorations, inkLayer]
