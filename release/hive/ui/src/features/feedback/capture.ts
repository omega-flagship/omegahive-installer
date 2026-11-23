// Purpose: a picture of the hive's own page for a report, drawn from the page itself, never from the screen or a window
// (a screen capture once carried a tester's bookmarks and other people's names into the board), with the feedback area
// left out. modern-screenshot is loaded only when a report is made, so no other page pays for it.
//
// The fonts are handed to modern-screenshot, never left to it (acceptance-tests #11): to find them itself it parses the
// page's sheets through a <style> it makes without the page's nonce, the page CSP (hive/core/app.py page_csp) refuses
// that element, its sheet stays null and the library throws, so no picture was drawn on any served hive. Given the
// fonts' text (`font.cssText`) or told to embed none (`font: false`), it never makes that element. The CSP is unchanged.

/** Marks what the picture leaves out: the feedback entry and the feedback area itself. */
export const LEAVE_OUT = 'data-feedback-leave-out'

/**
 * The page as the person sees it now, as a PNG data address at one pixel per CSS pixel: what was on screen, at the
 * size it was, not a print of the whole scrolled page. modern-screenshot clones the page and lets the browser draw the
 * clone (an SVG foreignObject), so colours and fonts draw as they do on screen; frames from elsewhere and 3D scenes
 * come out blank. Rejects when the browser cannot draw it, which the page says.
 */
export async function capturePage(doc: Document = document): Promise<string> {
  const { domToPng } = await import('modern-screenshot')
  const win = doc.defaultView ?? window
  const cssText = await fontFaceCss(doc).catch(() => '')
  return domToPng(doc.body, {
    width: win.innerWidth,
    height: win.innerHeight,
    scale: 1,
    backgroundColor: win.getComputedStyle(doc.body).backgroundColor || null,
    filter: (node) => !(node instanceof Element && node.closest(`[${LEAVE_OUT}]`)),
    // Never left undefined: that is the path the page CSP breaks (see the head of this file).
    font: cssText ? { cssText } : false,
  })
}

const FONT_FACE_RULE = 5 // CSSRule.FONT_FACE_RULE
const URL_IN_CSS = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g
const unquote = (family: string) => family.trim().replace(/^(['"])(.*)\1$/, '$2')

/** Every rule of the sheets the page may read, the ones inside @media, @supports and @layer too. */
function rulesOf(doc: Document): CSSRule[] {
  const out: CSSRule[] = []
  const walk = (rules: CSSRuleList | CSSRule[]) => {
    for (const rule of Array.from(rules)) {
      out.push(rule)
      if ('cssRules' in rule) walk((rule as CSSGroupingRule).cssRules)
    }
  }
  for (const sheet of Array.from(doc.styleSheets)) {
    try { walk(sheet.cssRules) } catch { /* a sheet from another site: its rules are not the page's to read */ }
  }
  return out
}

/** The bytes as a data: address; the type is the server's when it names a font, else the file's own. */
async function dataUrl(res: Response, url: URL): Promise<string> {
  const bytes = new Uint8Array(await res.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  const served = res.headers.get('content-type') ?? ''
  const ext = url.pathname.slice(url.pathname.lastIndexOf('.') + 1).toLowerCase()
  const type = served.startsWith('font/') ? served.split(';')[0] : ({ woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf' } as Record<string, string>)[ext] ?? 'application/octet-stream'
  return `data:${type};base64,${btoa(bin)}`
}

/**
 * The page's own @font-face rules for the families it is drawing with (the ones the browser has loaded), each font file
 * inlined as a data: address, as modern-screenshot would have embedded them itself: the picture is drawn as an image,
 * which may fetch nothing. Only the hive's own files are read; a rule with a file from elsewhere is left out. Empty
 * when the page draws with no web font; rejects when a file cannot be read (capturePage then embeds none).
 */
export async function fontFaceCss(doc: Document): Promise<string> {
  const inUse = new Set(Array.from(doc.fonts ?? []).filter((f) => f.status === 'loaded').map((f) => unquote(f.family)))
  if (!inUse.size) return ''
  const origin = new URL(doc.baseURI).origin
  const files = new Map<string, Promise<string>>()
  const faces = rulesOf(doc).filter((rule): rule is CSSFontFaceRule => rule.type === FONT_FACE_RULE)
    .filter((rule) => inUse.has(unquote(rule.style.getPropertyValue('font-family'))))
  const texts = await Promise.all(faces.map(async (rule) => {
    const base = rule.parentStyleSheet?.href ?? doc.baseURI
    const urls = Array.from(rule.cssText.matchAll(URL_IN_CSS), (m) => m[2]).filter((u) => !u.startsWith('data:'))
    const resolved = urls.map((u) => new URL(u, base))
    if (resolved.some((u) => u.origin !== origin)) return ''
    const inlined = await Promise.all(resolved.map((u) => {
      if (!files.has(u.href)) {
        files.set(u.href, fetch(u.href).then((res) => {
          if (!res.ok) throw new Error(`font ${u.pathname}: ${res.status}`)
          return dataUrl(res, u)
        }))
      }
      return files.get(u.href)!
    }))
    const byUrl = new Map(urls.map((u, i) => [u, inlined[i]]))
    return rule.cssText.replace(URL_IN_CSS, (whole, _q, u: string) => (byUrl.has(u) ? `url("${byUrl.get(u)}")` : whole))
  }))
  return texts.filter(Boolean).join('\n')
}

/** A PNG data address as the bytes a file or a share needs. */
export function pngBlob(dataUrl: string): Blob {
  const bytes = atob(dataUrl.slice(dataUrl.indexOf(',') + 1))
  const out = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) out[i] = bytes.charCodeAt(i)
  return new Blob([out], { type: 'image/png' })
}
