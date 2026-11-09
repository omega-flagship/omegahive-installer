/** The pinned files `GET /api/programs/{id}/ui` returns: index.html, style.css and app.js, plus (r17) any declared script
 *  parts, which then come with their ordered `scripts` list. */
import { partTag, partsReason } from './appFrameParts'

export interface FrameFiles { 'index.html': string; 'app.js': string; 'style.css': string; [part: string]: string }
export interface FrameDocument { html: string; channel: string }
const escapeAttribute = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

/**
 * The frame's CSP (client-side; Platform's G5 ruling, 2026-10-05). `style-src-attr 'unsafe-inline'` lets an app use
 * `style="…"` attributes (Atlas builds screens as HTML strings with them). With default-src 'none', connect-src 'none',
 * img-src data: blob: and font-src data:, an attribute style cannot fetch anything: the risk is visual only. Style
 * ELEMENTS still need the nonce, and scripts stay nonce-only (no 'unsafe-inline' for scripts).
 */
export function frameCsp(nonce: string): string {
  return `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; connect-src 'none'; img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'`
}

/** The frame document's first bytes, before any app-authored markup: the CSP is the first element the parser
 *  inserts, so nothing in index.html (a `<select>`, `<template>`, `<frameset>`, a second `<html>` or `<head>`, a
 *  `<head>` inside an attribute) can move or drop it, and a meta CSP keeps applying once inserted. The app's own
 *  doctype and `<head>` that follow are ignored by the parser and its `<html>` attributes are merged (ours win).
 *  Proven in a real browser: appFrame.browser.test.ts. */
export function framePrefix(hostOrigin: string, channel: string, nonce: string): string {
  return `<!doctype html><html data-app-host-origin="${escapeAttribute(hostOrigin)}" data-app-channel="${channel}"><head>` +
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(frameCsp(nonce))}">`
}

/** The bundle's content types by extension (the host's create_plan_ports.CONTENT_TYPES), media type only. */
const ASSET_TYPES: Record<string, string> = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
  svg: 'image/svg+xml', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', xml: 'application/xml', webmanifest: 'application/manifest+json',
}
function assetType(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return name.includes('.') ? ASSET_TYPES[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ?? 'text/plain' : 'text/plain'
}
/** a bundle file as a data: URI (UTF-8 text, base64) */
function assetUri(text: string, path: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:${assetType(path)};base64,${btoa(bin)}`
}
/**
 * The same rule as the host's frame_document (create_plan_ports._inline_assets): `./<path>` references to the bundle's
 * other files become data: URIs, the only way the frame's CSP (img-src data:, font-src data:) lets an icon or a font
 * load; it loads nothing by URL. In HTML: src="./x" and href="./x"; in CSS: url(./x), url("./x"), url('./x'). The frame's
 * own files (index.html, style.css and the scripts it inlines) and checks/ are never inlined this way, and a reference
 * to a file the bundle does not have is left as it is.
 */
export function inlineAssets(text: string, files: Readonly<Record<string, string>>, inCss: boolean, own: ReadonlySet<string>): string {
  const known = (path: string) => typeof files[path] === 'string' && !own.has(path) && !path.startsWith('checks/')
  if (inCss) return text.replace(/url\(\s*(["']?)\.\/([A-Za-z0-9._/-]+)\1\s*\)/g, (m, _q, path: string) => known(path) ? `url("${assetUri(files[path], path)}")` : m)
  return text.replace(/\b(src|href)=(["'])\.\/([A-Za-z0-9._/-]+)\2/g, (m, attr: string, _q, path: string) => known(path) ? `${attr}="${assetUri(files[path], path)}"` : m)
}

/** An app's own reviewed interface as one opaque-origin document: no network, no forms, no storage of the hive's
 *  origin. It reaches the hive only through the parent's bridge (see AppFrame). Same isolation as Flow's studio.
 *  r17: the CSP comes first (framePrefix), in both modes. With `scripts`, each declared part replaces its own module
 *  tag, inlined with the same nonce, in the listed order (a real-browser test shows they run in that order). Inline
 *  modules cannot import each other, so parts share through globals. The bundle's other files referenced as ./<path>
 *  (an icon, a font) are inlined as data: URIs (inlineAssets), within the same CSP. */
export function appDocument(files: FrameFiles, hostOrigin: string, channel: string, nonce: string, scripts?: readonly string[]): FrameDocument {
  if (new URL(hostOrigin).origin !== hostOrigin || !/^https?:/.test(hostOrigin) ||
      !/^[a-f0-9-]{36}$/.test(channel) || !/^[a-f0-9-]{36}$/.test(nonce)) throw new Error('Invalid app document binding')
  const html0 = files['index.html']
  if (scripts !== undefined) {   // the host's rules again (appFrameParts.ts), checked before anything is inlined
    const reason = partsReason(files, scripts)
    if (reason) throw new Error(`Unexpected app interface: ${reason}`)
  }
  if (typeof html0 !== 'string' || !html0.includes('src="./app.js"') || !html0.includes('href="./style.css"')) throw new Error('Unexpected app interface format')
  const own = new Set(['index.html', 'style.css', ...(scripts ?? ['app.js'])])
  const css = inlineAssets(files['style.css'], files, true, own)
  let html = inlineAssets(html0, files, false, own)
    .replace('<link rel="stylesheet" href="./style.css">', () => `<style nonce="${nonce}">${css.replace(/<\/style/gi, '<\\/style')}</style>`)
  for (const name of scripts ?? ['app.js']) {
    html = html.replace(partTag(name), () => `<script type="module" nonce="${nonce}">${files[name].replace(/<\/script/gi, '<\\/script')}</script>`)
  }
  return { html: framePrefix(hostOrigin, channel, nonce) + html, channel }
}

/** Only the exact frame window, from an opaque origin, on this document's channel. */
export function isFrameSender(event: Pick<MessageEvent, 'origin' | 'source' | 'data'>, source: Window | null, channel: string): boolean {
  return !!source && event.origin === 'null' && event.source === source && event.data?.channel === channel
}

/** r2.8: the bridge's `subscribe` / `unsubscribe` operations name exactly one artifact, nothing else. */
export function subscriptionTarget(op: string | undefined, body: Record<string, unknown> | undefined): string | null {
  if ((op !== 'subscribe' && op !== 'unsubscribe') || !body) return null
  const keys = Object.keys(body).filter((k) => k !== 'swarm_id')
  const id = body.artifact_id
  return keys.length === 1 && typeof id === 'string' && /^[\w.:-]{1,80}$/.test(id) ? id : null
}

/** The `artifact.revision` frame for a subscribed artifact in this swarm, or null. No body ever travels in it. */
export function revisionFrame(event: { type: string } & Record<string, unknown>, swarmId: string, artifactId: string) {
  if (event.type !== 'artifact.revision' || event.swarm_id !== swarmId || event.artifact_id !== artifactId) return null
  if (typeof event.revision !== 'number' || typeof event.digest !== 'string' || typeof event.created_at !== 'string') return null
  return { type: 'artifact.revision', artifact_id: artifactId, revision: event.revision, digest: event.digest, created_at: event.created_at }
}
