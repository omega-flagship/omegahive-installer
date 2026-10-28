/**
 * r17 "app frame parts": the client's copy of the host's rules (hive/core/ui_parts.py, PROGRAMS.md §9), applied to
 * the server's answer before anything is inlined. Each check returns a refusal reason or null; the reasons match
 * the host's word for word, and tests/fixtures/ui_parts_cases.json is checked by both suites.
 */
export const PART_MAX = 600_000
export const TOTAL_MAX = 1_800_000
export const MAX_PARTS = 3
const PART_NAME = /^[a-z0-9][a-z0-9_-]{0,60}\.js$/   // no dots in the stem; JS `$` (no m flag) is the true end
const WS = ' \t\n\f\r'
const RAW_TEXT = new Set(['script', 'style', 'title', 'textarea', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript'])
const REFUSED = new Set(['template', 'plaintext', 'svg', 'math', 'frameset', 'frame'])   // inert, foreign, or drops later scripts
const TAIL = /^[ \t\n\f\r]*<\/body>[ \t\n\f\r]*(?:<\/html>[ \t\n\f\r]*)?$/
const ALPHA = /^[A-Za-z]/
const TAG_NAME = /^[A-Za-z][^ \t\n\f\r/>]*/

/** The browser folds only ASCII case in tag names; toLowerCase() can change a string's length. */
export const asciiLower = (text: string) => text.replace(/[A-Z]/g, (c) => c.toLowerCase())
export const partTag = (name: string) => `<script type="module" src="./${name}"></script>`
const utf8 = new TextEncoder()
const count = (hay: string, needle: string) => { let n = 0; for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++; return n }

/** The scripts list against the files the host sent: they must be exactly index.html, style.css and the parts. */
export function listReason(scripts: unknown, files: Record<string, unknown>): string | null {
  if (!Array.isArray(scripts) || scripts.length < 1 || scripts.length > MAX_PARTS || !scripts.every((s) => typeof s === 'string' && PART_NAME.test(s)))
    return `scripts lists 1 to ${MAX_PARTS} plain .js file names (no dots before .js)`
  if (new Set(scripts).size !== scripts.length) return 'scripts lists a part twice'
  if (scripts[scripts.length - 1] !== 'app.js') return 'app.js is the last of scripts'
  for (const name of ['index.html', 'style.css', ...scripts]) if (typeof files[name] !== 'string') return `${name} is missing`
  const extra = Object.keys(files).filter((k) => k !== 'index.html' && k !== 'style.css' && !scripts.includes(k)).sort()
  if (extra.length) return `unlisted file ${extra[0]} (with scripts, the lock pins exactly index.html, style.css and the parts)`
  return null
}

/** `sizes`: name → UTF-8 byte count. */
export function sizeReason(sizes: Record<string, number>): string | null {
  for (const [name, size] of Object.entries(sizes)) if (size > PART_MAX) return `${name} is over ${PART_MAX} bytes`
  if (Object.values(sizes).reduce((a, b) => a + b, 0) > TOTAL_MAX) return `the interface is over ${TOTAL_MAX} bytes in all`
  return null
}

/** `<!--` inside an inlined script switches the browser's script-data state, so its closing tag may not close it. */
export function partReason(name: string, text: string): string | null {
  return text.includes('<!--') ? `${name} contains <!--, which would change where its inlined script ends` : null
}

export function htmlReason(html: string, scripts: readonly string[]): string | null {
  let at = -1
  for (const name of scripts) {
    if (count(html, partTag(name)) !== 1) return `index.html needs exactly one ${partTag(name)}`
    if (html.indexOf(partTag(name)) < at) return 'index.html tags the script parts out of their listed order'
    at = html.indexOf(partTag(name))
  }
  if (count(asciiLower(html), '<script') !== scripts.length) return 'index.html has a script tag for an unlisted file'
  const start = html.indexOf(partTag(scripts[0]))
  let end = start + partTag(scripts[0]).length
  for (const name of scripts.slice(1)) {
    const next = html.indexOf(partTag(name), end)
    if (!/^[ \t\n\f\r]*$/.test(html.slice(end, next))) return 'index.html keeps the part tags together, with only whitespace between them'
    end = next + partTag(name).length
  }
  if (!TAIL.test(asciiLower(html.slice(end)))) return 'index.html ends with the part tags, then </body>'
  const [reason, starts] = scan(html.slice(0, start))
  if (reason) return reason
  // appDocument writes the stylesheet over the first link, so that must be a real tag. (The CSP no longer depends on
  // index.html: framePrefix writes it ahead of all app markup.)
  const link = '<link rel="stylesheet" href="./style.css">'
  if (starts.get(html.indexOf(link)) !== 'link') return `index.html needs a real ${link} tag before the part tags`
  return null
}

/** From just after a tag name to just after its '>', following the HTML tokenizer's attribute states; -1 if open. */
function skipTag(s: string, k: number): number {
  const n = s.length
  for (;;) {
    while (k < n && (WS.includes(s[k]) || s[k] === '/')) k++
    if (k >= n) return -1
    if (s[k] === '>') return k + 1
    k++
    while (k < n && !WS.includes(s[k]) && !'/>='.includes(s[k])) k++
    while (k < n && WS.includes(s[k])) k++
    if (k < n && s[k] === '=') {
      k++
      while (k < n && WS.includes(s[k])) k++
      if (k < n && (s[k] === '"' || s[k] === "'")) {
        const close = s.indexOf(s[k], k + 1)
        if (close < 0) return -1
        k = close + 1
      } else {
        while (k < n && !WS.includes(s[k]) && s[k] !== '>') k++
      }
    }
  }
}

function rawEnd(low: string, name: string, k: number): number {
  for (;;) {
    k = low.indexOf(`</${name}`, k)
    if (k < 0) return -1
    const after = k + 2 + name.length
    if (after < low.length && (WS.includes(low[after]) || low[after] === '/' || low[after] === '>')) return k
    k = after
  }
}

/** null when the markup before the part block ends in the browser's data state. */
export const inertReason = (prefix: string): string | null => scan(prefix)[0]

/** [reason or null, position → name of every real start tag]. */
function scan(prefix: string): [string | null, Map<number, string>] {
  const s = prefix
  const low = asciiLower(prefix)
  const starts = new Map<number, string>()
  let i = 0
  for (;;) {
    const j = s.indexOf('<', i)
    if (j < 0) return [null, starts]
    if (low.startsWith('<!--', j)) return ['index.html has a comment before the part tags', starts]
    const next = s.slice(j + 1, j + 2)
    if (next === '!' || next === '?' || (next === '/' && !ALPHA.test(s.slice(j + 2, j + 3)))) {
      const close = s.indexOf('>', j)
      if (close < 0) return ['index.html has unclosed markup before the part tags', starts]
      i = close + 1
      continue
    }
    const endTag = next === '/'
    const m = TAG_NAME.exec(s.slice(j + (endTag ? 2 : 1)))
    if (!m) { i = j + 1; continue }
    const name = asciiLower(m[0])
    let k = skipTag(s, j + (endTag ? 2 : 1) + m[0].length)
    if (k < 0) return [`index.html has an unclosed <${name}> tag before the part tags`, starts]
    if (!endTag && REFUSED.has(name)) return [`index.html has <${name}> before the part tags`, starts]
    if (!endTag && RAW_TEXT.has(name)) {
      k = rawEnd(low, name, k)
      if (k < 0) return [`index.html has an unclosed <${name}> before the part tags`, starts]
    }
    if (!endTag) starts.set(j, name)
    i = k
  }
}

/** Every rule, in the host's order (sizes before content). */
export function partsReason(files: Record<string, unknown>, scripts: unknown): string | null {
  const list = listReason(scripts, files)
  if (list) return list
  const names = ['index.html', ...(scripts as string[]), 'style.css']
  const text = files as Record<string, string>
  const sized = sizeReason(Object.fromEntries(names.map((n) => [n, utf8.encode(text[n]).length])))
  if (sized) return sized
  for (const name of scripts as string[]) { const r = partReason(name, text[name]); if (r) return r }
  return htmlReason(text['index.html'], scripts as string[])
}
