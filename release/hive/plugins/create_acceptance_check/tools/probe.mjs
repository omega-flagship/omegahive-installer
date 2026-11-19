// Purpose: plays a Create plan's probe on the app it checks, the check that presses an app's buttons instead of
// reading its source. Run only through the sandbox:run boundary (no network, a fresh job folder, CPU and size limits),
// on the node runtime. Input: snapshot.json {"document": the app's page as the hive's frame composes it,
// "probe": {"cases": [...]}, "owned": [files the plan's pieces write]}. Each case loads the page in a fresh headless
// browser window (happy-dom, vendor/happy-dom.mjs), runs its steps and then its assertions, and fails on any assertion
// that doesn't hold, any step it can't take, and any error the page throws. The page is held to the app frame's CSP,
// as it loads and while it runs, and a failing case on a page the frame refused something of also fails the file that
// holds it, saying what and what to do instead. The last stdout line is the verdict the host reads for every check:
// CREATE-CHECK {"passed": bool, "failing": [owned files], "notes": [...], "cases": [{"name", "files", "passed"}]},
// where cases gives each case played, the owned files it is blamed on and whether it passed, so the host can tell a
// case that fails only because a later piece isn't built yet (create_plan_members.counted_check).
//
// The grammar is IterBrow's probe.json (steps click|fill on a selector, assertions text|value|count|visible) grown
// with the kinds Playwright's actions and web-first assertions have (select, press, check, uncheck, wait; contains,
// matches, checked, enabled) and with cases, one per acceptance criterion, each on its own fresh page. As in
// Playwright, text is compared with its whitespace collapsed, an action waits for its element to be there, visible and
// enabled, and an assertion is retried until it holds or its time runs out.
import fs from 'node:fs'
import vm from 'node:vm'
import { Window } from './vendor/happy-dom.mjs'

// The frame's CSP has no 'unsafe-eval' (create_plan_ports.frame_document), so eval, new Function and the other function
// constructors throw an EvalError there and WebAssembly doesn't compile. happy-dom makes each window's realm with
// vm.createContext, whose codeGeneration option is that rule; it runs the page's own scripts with vm.Script, which the
// option leaves alone.
const createContext = vm.createContext
vm.createContext = (object, options) => createContext(object, { ...options, codeGeneration: { strings: false, wasm: false } })

const MAX_INPUT = 20 * 1024 * 1024
const MAX_CASES = 30
const MAX_STEPS = 60
const MAX_ASSERTIONS = 40
const WAIT_MS = 1000        // what an action waits for its element and an assertion for its value
const LOAD_MS = 2000        // what a page gets to load and run its start-up scripts
const MAX_WAIT_STEP = 3000  // the longest wait step
const POLL_MS = 25
const NOTES = 30
const URL = 'https://app.invalid/'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim()
const shown = v => (typeof v === 'string' ? JSON.stringify(v.length > 80 ? v.slice(0, 77) + '...' : v) : String(v))

function verdict(passed, failing, notes, cases = []) {
  const line = { passed, failing, notes: notes.slice(0, NOTES) }
  if (cases.length) line.cases = cases.slice(0, MAX_CASES + 2)   // the probe's cases, and the frame's own first, one per file
  process.stdout.write('CREATE-CHECK ' + JSON.stringify(line) + '\n')
}

// A page that never settles (an interval, an animation) still gets its time and no more: happy-dom's own wait for
// pending timers and loads, raced against the clock.
async function settle(window, ms) {
  await Promise.race([window.happyDOM.waitUntilComplete(), sleep(ms)])
}

// Time: at most ms / POLL_MS tries of fn, each one DOM query.
async function until(fn, ms = WAIT_MS) {
  const end = Date.now() + ms
  let last
  for (;;) {
    last = fn()
    if (last.ok || Date.now() >= end) return last
    await sleep(POLL_MS)
  }
}

function visible(window, el) {
  for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
    if (e.hidden) return false
    const style = window.getComputedStyle(e)
    if (style.display === 'none' || style.visibility === 'hidden') return false
  }
  return true
}

const enabled = el => !el.disabled && !el.closest('fieldset[disabled]')

// What the hive's app frame allows, so a page that passes here works there (create_plan_ports.frame_document,
// hive/ui/src/lib/appFrame.ts): its CSP has connect-src 'none', so every request fails, and it runs at an opaque origin,
// where reading localStorage or sessionStorage throws a SecurityError. Set as the page's first script, since the page's
// scripts run in a realm of their own, whose globals the outer window's properties don't reach (a getter defined on the
// window from here left the page with no localStorage at all, a ReferenceError). It carries the frame's nonce, since
// the page is held to the frame's CSP while it runs (holdTheFrame).
const FRAME_LIKE = `(() => {
  const offline = () => { throw new DOMException("The hive's app frame has no network", 'NetworkError') }
  window.fetch = () => Promise.reject(new TypeError("The hive's app frame has no network"))
  for (const name of ['XMLHttpRequest', 'WebSocket', 'EventSource']) window[name] = function () { offline() }
  if (navigator.sendBeacon) navigator.sendBeacon = () => false
  for (const name of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(window, name, { get() { throw new DOMException('The operation is insecure.', 'SecurityError') } })
  }
})()`

function frameLike(document, nonce) {
  const script = `<script${nonce ? ` nonce="${nonce}"` : ''}>${FRAME_LIKE}</script>`
  const at = document.indexOf('<head>')
  return at < 0 ? script + document : document.slice(0, at + 6) + script + document.slice(at + 6)
}

// One thing the frame refused: its kind (what to do instead, INSTEAD), what it is, and the element it was on.
const refusal = (kind, what, where = '') => ({ kind, what, where })
const said = r => (r.where ? `${r.what} on ${r.where}` : r.what)
const describe = el => `<${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}>`

// What the hive's app frame lets run (create_plan_ports.frame_document's CSP): the app's own script and style, which
// carry the frame's nonce, and inline style attributes. It ignores an on* attribute, a javascript: URL, and a script,
// style or stylesheet link without the nonce, so the page a case plays has them taken out, and they're named. happy-dom
// has no CSP and ran them, so a board wired with onclick attributes passed every case and was dead in the frame. The
// markup is index.html's, its templates' contents included, which app.js may clone into the page: what they hold is
// index.html's to change. The nonces come back too, for what the page adds while it runs (holdTheFrame).
// Time: one parse of the page and one pass over its elements, its templates' included, and their attributes.
function asTheFrameRuns(document) {
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/i.exec(document)?.[1] || ''
  const nonce = kind => new RegExp(`(?:^|;)\\s*${kind}-src[^;]*'nonce-([^']+)'`).exec(csp)?.[1]
  const scripts = nonce('script'), styles = nonce('style')
  if (!scripts) return { page: document, ignored: [] }      // no frame CSP to hold the page to
  const scratch = new Window({ url: URL })                    // JavaScript off: the page is parsed, never run
  try {
    const doc = scratch.document
    doc.write(document)
    const ignored = []
    const roots = [doc]
    for (let i = 0; i < roots.length; i++) for (const t of roots[i].querySelectorAll('template')) roots.push(t.content)
    const all = selector => roots.flatMap(root => [...root.querySelectorAll(selector)])
    for (const el of all('script')) {
      if (el.getAttribute('nonce') === scripts) continue
      ignored.push(refusal('script', el.getAttribute('src') ? `<script src="${el.getAttribute('src')}">` : 'an inline <script>'))
      el.remove()
    }
    for (const el of all('style, link')) {
      if (el.tagName === 'STYLE' ? el.getAttribute('nonce') === styles : !/stylesheet/i.test(el.getAttribute('rel') || '')) continue
      ignored.push(refusal('style', el.tagName === 'STYLE' ? 'an inline <style>' : `<link href="${el.getAttribute('href') || ''}">`))
      el.remove()
    }
    for (const el of all('*')) {
      for (const { name, value } of [...el.attributes]) {
        const handler = /^on/i.test(name)
        if (!handler && !(/^(href|src|action|formaction)$/i.test(name) && /^\s*javascript:/i.test(value))) continue
        ignored.push(refusal('handler', handler ? name.toLowerCase() : 'a javascript: ' + name.toLowerCase(), describe(el)))
        el.removeAttribute(name)
      }
    }
    return { page: '<!doctype html>' + doc.documentElement.outerHTML, ignored, scripts, styles }
  } finally {
    scratch.happyDOM.close()
  }
}

// What the frame refuses of a page while it runs, at the point happy-dom decides to run it, since a MutationObserver
// would act a microtask late, after a handler set and fired in one task had already run. The page's document maps to
// the frame it is held to ({scripts, styles} nonces and refuse(kind, what, where)); a document the probe didn't play (a
// scratch page, a template's) is held to nothing. The element classes' members are the bundle's own, shared by every
// window, so they are held once (holdTheElements); the window's own members, per window (holdTheFrame).
const frames = new WeakMap()
let locationHref = null      // Location's href accessor, the one a page's navigation by location goes through

// happy-dom's state the holds read, by the symbol its classes declare it with; a bundle without one stops the run as
// the runner's error, never letting a page through or blaming the app.
function symbol(object, description) {
  for (let o = object; o; o = Object.getPrototypeOf(o)) {
    const found = Object.getOwnPropertySymbols(o).find(s => s.description === description)
    if (found) return found
  }
  throw new Error(`the vendored happy-dom has no ${description}, which holding a page to the app frame reads`)
}
const owner = (proto, key) => {
  for (let p = proto; p; p = Object.getPrototypeOf(p)) if (Object.hasOwn(p, key)) return p
  throw new Error(`the vendored happy-dom has no ${String(key)}, which holding a page to the app frame reads`)
}

// Time: one pass over the window's element classes and the properties of the prototypes they inherit from, about
// 140 classes and 240 on* accessors, once per run.
function holdTheElements(window) {
  const { document } = window
  // happy-dom compiles an on* attribute's text in getEventListener, whose only callers are the elements' on* getters,
  // and dispatchEvent reads a handler through them when none was set as a property. Held, they give what
  // getEventListener gives before it compiles, the handler set as a property, or null: the frame compiles no
  // attribute's text however it got there (innerHTML, setAttribute), since its CSP has no 'unsafe-hashes'.
  const handlers = symbol(document.createElement('p'), 'propertyEventListeners')
  const protos = new Set()
  for (const name of Object.getOwnPropertyNames(window)) {
    const cls = Object.getOwnPropertyDescriptor(window, name).value
    if (typeof cls !== 'function' || !(cls.prototype instanceof window.Element)) continue
    for (let p = cls.prototype; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) protos.add(p)
  }
  for (const proto of protos) {
    for (const [name, d] of Object.entries(Object.getOwnPropertyDescriptors(proto))) {
      if (!name.startsWith('on') || !d.get || !d.set) continue
      Object.defineProperty(proto, name, { ...d, get() {
        const frame = frames.get(this.ownerDocument)
        if (!frame) return d.get.call(this)
        const set = this[handlers]?.get(name)
        if (set) return set
        if (this.hasAttribute(name)) frame.refuse('handler', `${name} that app.js adds`, describe(this))
        return null
      } })
    }
  }
  // a script runs when it is connected, unless happy-dom marked it not to (one an innerHTML parsed): the frame runs only
  // the scripts that carry its nonce
  const connected = symbol(window.HTMLScriptElement.prototype, 'connectedToDocument')
  const off = symbol(document.createElement('script'), 'disableEvaluation')
  const scripts = owner(window.HTMLScriptElement.prototype, connected)
  const connect = scripts[connected]
  scripts[connected] = function () {
    const frame = frames.get(this.ownerDocument)
    if (frame && !this[off] && this.getAttribute('nonce') !== frame.scripts) {
      this[off] = true
      frame.refuse('script', this.hasAttribute('src') ? `<script src="${this.getAttribute('src')}"> that app.js adds` : 'a <script> that app.js adds')
    }
    return connect.call(this)
  }
  // computed style reads the sheet of each <style> and stylesheet <link>: the frame applies only those that carry its
  // nonce (a link's would load nothing here either, the frame having no network, but it is named all the same)
  const linkStyles = new Set([window.HTMLStyleElement, window.HTMLLinkElement].map(cls => owner(cls.prototype, 'sheet')))
  for (const proto of linkStyles) {
    const sheet = Object.getOwnPropertyDescriptor(proto, 'sheet')
    Object.defineProperty(proto, 'sheet', { ...sheet, get() {
      const frame = frames.get(this.ownerDocument)
      const link = this.tagName === 'LINK'
      if (!frame || this.getAttribute('nonce') === frame.styles || (link && !/stylesheet/i.test(this.getAttribute('rel') || ''))) {
        return sheet.get.call(this)
      }
      frame.refuse('style', link ? 'a stylesheet <link> that app.js adds' : 'a <style> that app.js adds')
      return null
    } })
  }
  locationHref = Object.getOwnPropertyDescriptor(owner(Object.getPrototypeOf(window.location), 'href'), 'href')
}

function holdTheFrame(window, frame) {
  frames.set(window.document, frame)
  // anchors and areas navigate through window.open, location.assign and replace through location.href: the frame runs
  // no javascript: URL, since its CSP has no 'unsafe-inline'
  const javascript = url => {
    try {
      return new globalThis.URL(String(url), window.location.href).protocol === 'javascript:'
    } catch {
      return false          // no URL at all: happy-dom's own navigation says so
    }
  }
  const open = window.open
  window.open = function (url, ...rest) {
    if (!javascript(url)) return open.call(window, url, ...rest)
    frame.refuse('handler', 'a javascript: URL that app.js opens')
    return null
  }
  Object.defineProperty(window.location, 'href', { ...locationHref, set(url) {
    if (!javascript(url)) return locationHref.set.call(this, url)
    frame.refuse('handler', 'a javascript: URL that app.js opens')
  } })
  // a string given to a timer is code built from a string, which the frame never runs (no 'unsafe-eval')
  for (const name of ['setTimeout', 'setInterval']) {
    const timer = window[name]
    window[name] = function (handler, ...rest) {
      if (typeof handler === 'function') return timer.call(window, handler, ...rest)
      frame.refuse('code', `a string passed to ${name}`)
      return 0
    }
  }
}

// What to do instead of what the frame refused, by kind, in the order a note gives them.
const INSTEAD = {
  handler: 'attach listeners in app.js with addEventListener',
  script: 'keep scripts in app.js',
  style: 'keep styles in style.css',
  code: 'build no code from strings',
}

// The case a file fails as the frame runs it, and its note: what the frame refused of it, counted, and what to do
// instead.
const frameCase = file => `${file} as the app frame runs it`
function frameNote(file, refused) {
  const counts = new Map()
  for (const { what } of refused) counts.set(what, (counts.get(what) || 0) + 1)
  const what = [...counts].map(([thing, n]) => (n > 1 ? `${thing} (${n} times)` : thing)).join(', ')
  const instead = Object.keys(INSTEAD).filter(kind => refused.some(r => r.kind === kind)).map(kind => INSTEAD[kind])
  const advice = instead.length > 1 ? instead.slice(0, -1).join(', ') + ' and ' + instead.at(-1) : instead[0]
  return `${frameCase(file)}: ${advice}, since the app frame's content security policy refuses ${what}`
}

function one(document, selector) {
  try {
    return { el: document.querySelector(selector) }
  } catch (err) {
    return { bad: `${shown(selector)} is not a CSS selector` }
  }
}

// The element an action may act on: there, visible and enabled (Playwright's actionability checks).
async function actionable(window, selector) {
  const got = await until(() => {
    const { el, bad } = one(window.document, selector)
    if (bad) return { ok: false, why: bad, final: true }
    if (!el) return { ok: false, why: `nothing matches ${shown(selector)}` }
    if (!visible(window, el)) return { ok: false, why: `${shown(selector)} is not visible` }
    if (!enabled(el)) return { ok: false, why: `${shown(selector)} is disabled` }
    return { ok: true, el }
  })
  if (!got.ok) throw new Error(got.why)
  return got.el
}

function fire(window, el, type, init = {}) {
  const E = type.startsWith('key') ? window.KeyboardEvent : window.Event
  el.dispatchEvent(new E(type, { bubbles: true, cancelable: true, ...init }))
}

const ACTIONS = {
  async click(window, step) {
    ;(await actionable(window, step.selector)).click()
  },
  async fill(window, step) {
    const el = await actionable(window, step.selector)
    if (!('value' in el)) throw new Error(`${shown(step.selector)} takes no typing`)
    el.focus?.()
    el.value = String(step.value ?? '')
    fire(window, el, 'input')
    fire(window, el, 'change')
  },
  async select(window, step) {
    const el = await actionable(window, step.selector)
    if (el.tagName !== 'SELECT') throw new Error(`${shown(step.selector)} is not a select`)
    const want = String(step.value ?? '')
    const option = [...el.options].find(o => o.value === want) || [...el.options].find(o => norm(o.textContent) === norm(want))
    if (!option) throw new Error(`${shown(step.selector)} has no option ${shown(want)}`)
    el.value = option.value
    fire(window, el, 'input')
    fire(window, el, 'change')
  },
  async press(window, step) {
    const el = await actionable(window, step.selector)
    el.focus?.()
    const key = String(step.value ?? 'Enter')
    fire(window, el, 'keydown', { key })
    fire(window, el, 'keypress', { key })
    if (key === 'Enter' && el.form && el.tagName === 'INPUT') el.form.requestSubmit?.()
    fire(window, el, 'keyup', { key })
  },
  async check(window, step) {
    const el = await actionable(window, step.selector)
    if (!el.checked) el.click()
    if (!el.checked) throw new Error(`${shown(step.selector)} did not become checked`)
  },
  async uncheck(window, step) {
    const el = await actionable(window, step.selector)
    if (el.checked) el.click()
    if (el.checked) throw new Error(`${shown(step.selector)} did not become unchecked`)
  },
  async wait(window, step) {
    if (step.selector) {
      await actionable(window, step.selector)
    } else {
      await settle(window, Math.min(Math.max(Number(step.ms) || 0, 0), MAX_WAIT_STEP))
    }
  },
}

// What an assertion reads from the page, and whether it holds.
function read(window, a) {
  const { document } = window
  if (a.kind === 'count') {
    let n
    try {
      n = document.querySelectorAll(a.selector).length
    } catch (err) {
      return { ok: false, why: `${shown(a.selector)} is not a CSS selector` }
    }
    return { ok: n === a.expected, why: `${n} match ${shown(a.selector)}, expected ${a.expected}` }
  }
  const { el, bad } = one(document, a.selector)
  if (bad) return { ok: false, why: bad }
  if (a.kind === 'visible') {
    const v = !!el && visible(window, el)
    return { ok: v === a.expected, why: `${shown(a.selector)} is ${v ? 'visible' : 'not visible'}` }
  }
  if (!el) return { ok: false, why: `nothing matches ${shown(a.selector)}` }
  const text = norm(el.textContent)
  switch (a.kind) {
    case 'text':
      return { ok: text === norm(a.expected), why: `${shown(a.selector)} reads ${shown(text)}, expected ${shown(norm(a.expected))}` }
    case 'contains':
      return { ok: text.includes(norm(a.expected)), why: `${shown(a.selector)} reads ${shown(text)}, which lacks ${shown(norm(a.expected))}` }
    case 'matches': {
      let re
      try {
        re = new RegExp(a.expected)
      } catch (err) {
        return { ok: false, why: `${shown(a.expected)} is not a pattern` }
      }
      return { ok: re.test(text), why: `${shown(a.selector)} reads ${shown(text)}, which doesn't match /${a.expected}/` }
    }
    case 'value': {
      const v = 'value' in el ? String(el.value) : null
      return { ok: v === String(a.expected), why: `${shown(a.selector)} holds ${v === null ? 'no value' : shown(v)}, expected ${shown(String(a.expected))}` }
    }
    case 'checked':
      return { ok: !!el.checked === a.expected, why: `${shown(a.selector)} is ${el.checked ? '' : 'not '}checked` }
    case 'enabled':
      return { ok: enabled(el) === a.expected, why: `${shown(a.selector)} is ${enabled(el) ? 'enabled' : 'disabled'}` }
    default:
      return { ok: false, why: `no assertion kind ${shown(a.kind)}` }
  }
}

// One case on its own fresh page, held to the frame when the page has one. Returns the reason it failed, or null when
// every assertion held.
// Time: the page's load (at most LOAD_MS) + each step's wait (at most WAIT_MS, a wait step MAX_WAIT_STEP) + each
// assertion's retries (at most WAIT_MS), all bounded by the sandbox's own CPU and wall limits.
async function play(page, kase, frame) {
  // JavaScript evaluation is happy-dom's to turn on (off by default since 20): the page is the app under test. Its
  // VM context is no isolation (CVE-2025-61927), so this runs only inside the hive's sandbox, which is the boundary
  // happy-dom's warning asks for; network loads are off, as the frame's own CSP has them.
  const window = new Window({
    url: URL,
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      disableIframePageLoading: true,
      navigation: { disableMainFrameNavigation: true, disableChildFrameNavigation: true, disableChildPageNavigation: true, disableFallbackToSetURL: true },
      handleDisabledFileLoadingAsSuccess: true,
    },
  })
  if (frame) holdTheFrame(window, frame)
  const errors = []
  // an EvalError the page leaves uncaught is the frame refusing code built from a string
  const thrown = (error, message) => {
    if (frame && error instanceof window.EvalError) frame.refuse('code', 'eval or new Function')
    errors.push(norm(message))
  }
  window.addEventListener('error', e => thrown(e.error, e.error?.message || e.message || 'an error'))
  window.addEventListener('unhandledrejection', e => thrown(e.reason, e.reason?.message || e.reason || 'a rejected promise'))
  try {
    window.document.write(frameLike(page, frame?.scripts))
    await settle(window, LOAD_MS)
    if (errors.length) return `the page threw while loading: ${errors[0]}`
    for (const [i, step] of kase.steps.entries()) {
      const act = ACTIONS[step.kind]
      if (!act) return `step ${i + 1}: no step kind ${shown(step.kind)}`
      try {
        await act(window, step)
      } catch (err) {
        return `step ${i + 1} (${step.kind} ${shown(step.selector ?? '')}): ${norm(err.message)}`
      }
      await settle(window, 50)
      if (errors.length) return `step ${i + 1} (${step.kind} ${shown(step.selector ?? '')}): the page threw: ${errors[0]}`
    }
    for (const [i, a] of kase.assertions.entries()) {
      const got = await until(() => read(window, a))
      if (!got.ok) return `check ${i + 1}: ${got.why}`
    }
    if (errors.length) return `the page threw: ${errors[0]}`
    return null
  } finally {
    await window.happyDOM.abort()
    await window.happyDOM.close()
  }
}

// What makes a probe unplayable, its author's fault and never the app's: its shape, a selector that is no CSS
// selector, a pattern that is no regular expression. The host checks the same shape when the author answers
// (create_plan_ports.probe_problem); this is the runner's own guard, so a bad probe never fails an app.
function shaped(probe) {
  const cases = probe?.cases
  if (!Array.isArray(cases) || !cases.length || cases.length > MAX_CASES) return `a probe has 1-${MAX_CASES} cases`
  const scratch = new Window({ url: URL })
  try {
    for (const c of cases) {
      if (!c || typeof c.name !== 'string' || !Array.isArray(c.steps) || !Array.isArray(c.assertions)) return 'each case has a name, steps and assertions'
      if (c.steps.length > MAX_STEPS || !c.assertions.length || c.assertions.length > MAX_ASSERTIONS) return `a case has at most ${MAX_STEPS} steps and 1-${MAX_ASSERTIONS} assertions`
      for (const item of [...c.steps, ...c.assertions]) {
        if (typeof item?.selector === 'string') {
          try {
            scratch.document.querySelector(item.selector)
          } catch (err) {
            return `${shown(item.selector)} in ${shown(c.name)} is not a CSS selector`
          }
        }
        if (item?.kind === 'matches') {
          try {
            new RegExp(item.expected)
          } catch (err) {
            return `${shown(item.expected)} in ${shown(c.name)} is not a regular expression`
          }
        }
      }
    }
    return null
  } finally {
    scratch.happyDOM.close()
  }
}

async function main() {
  const raw = fs.readFileSync('snapshot.json')
  if (raw.length > MAX_INPUT) throw new Error('snapshot too large')
  const { document, probe, owned } = JSON.parse(raw)
  const files = new Set(Array.isArray(owned) ? owned.filter(f => typeof f === 'string') : [])
  // a failed case names the files it says it exercises, or else the page's own files: always ones a piece owns, since
  // the plan routes a failure to the owners of its files and blocks on a file nobody owns
  const page = ['index.html', 'app.js', 'style.css'].filter(f => files.has(f))
  const blame = c => {
    const named = (Array.isArray(c.files) ? c.files : []).filter(f => files.has(f))
    return named.length ? named : page.length ? page : [...files]
  }
  const bad = shaped(probe)
  if (bad) {
    console.log(`PROBE unreadable: ${bad}`)
    return verdict(false, [], [`the probe is unreadable: ${bad}`])
  }
  if (typeof document !== 'string' || !document) {
    // the host could not compose the page (create_plan_ports.frame_document): no index.html, style.css or module
    // app.js where the frame needs them, a failure of the page's own files
    const why = norm(probe.page_problem || 'the app has no page to load')
    console.log(`PROBE no page: ${why}`)
    return verdict(false, page.length ? page : [...files], [`the page could not be loaded: ${why}`])
  }
  const failing = new Set()
  const notes = []
  const cases = []
  const { page: framed, ignored, scripts, styles } = asTheFrameRuns(document)
  if (ignored.length) console.log(`PROBE the frame ignores: ${ignored.map(said).join('; ')}`)
  // what the frame refused while the cases ran, the first of each kept, since one line of app.js is refused alike on
  // every element and in every case
  const refused = new Map()
  let frame = null
  if (scripts) {
    const scratch = new Window({ url: URL })
    try {
      holdTheElements(scratch)
    } finally {
      scratch.happyDOM.close()
    }
    frame = { scripts, styles, refuse: (kind, what, where) => refused.has(what) || refused.set(what, refusal(kind, what, where)) }
  }
  for (const [i, c] of probe.cases.entries()) {
    let why
    try {
      why = await play(framed, c, frame)
    } catch (err) {
      why = `the probe could not play it: ${norm(err.message)}`
    }
    console.log(`PROBE case ${i + 1} ${JSON.stringify(c.name)}: ${why ? 'failed: ' + why : 'passed'}`)
    cases.push({ name: c.name, files: blame(c), passed: !why })
    if (why) {
      notes.push(`${c.name}: ${why}`)
      for (const f of blame(c)) failing.add(f)
    }
  }
  if (refused.size) console.log(`PROBE the frame refuses while the page runs: ${[...refused.values()].map(said).join('; ')}`)
  // a case that failed on a page the frame refused something of fails the file that holds it too, saying what and what
  // to do instead, so the repair goes to the piece that can make it: index.html for what its markup has, app.js for
  // what it adds while it runs, since app.js is the one script the frame runs. A page that passes without them passes.
  // Unshifted in turn, so index.html's case comes first.
  for (const [file, its] of [['app.js', [...refused.values()]], ['index.html', ignored]]) {
    if (!notes.length || !its.length || !files.has(file)) continue
    cases.unshift({ name: frameCase(file), files: [file], passed: false })
    notes.unshift(frameNote(file, its))
    failing.add(file)
  }
  verdict(notes.length === 0, notes.length ? [...failing] : [], notes, cases)
}

main().then(
  () => process.exit(0),
  err => {
    console.log(`PROBE runner error: ${norm(err?.message || err)}`)
    process.exit(1)
  },
)
