// Turns dist-demo/index.html into dist-demo/page.html: only the page content, for a host that
// supplies its own doctype, <head> and <body>. Keeps the <title>, the stylesheet and module-script
// tags (relative URLs), then the body content. Module scripts are deferred, so the app still boots
// with them placed in the body ahead of #root.
import { readFile, writeFile } from 'node:fs/promises'

const dir = new URL('../dist-demo/', import.meta.url)
const html = await readFile(new URL('index.html', dir), 'utf8')

const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() || 'OmegaHive'
const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? ''
const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? ''

const tags = [...(head + body).matchAll(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>|<script\b[^>]*type=["']?module["']?[^>]*>\s*<\/script>/gi)].map((m) => m[0])
for (const t of tags) {
  const url = /(?:href|src)=["']([^"']+)["']/.exec(t)?.[1] ?? ''
  if (/^(\/|[a-z]+:)/i.test(url)) throw new Error(`absolute URL in ${t}; build with base "./"`)
}
const content = body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').trim()

const styles = tags.filter((t) => t.startsWith('<link'))
const scripts = tags.filter((t) => t.startsWith('<script'))
const page = [`<title>${title}</title>`, ...styles, ...scripts, content, ''].join('\n')
await writeFile(new URL('page.html', dir), page)
console.log(`dist-demo/page.html: ${tags.length} asset tags, ${page.length} bytes`)
