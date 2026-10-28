/**
 * Just enough DOM for react-dom/client to mount a component tree in the node test environment, so its effects run
 * (renderToStaticMarkup runs none). Elements are plain objects: tag, attributes, style, children, text. Tests read the
 * tree (find by role or attribute, text) and press a button by calling React's own onClick prop for it.
 * No layout, no events dispatched through the DOM, no focus model beyond `document.activeElement`.
 */

type Listener = (e: unknown) => void

export class MiniNode {
  nodeType: number
  nodeName: string
  tagName: string
  namespaceURI = 'http://www.w3.org/1999/xhtml'
  ownerDocument: MiniDocument
  parentNode: MiniNode | null = null
  childNodes: MiniNode[] = []
  attributes = new Map<string, string>()
  dataset: Record<string, string> = {}
  style: Record<string, unknown> & { setProperty(k: string, v: string): void; removeProperty(k: string): string; getPropertyValue(k: string): string }
  private text = ''
  private listeners = new Map<string, Set<Listener>>()

  constructor(doc: MiniDocument, nodeType: number, name: string) {
    this.ownerDocument = doc
    this.nodeType = nodeType
    this.nodeName = name.toUpperCase()
    this.tagName = this.nodeName
    const props = new Map<string, string>()
    this.style = {
      setProperty: (k: string, v: string) => void props.set(k, v),
      removeProperty: (k: string) => { const v = props.get(k) ?? ''; props.delete(k); return v },
      getPropertyValue: (k: string) => props.get(k) ?? '',
    } as MiniNode['style']
  }

  get firstChild(): MiniNode | null { return this.childNodes[0] ?? null }
  get lastChild(): MiniNode | null { return this.childNodes[this.childNodes.length - 1] ?? null }
  get nextSibling(): MiniNode | null {
    const p = this.parentNode
    return p ? p.childNodes[p.childNodes.indexOf(this) + 1] ?? null : null
  }
  get children(): MiniNode[] { return this.childNodes.filter((c) => c.nodeType === 1) }

  get nodeValue(): string { return this.text }
  set nodeValue(v: string) { this.text = String(v) }
  get data(): string { return this.text }
  set data(v: string) { this.text = String(v) }
  get textContent(): string { return this.nodeType === 3 ? this.text : this.childNodes.map((c) => c.textContent).join('') }
  set textContent(v: string) {
    for (const c of this.childNodes) c.parentNode = null
    this.childNodes = []
    if (v !== '' && v != null) this.appendChild(this.ownerDocument.createTextNode(String(v)))
  }

  appendChild<T extends MiniNode>(c: T): T {
    c.parentNode?.removeChild(c)
    this.childNodes.push(c)
    c.parentNode = this
    return c
  }
  insertBefore<T extends MiniNode>(c: T, before: MiniNode | null): T {
    if (!before) return this.appendChild(c)
    c.parentNode?.removeChild(c)
    this.childNodes.splice(this.childNodes.indexOf(before), 0, c)
    c.parentNode = this
    return c
  }
  removeChild<T extends MiniNode>(c: T): T {
    const i = this.childNodes.indexOf(c)
    if (i >= 0) this.childNodes.splice(i, 1)
    c.parentNode = null
    return c
  }
  contains(n: MiniNode | null): boolean {
    for (let x = n; x; x = x.parentNode) if (x === this) return true
    return false
  }

  setAttribute(k: string, v: unknown): void { this.attributes.set(k, String(v)) }
  setAttributeNS(_ns: string, k: string, v: unknown): void { this.setAttribute(k, v) }
  getAttribute(k: string): string | null { return this.attributes.get(k) ?? null }
  hasAttribute(k: string): boolean { return this.attributes.has(k) }
  removeAttribute(k: string): void { this.attributes.delete(k) }
  removeAttributeNS(_ns: string, k: string): void { this.removeAttribute(k) }

  addEventListener(type: string, fn: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(fn)
  }
  removeEventListener(type: string, fn: Listener): void { this.listeners.get(type)?.delete(fn) }
  focus(): void { this.ownerDocument.activeElement = this }
  blur(): void { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 } }

  /** Every element below this one (depth first) that passes `pick`. */
  findAll(pick: (n: MiniNode) => boolean): MiniNode[] {
    const out: MiniNode[] = []
    const walk = (n: MiniNode) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 1 && pick(c)) out.push(c)
        walk(c)
      }
    }
    walk(this)
    return out
  }
}

export class MiniDocument extends MiniNode {
  documentElement: MiniNode
  body: MiniNode
  activeElement: MiniNode | null = null
  defaultView: unknown = null
  constructor() {
    super(null as unknown as MiniDocument, 9, '#document')
    this.ownerDocument = this
    this.documentElement = this.appendChild(this.createElement('html'))
    this.body = this.documentElement.appendChild(this.createElement('body'))
    this.activeElement = this.body
  }
  createElement(tag: string): MiniNode { return new MiniNode(this, 1, tag) }
  createElementNS(_ns: string, tag: string): MiniNode { return new MiniNode(this, 1, tag) }
  createTextNode(text: string): MiniNode {
    const n = new MiniNode(this, 3, '#text')
    n.nodeValue = text
    return n
  }
  createComment(text: string): MiniNode {
    const n = new MiniNode(this, 8, '#comment')
    n.nodeValue = text
    return n
  }
  querySelectorAll(): MiniNode[] { return [] }
  querySelector(): MiniNode | null { return null }
  hasFocus(): boolean { return true }
}

/** React's props object on a host element (the one react-dom keeps on the node), to call a handler as a click would. */
export function reactProps(n: MiniNode): Record<string, unknown> {
  const own = n as unknown as Record<string, unknown>
  const k = Object.keys(own).find((x) => x.startsWith('__reactProps$'))
  if (!k) throw new Error(`no React props on <${n.tagName.toLowerCase()}>`)
  return own[k] as Record<string, unknown>
}

/** Press a button the way a click does (its React onClick), with a minimal event. */
export function press(n: MiniNode): void {
  const onClick = reactProps(n).onClick as ((e: unknown) => void) | undefined
  if (!onClick) throw new Error('nothing to press')
  onClick({ stopPropagation: () => undefined, preventDefault: () => undefined, currentTarget: n, target: n })
}
