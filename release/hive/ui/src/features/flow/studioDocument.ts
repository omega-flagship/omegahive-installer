export interface StudioAssets { html: string; script: string; style: string }
export interface StudioDocument { html: string; channel: string }
const escapeAttribute = (value: string) => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))

/** Host-reviewed assets run without the host origin, storage or direct network access. */
export function studioDocument(assets: StudioAssets, hostOrigin: string, channel: string, nonce: string): StudioDocument {
  if (new URL(hostOrigin).origin !== hostOrigin || !/^https?:/.test(hostOrigin) ||
      !/^[a-f0-9-]{36}$/.test(channel) || !/^[a-f0-9-]{36}$/.test(nonce)) throw new Error('Invalid studio document binding')
  if (!assets.html.includes('<head>') || !assets.html.includes('src="./app.js"') || !assets.html.includes('href="./style.css"')) throw new Error('Unexpected studio asset format')
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'none'; img-src data: blob:; base-uri 'none'; form-action 'none'`
  let html = assets.html.replace('<html ', `<html data-flow-host-origin="${escapeAttribute(hostOrigin)}" data-flow-channel="${channel}" `)
  html = html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">`)
    .replace('<link rel="stylesheet" href="./style.css">', `<style nonce="${nonce}">${assets.style.replace(/<\/style/gi, '<\\/style')}</style>`)
    .replace('<script type="module" src="./app.js"></script>', `<script type="module" nonce="${nonce}">${assets.script.replace(/<\/script/gi, '<\\/script')}</script>`)
    .replace('class="brand" href="./"', 'class="brand" href="#"')
  return { html, channel }
}

/** Null origin is expected only for this sandboxed frame; source and document channel must match. */
export function isStudioSender(event: Pick<MessageEvent, 'origin' | 'source' | 'data'>, source: Window | null, channel: string): boolean {
  return !!source && event.origin === 'null' && event.source === source && event.data?.channel === channel
}
