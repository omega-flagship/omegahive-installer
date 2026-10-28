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

/** An app's own reviewed interface as one opaque-origin document: no network, no forms, no storage of the hive's
 *  origin. It reaches the hive only through the parent's bridge (see AppFrame). Same isolation as Flow's studio.
 *  r17: the CSP comes first (framePrefix), in both modes. With `scripts`, each declared part replaces its own module
 *  tag, inlined with the same nonce, in the listed order (a real-browser test shows they run in that order). Inline
 *  modules cannot import each other, so parts share through globals. */
export function appDocument(files: FrameFiles, hostOrigin: string, channel: string, nonce: string, scripts?: readonly string[]): FrameDocument {
  if (new URL(hostOrigin).origin !== hostOrigin || !/^https?:/.test(hostOrigin) ||
      !/^[a-f0-9-]{36}$/.test(channel) || !/^[a-f0-9-]{36}$/.test(nonce)) throw new Error('Invalid app document binding')
  const html0 = files['index.html']
  if (scripts !== undefined) {   // the host's rules again (appFrameParts.ts), checked before anything is inlined
    const reason = partsReason(files, scripts)
    if (reason) throw new Error(`Unexpected app interface: ${reason}`)
  }
  if (typeof html0 !== 'string' || !html0.includes('src="./app.js"') || !html0.includes('href="./style.css"')) throw new Error('Unexpected app interface format')
  let html = html0.replace('<link rel="stylesheet" href="./style.css">', () => `<style nonce="${nonce}">${files['style.css'].replace(/<\/style/gi, '<\\/style')}</style>`)
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
