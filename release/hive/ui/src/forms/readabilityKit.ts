import { CLASSIC_CHROME, type ExperienceChrome } from '../experiences/chrome'

/**
 * Test kit for the readability regressions (forms/readability.test.ts; stand-in READABILITY_R1 finding 1): a
 * server-rendered tree, the real stylesheets (index.css and the forms' own .css, read as text), and the colour every
 * text node is actually painted in over what is painted beneath it. Nothing in the app imports this file.
 *
 * It is a small, honest cascade, not a browser: selectors with compound parts, descendant and child combinators,
 * :is/:where/:not and attribute operators; @theme as :root; @layer rules below unlayered ones; @media evaluated for a
 * 1440x900 screen; @container, hover and focus states never match. Custom properties inherit and resolve where they
 * are declared. Tailwind utilities are mapped from the class names (the build generates them, so the colour ones are
 * derived from the @theme --color-* tokens; an unknown colour utility throws rather than being skipped). Backgrounds
 * stack from the root down (gradients contribute every stop), opacity groups composite over what they cover, and the
 * bottom is the worst of black and white, as the experiences' own chrome tests measure.
 */

export type RGBA = [number, number, number, number]

// ------------------------------------------------------------------------------------------------------- markup

export interface El {
  tag: string
  attrs: Record<string, string>
  children: (El | string)[]
  parent: El | null
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
const decode = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|#x27|#39|nbsp);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'", nbsp: ' ' })[e] ?? _)

/** React's server markup as a tree (well-formed by construction). Scripts and comments are dropped. */
export function parseHtml(html: string): El {
  const root: El = { tag: '#root', attrs: {}, children: [], parent: null }
  let cur = root
  const re = /<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script>|<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[5] != null) {
      cur.children.push(decode(m[5]))
      continue
    }
    if (!m[2]) continue
    const tag = m[2].toLowerCase()
    if (m[1]) {
      for (let e: El | null = cur; e; e = e.parent)
        if (e.tag === tag) {
          cur = e.parent ?? root
          break
        }
      continue
    }
    const attrs: Record<string, string> = {}
    for (const a of m[3].matchAll(/([^\s=>/]+)(?:="([^"]*)")?/g)) attrs[a[1]] = decode(a[2] ?? '')
    const el: El = { tag, attrs, children: [], parent: cur }
    cur.children.push(el)
    if (!m[4] && !VOID.has(tag)) cur = el
  }
  return root
}

export function* walk(el: El): Generator<El> {
  yield el
  for (const c of el.children) if (typeof c !== 'string') yield* walk(c)
}
export const classes = (el: El) => (el.attrs.class ?? '').split(/\s+/).filter(Boolean)
export const textOf = (el: El): string => el.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('')
export const ownText = (el: El) => el.children.filter((c): c is string => typeof c === 'string').join('').trim()
export const find = (root: El, pred: (e: El) => boolean) => [...walk(root)].filter(pred)
export const isWithin = (el: El, anc: El) => {
  for (let e: El | null = el; e; e = e.parent) if (e === anc) return true
  return false
}

/** The markup inside <html><body>, with <html> as applyChrome leaves it for this chrome (null: classic). */
export function page(markup: string, chrome: ExperienceChrome | null): El {
  const c = chrome ?? CLASSIC_CHROME
  const body = parseHtml(markup)
  const style = Object.entries(CHROME_VARS)
    .map(([k, v]) => `${v}:${c[k as keyof typeof CHROME_VARS]}`)
    .join(';')
  const html: El = { tag: 'html', attrs: { style, 'data-xc-material': c.material, 'data-xc-scheme': c.scheme, ...(chrome ? { 'data-xc-active': '' } : {}) }, children: [], parent: null }
  const b: El = { tag: 'body', attrs: {}, children: body.children, parent: html }
  for (const ch of b.children) if (typeof ch !== 'string') ch.parent = b
  html.children = [b]
  return html
}
const CHROME_VARS = {
  surface: '--xc-surface',
  raised: '--xc-raised',
  ink: '--xc-ink',
  ink2: '--xc-ink-2',
  ink3: '--xc-ink-3',
  line: '--xc-line',
  edge: '--xc-edge',
  accent: '--xc-accent',
  onAccent: '--xc-on-accent',
  danger: '--xc-danger',
  onDanger: '--xc-on-danger',
  font: '--xc-font',
  display: '--xc-display',
  radius: '--xc-radius',
  controlRadius: '--xc-control-radius',
  scrim: '--xc-scrim',
  shadow: '--xc-shadow',
} as const

// ------------------------------------------------------------------------------------------------------- CSS

interface Decl {
  value: string
  important: boolean
}
export interface Rule {
  selector: Sel[]
  decls: Record<string, Decl>
  tier: number // 0 base, 1 components, 2 utilities, 3 unlayered
  order: number
}
type Compound = { tag: string | null; parts: Part[] }
type Part =
  | { k: 'class'; v: string }
  | { k: 'id'; v: string }
  | { k: 'attr'; name: string; op: string | null; v: string }
  | { k: 'is' | 'where' | 'not'; list: Sel[] }
  | { k: 'root' }
  | { k: 'never' }
type Sel = { compounds: Compound[]; combinators: string[]; spec: number }

const LAYERS: Record<string, number> = { base: 0, components: 1, utilities: 2 }
let order = 0

function splitTop(s: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0
  let q: string | null = null
  let last = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (q) {
      if (ch === q) q = null
      continue
    }
    if (ch === '"' || ch === "'") q = ch
    else if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (depth === 0 && s.startsWith(sep, i)) {
      out.push(s.slice(last, i))
      last = i + sep.length
    }
  }
  out.push(s.slice(last))
  return out.map((x) => x.trim()).filter((x) => x.length)
}

function parseSelectorList(s: string): Sel[] {
  return splitTop(s, ',').map(parseComplex)
}
function parseComplex(s: string): Sel {
  const compounds: Compound[] = []
  const combinators: string[] = []
  let i = 0
  let pending = ' '
  const src = s.trim()
  while (i < src.length) {
    if (/\s/.test(src[i]) || src[i] === '>' || src[i] === '+' || src[i] === '~') {
      if (src[i] === '>' || src[i] === '+' || src[i] === '~') pending = src[i]
      i++
      continue
    }
    const [c, j] = parseCompound(src, i)
    if (compounds.length) combinators.push(pending)
    compounds.push(c)
    pending = ' '
    i = j
  }
  return { compounds, combinators, spec: compounds.reduce((n, c) => n + specOf(c), 0) }
}
function parseCompound(s: string, i: number): [Compound, number] {
  const c: Compound = { tag: null, parts: [] }
  const tag = /^(\*|[a-zA-Z][\w-]*)/.exec(s.slice(i))
  if (tag) {
    c.tag = tag[1] === '*' ? null : tag[1].toLowerCase()
    i += tag[1].length
  }
  while (i < s.length && !/[\s>+~]/.test(s[i])) {
    const rest = s.slice(i)
    let m: RegExpExecArray | null
    if ((m = /^\.((?:\\.|[\w-])+)/.exec(rest))) {
      c.parts.push({ k: 'class', v: m[1].replace(/\\(.)/g, '$1') })
      i += m[0].length
    } else if ((m = /^#([\w-]+)/.exec(rest))) {
      c.parts.push({ k: 'id', v: m[1] })
      i += m[0].length
    } else if (rest[0] === '[') {
      const end = matching(s, i, '[', ']')
      const body = s.slice(i + 1, end)
      const a = /^\s*([\w-]+)\s*(?:([~^$*|]?=)\s*(?:'([^']*)'|"([^"]*)"|([^\s\]]+)))?\s*(i)?\s*$/.exec(body)
      if (!a) throw new Error(`unparsed attribute selector [${body}]`)
      c.parts.push({ k: 'attr', name: a[1], op: a[2] ?? null, v: a[3] ?? a[4] ?? a[5] ?? '' })
      i = end + 1
    } else if ((m = /^::?([\w-]+)/.exec(rest))) {
      const name = m[1]
      i += m[0].length
      if (s[i] === '(') {
        const end = matching(s, i, '(', ')')
        const arg = s.slice(i + 1, end)
        i = end + 1
        if (name === 'is' || name === 'where' || name === 'not') c.parts.push({ k: name, list: parseSelectorList(arg) })
        else c.parts.push({ k: 'never' })
      } else if (name === 'root') c.parts.push({ k: 'root' })
      else c.parts.push({ k: 'never' }) // hover, focus, ::before …: a static first paint has none of them
    } else if (rest[0] === '&') {
      i++ // nesting parent, resolved by the caller
    } else throw new Error(`unparsed selector at "${rest.slice(0, 30)}" in "${s}"`)
  }
  return [c, i]
}
function matching(s: string, i: number, open: string, close: string) {
  let d = 0
  let q: string | null = null
  for (let j = i; j < s.length; j++) {
    if (q) {
      if (s[j] === q) q = null
      continue
    }
    if (s[j] === '"' || s[j] === "'") q = s[j]
    else if (s[j] === open) d++
    else if (s[j] === close && --d === 0) return j
  }
  throw new Error(`unbalanced ${open} in ${s}`)
}
function specOf(c: Compound): number {
  let n = c.tag ? 1 : 0
  for (const p of c.parts) {
    if (p.k === 'id') n += 10000
    else if (p.k === 'class' || p.k === 'attr' || p.k === 'root' || p.k === 'never') n += 100
    else if (p.k === 'is' || p.k === 'not') n += Math.max(...p.list.map((x) => x.spec))
  }
  return n
}

function matchCompound(el: El, c: Compound): boolean {
  if (c.tag && el.tag !== c.tag) return false
  for (const p of c.parts) {
    switch (p.k) {
      case 'class':
        if (!classes(el).includes(p.v)) return false
        break
      case 'id':
        if (el.attrs.id !== p.v) return false
        break
      case 'attr': {
        const v = el.attrs[p.name]
        if (v == null) return false
        if (p.op === '=' && v !== p.v) return false
        if (p.op === '^=' && !v.startsWith(p.v)) return false
        if (p.op === '$=' && !v.endsWith(p.v)) return false
        if (p.op === '*=' && !v.includes(p.v)) return false
        if (p.op === '~=' && !v.split(/\s+/).includes(p.v)) return false
        break
      }
      case 'is':
      case 'where':
        if (!p.list.some((x) => matches(el, x))) return false
        break
      case 'not':
        if (p.list.some((x) => matches(el, x))) return false
        break
      case 'root':
        if (el.tag !== 'html') return false
        break
      case 'never':
        return false
    }
  }
  return true
}
export function matches(el: El, s: Sel): boolean {
  const go = (e: El, k: number): boolean => {
    if (!matchCompound(e, s.compounds[k])) return false
    if (k === 0) return true
    const comb = s.combinators[k - 1]
    if (comb === '>') return !!e.parent && go(e.parent, k - 1)
    if (comb === ' ') {
      for (let a = e.parent; a; a = a.parent) if (go(a, k - 1)) return true
      return false
    }
    return false // + and ~: not modelled, never matched
  }
  return go(el, s.compounds.length - 1)
}

const VIEW = { width: 1440, height: 900 }
function mediaMatches(q: string): boolean {
  return splitTop(q, ',').some((alt) =>
    alt.split(/\band\b/).every((part) => {
      const p = part.trim()
      let m: RegExpExecArray | null
      if ((m = /^\(\s*min-width:\s*([\d.]+)px\s*\)$/.exec(p))) return VIEW.width >= +m[1]
      if ((m = /^\(\s*max-width:\s*([\d.]+)px\s*\)$/.exec(p))) return VIEW.width <= +m[1]
      if ((m = /^\(\s*min-height:\s*([\d.]+)px\s*\)$/.exec(p))) return VIEW.height >= +m[1]
      if ((m = /^\(\s*max-height:\s*([\d.]+)px\s*\)$/.exec(p))) return VIEW.height <= +m[1]
      if (/^\(\s*orientation:\s*landscape\s*\)$/.test(p)) return true
      if (/^\(\s*prefers-reduced-motion:\s*no-preference\s*\)$/.test(p)) return true
      if (p === 'screen' || p === 'all') return true
      return false
    }),
  )
}

/** A stylesheet's rules, in source order (call in the order the app loads them: index.css first). */
export function parseCss(text: string): Rule[] {
  const rules: Rule[] = []
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '')
  block(src, null, 3, true, rules)
  return rules
}
function block(src: string, parent: string | null, tier: number, active: boolean, out: Rule[]) {
  let i = 0
  while (i < src.length) {
    const open = src.indexOf('{', i)
    const semi = src.indexOf(';', i)
    if (open < 0) break
    if (semi >= 0 && semi < open) {
      i = semi + 1 // a statement at-rule (@import) or a declaration at this level
      continue
    }
    const prelude = src.slice(i, open).trim()
    const close = matching(src, open, '{', '}')
    const body = src.slice(open + 1, close)
    i = close + 1
    if (prelude.startsWith('@')) {
      const [, name, rest] = /^@([\w-]+)\s*([\s\S]*)$/.exec(prelude) ?? []
      if (name === 'theme') block(`:root{${body}}`, parent, 0, active, out)
      else if (name === 'layer') block(body, parent, LAYERS[rest.trim()] ?? 0, active, out)
      else if (name === 'media') block(body, parent, tier, active && mediaMatches(rest), out)
      // @container, @keyframes, @supports, @font-face …: not modelled
      continue
    }
    const sel = parent ? splitTop(prelude, ',').map((p) => (p.includes('&') ? p.replace(/&/g, parent) : `${parent} ${p}`)).join(', ') : prelude
    const decls: Record<string, Decl> = {}
    let nested = ''
    let depth = 0
    let cur = ''
    for (const ch of body) {
      if (ch === '{') depth++
      if (depth > 0) nested += ch
      else if (ch === ';') {
        addDecl(decls, cur)
        cur = ''
      } else cur += ch
      if (ch === '}') {
        depth--
        if (depth === 0) {
          // a nested rule: its prelude is the tail of `cur`
          nested = `${cur}${nested}`
          block(nested, sel, tier, active, out)
          nested = ''
          cur = ''
        }
      }
    }
    addDecl(decls, cur)
    if (active && Object.keys(decls).length) out.push({ selector: parseSelectorList(sel), decls, tier, order: order++ })
  }
}
function addDecl(decls: Record<string, Decl>, raw: string) {
  const c = raw.indexOf(':')
  if (c < 0) return
  const prop = raw.slice(0, c).trim()
  let value = raw.slice(c + 1).trim()
  if (!prop || !value) return
  const important = /!important\s*$/.test(value)
  if (important) value = value.replace(/\s*!important\s*$/, '')
  decls[prop] = { value, important }
}

// --------------------------------------------------------------------------------- Tailwind utilities (mapped)

const SIZES: Record<string, string> = { xs: '12px', sm: '14px', base: '16px', lg: '18px', xl: '20px', '2xl': '24px', '3xl': '30px', '4xl': '36px' }
const TEXT_NON_COLOUR = /^(left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)$/
const opacityOf = (o: string) => (o.startsWith('[') ? `${parseFloat(o.slice(1)) * 100}%` : `${o}%`)

/** The declarations a Tailwind class gives (only the ones that decide colour, size, weight and opacity). */
function utility(cls: string, theme: Set<string>): Record<string, string> | null {
  if (cls.includes(':')) return null // hover:, md:, group-hover: … are not the first paint at rest
  let m: RegExpExecArray | null
  const colour = (name: string, op?: string) => {
    let base: string
    if ((m = /^\((--[\w-]+)\)$/.exec(name)) || (m = /^\[var\((--[\w-]+)\)\]$/.exec(name))) base = `var(${m[1]})`
    else if ((m = /^\[(#[0-9a-fA-F]{3,8}|rgb\([^\]]*\))\]$/.exec(name))) base = m[1].replace(/_/g, ' ')
    else if (name === 'transparent') base = 'transparent'
    else if (theme.has(`--color-${name}`)) base = `var(--color-${name})`
    else return null
    return op ? `color-mix(in srgb, ${base} ${opacityOf(op)}, transparent)` : base
  }
  if ((m = /^text-(.+)$/.exec(cls))) {
    const [name, op] = m[1].split('/')
    if (SIZES[name]) return { 'font-size': SIZES[name] }
    if (/^\[[\d.]+(px|rem|em)\]$/.test(name)) return { 'font-size': name.slice(1, -1).replace(/^([\d.]+)rem$/, (_, n) => `${+n * 16}px`) }
    if (TEXT_NON_COLOUR.test(name)) return null
    const c = colour(name, op)
    if (c) return { color: c }
    throw new Error(`readabilityKit: no mapping for the colour utility .${cls}`)
  }
  if ((m = /^bg-(.+)$/.exec(cls))) {
    const [name, op] = m[1].split('/')
    if (/^(clip|origin|fixed|local|scroll|repeat|no-repeat|cover|contain|center|top|bottom|none|linear|radial|conic|gradient|blend)/.test(name)) return null
    const c = colour(name, op)
    if (c) return { 'background-color': c }
    throw new Error(`readabilityKit: no mapping for the background utility .${cls}`)
  }
  if ((m = /^opacity-(\d+)$/.exec(cls))) return { opacity: String(+m[1] / 100) }
  if (cls === 'font-medium') return { 'font-weight': '500' }
  if (cls === 'font-semibold') return { 'font-weight': '600' }
  if (cls === 'font-bold') return { 'font-weight': '700' }
  if (cls === 'skeleton' || cls === 'sr-only') return null
  return null
}

// ------------------------------------------------------------------------------------------------------- cascade

export interface Styled {
  props: Record<string, string> // the element's own computed (non-custom) properties of interest, var()-resolved
  vars: Record<string, string> // custom properties in force at the element, resolved
}
const INHERITED = new Set(['color', 'font-family', 'font-size', 'font-weight'])
const OWN = new Set(['background', 'background-color', 'opacity', 'font', ...INHERITED])

export class Cascade {
  private rules: Rule[]
  private theme: Set<string>
  private memo = new WeakMap<El, Styled>()
  constructor(...sheets: Rule[][]) {
    // Tailwind's own theme gives black and white (index.css's @theme adds the hive's colours)
    this.rules = [{ selector: parseSelectorList(':root'), decls: { '--color-black': { value: '#000', important: false }, '--color-white': { value: '#fff', important: false } }, tier: 0, order: -1 }, ...sheets.flat()]
    this.theme = new Set(this.rules.filter((r) => r.tier === 0 && r.selector.some((s) => s.compounds.length === 1 && s.compounds[0].parts.some((p) => p.k === 'root'))).flatMap((r) => Object.keys(r.decls)))
  }

  styled(el: El): Styled {
    const hit = this.memo.get(el)
    if (hit) return hit
    const parent = el.parent ? this.styled(el.parent) : { props: {}, vars: {} }
    type Win = { value: string; key: [number, number, number, number, number] }
    const won: Record<string, Win> = {}
    const offer = (prop: string, value: string, key: Win['key']) => {
      const w = won[prop]
      if (!w || cmp(key, w.key) >= 0) won[prop] = { value, key }
    }
    for (const r of this.rules) {
      let spec = -1
      for (const s of r.selector) if (s.spec > spec && matches(el, s)) spec = s.spec
      if (spec < 0) continue
      for (const [p, d] of Object.entries(r.decls)) offer(p, d.value, [d.important ? 1 : 0, r.tier, spec, r.order, 0])
    }
    for (const c of classes(el)) {
      const u = utility(c, this.theme)
      if (u) for (const [p, v] of Object.entries(u)) offer(p, v, [0, 2, 100, -1, 0])
    }
    for (const [p, v] of Object.entries(parseStyle(el.attrs.style ?? ''))) offer(p, v, [0, 4, 0, 0, 1])
    // custom properties: inherited, resolved where declared
    const vars: Record<string, string> = { ...parent.vars }
    const own = Object.entries(won).filter(([p]) => p.startsWith('--'))
    const raw: Record<string, string> = { ...parent.vars, ...Object.fromEntries(own.map(([p, w]) => [p, w.value])) }
    for (const [p, w] of own) vars[p] = substitute(w.value, raw, new Set([p]))
    const props: Record<string, string> = {}
    for (const p of INHERITED) if (parent.props[p] != null) props[p] = parent.props[p]
    for (const [p, w] of Object.entries(won)) if (OWN.has(p) && w.value !== 'inherit') props[p] = substitute(w.value, vars, new Set())
    const fs = /^([\d.]+)em$/.exec(props['font-size'] ?? '')
    if (fs) props['font-size'] = `${+fs[1] * parseFloat(parent.props['font-size'] ?? '16')}px`
    if (props.font) {
      const f = /([\d.]+)px/.exec(props.font)
      if (f) props['font-size'] = `${f[1]}px`
    }
    if (props.color === 'currentColor' || props.color === 'inherit') props.color = parent.props.color ?? ''
    const out = { props, vars }
    this.memo.set(el, out)
    return out
  }
}
const cmp = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}
export function parseStyle(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of splitTop(s, ';')) {
    const c = part.indexOf(':')
    if (c > 0) out[part.slice(0, c).trim()] = part.slice(c + 1).trim()
  }
  return out
}
/** var(--x[, fallback]) substituted from `vars` (recursively); an unknown var with no fallback stays unresolved. */
export function substitute(v: string, vars: Record<string, string>, seen: Set<string>): string {
  let out = ''
  let i = 0
  for (;;) {
    const j = v.indexOf('var(', i)
    if (j < 0) return out + v.slice(i)
    out += v.slice(i, j)
    const end = matching(v, j + 3, '(', ')')
    const [name, ...fb] = splitTop(v.slice(j + 4, end), ',')
    const fallback = fb.length ? v.slice(j + 4, end).slice(v.slice(j + 4, end).indexOf(',') + 1).trim() : null
    if (vars[name] != null && !seen.has(name)) out += substitute(vars[name], vars, new Set([...seen, name]))
    else if (fallback != null) out += substitute(fallback, vars, seen)
    else out += `var(${name})`
    i = end + 1
  }
}

// ------------------------------------------------------------------------------------------------------- colour

export function parseColor(raw: string): RGBA {
  const c = raw.trim()
  let m: RegExpExecArray | null
  if (c === 'transparent') return [0, 0, 0, 0]
  if (c === 'white') return [255, 255, 255, 1]
  if (c === 'black') return [0, 0, 0, 1]
  if ((m = /^#([0-9a-f]{3,8})$/i.exec(c))) {
    let h = m[1]
    if (h.length <= 4) h = [...h].map((x) => x + x).join('')
    const n = [0, 2, 4, 6].map((k) => (k < h.length ? parseInt(h.slice(k, k + 2), 16) : 255))
    return [n[0], n[1], n[2], n[3] / 255]
  }
  if ((m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[/,]\s*([\d.]+%?))?\s*\)$/.exec(c)))
    return [+m[1], +m[2], +m[3], m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4]]
  if ((m = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%\s*(?:[/,]\s*([\d.]+%?))?\s*\)$/.exec(c))) {
    const [h, s, l] = [+m[1] / 360, +m[2] / 100, +m[3] / 100]
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    const ch = (t: number) => {
      t = (t + 1) % 1
      const v = t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p
      return Math.round(v * 255)
    }
    return [ch(h + 1 / 3), ch(h), ch(h - 1 / 3), m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4]]
  }
  if ((m = /^color-mix\(\s*in\s+[\w-]+\s*,([\s\S]*)\)$/.exec(c))) {
    const [a, b] = splitTop(m[1], ',').map((x) => {
      const pm = /^([\s\S]*?)\s+([\d.]+)%$/.exec(x)
      return pm ? { c: parseColor(pm[1]), p: +pm[2] / 100 } : { c: parseColor(x), p: null as number | null }
    })
    const pa = a.p ?? (b.p != null ? 1 - b.p : 0.5)
    const pb = b.p ?? 1 - pa
    const alpha = a.c[3] * pa + b.c[3] * pb
    if (alpha === 0) return [0, 0, 0, 0]
    return [0, 1, 2].map((i) => (a.c[i] * a.c[3] * pa + b.c[i] * b.c[3] * pb) / alpha).concat(alpha) as RGBA
  }
  throw new Error(`readabilityKit: unparsed colour "${c}"`)
}
export const over = (top: RGBA, under: RGBA): RGBA => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1) as RGBA
const mix = (a: RGBA, b: RGBA, p: number): RGBA => [0, 1, 2].map((i) => a[i] * p + b[i] * (1 - p)).concat(1) as RGBA
export const lum = (x: RGBA) => {
  const [r, g, b] = x.slice(0, 3).map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
export const ratio = (a: RGBA, b: RGBA) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}
export const sameColour = (a: string, b: string) => {
  const [x, y] = [parseColor(a), parseColor(b)]
  return x.every((v, i) => Math.abs(v - y[i]) < (i === 3 ? 0.005 : 0.6))
}

/** Every colour a background value paints, bottom layer first; a gradient gives each of its stops. */
export function backgroundLayers(v: string): RGBA[][] {
  if (!v || v === 'none') return []
  return splitTop(v, ',')
    .reverse()
    .map((layer) => {
      const g = /^(?:repeating-)?(?:linear|radial|conic)-gradient\(([\s\S]*)\)/.exec(layer)
      // a tiled texture (a gradient with its own small size, such as the paper grain's dots) is no ground a glyph sits on
      if (g && /\/\s*[\d.]+px\s+[\d.]+px\s*$/.test(layer)) return []
      if (g) {
        const stops: RGBA[] = []
        for (const arg of splitTop(g[1], ',')) {
          const c = leadingColour(arg)
          if (c) stops.push(c)
        }
        return stops
      }
      if (/^url\(|^none$/.test(layer)) return []
      const c = leadingColour(layer)
      return c ? [c] : []
    })
    .filter((l) => l.length)
}
function leadingColour(s: string): RGBA | null {
  const t = s.trim()
  const fn = /^(rgba?|hsla?|color-mix)\(/.exec(t)
  if (fn) return parseColor(t.slice(0, matching(t, fn[0].length - 1, '(', ')') + 1))
  const word = /^(#[0-9a-f]{3,8}|transparent|white|black)\b/i.exec(t)
  return word ? parseColor(word[1]) : null
}

// ------------------------------------------------------------------------------------------------------- painting

export interface Measured {
  el: El
  text: string
  ratio: number
  min: number
  fg: string
  bg: string
}
const BACKDROPS: RGBA[] = [
  [0, 0, 0, 1],
  [255, 255, 255, 1],
]

/** The worst contrast of `el`'s own text over everything painted beneath it (all stops, both backdrops). */
/** Diagnostics: each ancestor of `el` with the background, opacity and colour the cascade gives it. */
export function chainOf(cx: Cascade, el: El): string[] {
  const out: string[] = []
  for (let e: El | null = el; e; e = e.parent) {
    const p = cx.styled(e).props
    out.unshift(`<${e.tag} class="${(e.attrs.class ?? '').slice(0, 60)}"> bg=${p.background ?? ''}|${p['background-color'] ?? ''} op=${p.opacity ?? ''} color=${p.color ?? ''}`)
  }
  return out
}
export function measure(cx: Cascade, el: El): Measured {
  const chain: El[] = []
  for (let e: El | null = el; e; e = e.parent) chain.unshift(e)
  const s = cx.styled(el)
  const fgRaw = s.props.color
  if (!fgRaw) throw new Error(`no colour for <${el.tag} class="${el.attrs.class ?? ''}">`)
  const fgC = parseColor(fgRaw)
  let worst: { r: number; fg: RGBA; bg: RGBA } | null = null
  for (const backdrop of BACKDROPS) {
    // each candidate: what is painted so far, and the opacity groups it sits in (innermost last)
    let cands: { painted: RGBA; groups: { o: number; under: RGBA }[] }[] = [{ painted: backdrop, groups: [] }]
    for (const e of chain) {
      if (e.tag === 'html' || e.tag === 'body') continue
      const st = cx.styled(e)
      // opacity 0 at first paint is an entrance (framer-motion's initial state) or a reveal: measured as it is shown
      const o = st.props.opacity != null && parseFloat(st.props.opacity) > 0 ? parseFloat(st.props.opacity) : 1
      if (o < 1) cands = cands.map((c) => ({ ...c, groups: [...c.groups, { o, under: c.painted }] }))
      const layers = [...backgroundLayers(st.props['background-color'] ?? ''), ...backgroundLayers(st.props.background ?? '')]
      for (const stops of layers) {
        const next: typeof cands = []
        for (const c of cands) for (const stop of stops) next.push({ ...c, painted: over(stop, c.painted) })
        cands = dedupe(next)
      }
    }
    for (const c of cands) {
      let fg = over(fgC, c.painted)
      let bg = c.painted
      for (const g of [...c.groups].reverse()) {
        fg = mix(fg, g.under, g.o)
        bg = mix(bg, g.under, g.o)
      }
      const r = ratio(fg, bg)
      if (!worst || r < worst.r) worst = { r, fg, bg }
    }
  }
  const size = parseFloat(s.props['font-size'] ?? '16')
  const weight = parseFloat(s.props['font-weight'] ?? '400')
  const large = size >= 24 || (size >= 18.66 && weight >= 700)
  const hex = (c: RGBA) => `#${c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`
  return { el, text: textOf(el).trim().slice(0, 40), ratio: +worst!.r.toFixed(2), min: large ? 3 : 4.5, fg: hex(worst!.fg), bg: hex(worst!.bg) }
}
function dedupe<T extends { painted: RGBA; groups: unknown[] }>(xs: T[]): T[] {
  const seen = new Map<string, T>()
  for (const x of xs) seen.set(`${x.painted.map((v) => v.toFixed(1)).join(',')}|${JSON.stringify(x.groups)}`, x)
  return [...seen.values()]
}

/** Elements under `scope` that paint text of their own (hidden subtrees and screen-reader-only text excluded). */
export function textElements(scope: El): El[] {
  return find(scope, (e) => {
    if (!ownText(e)) return false
    for (let a: El | null = e; a; a = a.parent) if ('hidden' in a.attrs || classes(a).some((c) => c === 'sr-only' || c === 'hidden') || a.tag === 'template' || a.tag === 'title') return false
    return true
  })
}
