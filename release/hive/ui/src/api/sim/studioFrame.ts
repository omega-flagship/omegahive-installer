/**
 * SIM ONLY, INVENTED (demo D3): a small stand-in for Studio's own interface, served by the simulator as omegadesign's
 * pinned ui files (index.html, style.css, app.js) so demo mode can show the host's real app-frame seams with no hive:
 * opening a deck or a design (Design's view, or the host's picker), editing a deck, Save to Hive (the host's own
 * confirm, then Design's save-source), a held swarm's refusal said plainly (`refusal_code: app_inactive`), deck import
 * from a file, and the private recovery drafts (draft-save, -list, -load, -delete). It is not Design's Studio: no code
 * or wording is copied from it. It runs in the same sandboxed, network-less frame as any app (lib/appFrame.ts).
 */

const INDEX_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Studio (simulated)</title><link rel="stylesheet" href="./style.css"></head><body><div id="app"></div><script type="module" src="./app.js"></script></body></html>'

const STYLE_CSS = String.raw`
:root { color-scheme: dark; --bg: #0e0f1d; --panel: #171a2e; --line: #2a2f4d; --ink: #eef0ff; --ink2: #b8bddb; --ink3: #8a90b4; --accent: #a493ff; --good: #4ade80; --warn: #fbbf24; --bad: #fb7185; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--ink); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
#app { display: flex; flex-direction: column; height: 100%; }
header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
header h1 { margin: 0 8px 0 0; font-size: 16px; }
.chip { font-size: 11px; color: var(--warn); border: 1px solid rgb(251 191 36 / 0.35); background: rgb(251 191 36 / 0.08); border-radius: 6px; padding: 1px 6px; }
button, .filebtn { font: inherit; color: var(--ink); background: #232845; border: 1px solid var(--line); border-radius: 10px; padding: 7px 12px; min-height: 36px; cursor: pointer; }
button:hover, .filebtn:hover { border-color: #444b78; }
button.primary { background: var(--accent); color: #12112a; border-color: transparent; font-weight: 600; }
button.danger { background: rgb(251 113 133 / 0.15); border-color: rgb(251 113 133 / 0.5); color: var(--bad); }
button:disabled { opacity: 0.5; cursor: default; }
.filebtn input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.filebtn { position: relative; display: inline-flex; align-items: center; }
.body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 300px; }
@media (max-width: 760px) { .body { grid-template-columns: 1fr; overflow-y: auto; } main, aside { overflow: visible !important; } }
main { overflow-y: auto; padding: 16px; }
aside { overflow-y: auto; padding: 16px; border-left: 1px solid var(--line); background: var(--panel); }
@media (max-width: 760px) { aside { border-left: 0; border-top: 1px solid var(--line); } }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink3); margin: 0 0 8px; }
.muted { color: var(--ink3); font-size: 12.5px; }
.status { margin: 10px 0; padding: 9px 12px; border-radius: 10px; border: 1px solid var(--line); font-size: 13px; }
.status.ok { border-color: rgb(74 222 128 / 0.4); color: var(--good); }
.status.warn { border-color: rgb(251 191 36 / 0.45); color: var(--warn); background: rgb(251 191 36 / 0.06); }
.status.error { border-color: rgb(251 113 133 / 0.45); color: var(--bad); }
.slide { border: 1px solid var(--line); border-radius: 14px; padding: 10px; margin: 0 0 14px; background: var(--panel); display: grid; grid-template-columns: minmax(0, 420px) minmax(0, 1fr); gap: 4px 14px; align-items: start; }
.slide > [data-stage] { grid-row: span 4; }
@media (max-width: 760px) { .slide { grid-template-columns: 1fr; } .slide > [data-stage] { grid-row: auto; } }
.stage { position: relative; width: 100%; container-type: inline-size; border-radius: 8px; overflow: hidden; }
.stage > span { position: absolute; white-space: pre-wrap; overflow: hidden; line-height: 1.15; }
label.field { display: block; margin-top: 4px; font-size: 12px; color: var(--ink3); }
label.field textarea, label.field input { display: block; width: 100%; margin-top: 3px; font: inherit; font-size: 13.5px; color: var(--ink); background: #0c0e1c; border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; resize: vertical; }
.bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
ul.drafts { list-style: none; margin: 10px 0 0; padding: 0; }
ul.drafts li { border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; margin-bottom: 8px; }
.empty { padding: 32px 8px; text-align: center; color: var(--ink2); }

.live-stage > span.grow { animation: live-grow 0.7s ease-out both; transform-origin: top left; }
.live-stage > span.type { animation: live-type 1.1s steps(24, end) both; }
.live-caption { position: absolute; left: 4%; bottom: 3%; font-size: 12px; color: #12112a; background: #fbbf24; border-radius: 6px; padding: 2px 6px; }
@keyframes live-grow { from { opacity: 0; transform: scale(0.6); } to { opacity: 1; transform: none; } }
@keyframes live-type { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
`

const APP_JS = String.raw`
const root = document.documentElement
const CHANNEL = root.dataset.appChannel
const HOST = root.dataset.appHostOrigin
const DECK = 'omega-scene-deck-1'
const SOURCE = 'omega-studio-source-1'
const app = document.getElementById('app')
const waiting = new Map()
let seq = 0
const state = { swarm: null, person: false, ref: null, source: null, kind: null, dirty: false, status: null, busy: false, drafts: null, draftNote: null, confirmDelete: null, draftRev: {} }

function send(message) { parent.postMessage(Object.assign({}, message, { channel: CHANNEL }), HOST) }
function ask(message) {
  const id = 'q' + (++seq)
  return new Promise((resolve) => { waiting.set(id, resolve); send(Object.assign({}, message, { id: id })) })
}
const request = (op, body) => ask({ type: 'app-request', op: op, body: body })

addEventListener('message', (e) => {
  if (e.source !== parent) return
  const m = e.data
  if (!m || m.channel !== CHANNEL) return
  if (m.type === 'app-context') {
    state.swarm = m.swarm_id
    // r1.13: unsaved local work here is never cleared to open another source (the person keeps or discards it here)
    if (m.source && state.dirty && !(state.ref && state.ref.artifact_id === m.source.artifact_id && state.ref.revision === m.source.revision)) { say('You have unsaved changes here. Keep or discard them first.', 'warn'); return }
    if (m.source) void openRef(m.source); else render(); return
  }
  if (m.type === 'context') { state.person = !!(m.capabilities && m.capabilities.draftSave); render(); if (state.person && state.drafts === null) void listDrafts(); return }
  if (typeof m.id === 'string' && waiting.has(m.id)) { const r = waiting.get(m.id); waiting.delete(m.id); r(m) }
})

function el(tag, attrs, kids) {
  const n = document.createElement(tag)
  for (const k in (attrs || {})) {
    const v = attrs[k]
    if (v === undefined || v === null || v === false) continue
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v)
    else if (k === 'style') n.setAttribute('style', v)
    else if (k === 'text') n.textContent = v
    else n.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of (kids || [])) if (c) n.append(c)
  return n
}
function say(text, tone) { state.status = { text: text, tone: tone || 'ok' }; render() }
function setDirty(d) {
  state.dirty = d
  send({ type: 'app-dirty', dirty: d })
  const where = app.querySelector('[data-studio-where]')
  if (where && d && state.ref) where.textContent = 'Revision ' + state.ref.revision + ' in the hive · changed, not saved yet'
}

async function openRef(ref) {
  state.status = { text: 'Opening…', tone: 'ok' }
  render()
  const focus = 'studio-source:' + JSON.stringify({ artifact_id: ref.artifact_id, revision: ref.revision, digest: ref.digest })
  const r = await request('view', { focus: focus })
  if (!r.ok) return say('That design could not be opened.', 'error')
  const item = (r.result.items || []).find((i) => i.data && i.data.source)
  if (!item) return say('Design did not return a source for this work.', 'error')
  state.source = JSON.parse(JSON.stringify(item.data.source))
  state.kind = state.source.schema === DECK ? 'deck' : state.source.schema === SOURCE ? 'design' : null
  state.ref = item.data.reference || ref
  setDirty(false)
  say('Opened revision ' + state.ref.revision + ' from the hive.', 'ok')
  tryMount()   // r1.13: a session admitted on this canvas mounts once it is the one open here
}

async function pick() {
  const r = await ask({ type: 'pick', accept: ['artifact'], kinds: ['scene-deck', 'studio-source'] })
  if (r.source) await openRef(r.source)
  else if (r.reason) say('The picker is not available here (' + r.reason + ').', 'warn')
}

function newDeck() {
  state.source = { schema: DECK, id: 'deck-new', title: 'Untitled deck', criteria: [], slides: [blankSlide(1)] }
  state.kind = 'deck'
  state.ref = null
  setDirty(true)
  say('A new deck. It is not in the hive until you save it.', 'ok')
}
function blankSlide(n) {
  return { schema: 'omega-scene-1', id: 'slide-' + n, title: 'Slide ' + n, width: 1280, height: 720, background: '#101A3A', criteria: [], elements: [
    { id: 'headline', kind: 'text', x: 96, y: 200, width: 1088, height: 160, text: 'Your headline here', fontSize: 72, color: '#FFFFFF', weight: 'bold' },
  ] }
}

async function importFile(e) {
  const f = e.target.files && e.target.files[0]
  e.target.value = ''
  if (!f) return
  try {
    const parsed = JSON.parse(await f.text())
    if (!parsed || (parsed.schema !== DECK && parsed.schema !== SOURCE)) throw new Error('not a deck')
    state.source = parsed
    state.kind = parsed.schema === DECK ? 'deck' : 'design'
    state.ref = null
    setDirty(true)
    say('Imported ' + f.name + '. It is not in the hive until you save it.', 'ok')
  } catch (err) {
    say('That file is not a deck or a design this Studio can open. Nothing changed.', 'error')
  }
}

const SAVE_WORDS = {
  declined: ['Not saved. You cancelled, and your work is still here.', 'warn'],
  'person-required': ['Saving to the hive needs a signed-in person. Your work is still here.', 'error'],
  busy: ['Another confirmation is already open. Finish it, then save again.', 'warn'],
  'confirm-required': ['The hive asked for a fresh confirmation. Save again to confirm.', 'warn'],
  'too-large': ['This deck is too large to confirm. Remove something, then save again.', 'error'],
}
async function save() {
  if (!state.source || state.busy) return
  state.busy = true
  say('Waiting for your confirmation…', 'ok')
  const params = { editable_source_json: JSON.stringify(state.source) }
  if (state.ref) params.source = { artifact_id: state.ref.artifact_id, revision: state.ref.revision, digest: state.ref.digest }
  const r = await request('act', { action: 'save-source', items: [], params: params })
  state.busy = false
  if (r.ok && r.result && r.result.status === 'done' && r.result.data && r.result.data.output) {
    state.ref = r.result.data.output
    setDirty(false)
    return say('Saved in the hive as revision ' + state.ref.revision + '.', 'ok')
  }
  if (r.ok) return say('Design did not keep it' + (r.result && r.result.message ? ': ' + r.result.message : '') + '. Your work is still here.', 'error')
  if (r.act_not_sent && r.refusal_code === 'app_inactive')
    return say('Studio isn’t switched on in this swarm, so nothing was saved and nothing was sent. Your work is still here: keep it as a private draft, or ask an admin to switch Studio on (Ω → Where it runs…).', 'warn')
  const w = SAVE_WORDS[r.reason]
  if (w) return say(w[0], w[1])
  if (r.act_not_sent) return say('Not saved: the hive could not take it just now, and nothing was sent. Your work is still here.', 'error')
  return say('The hive did not say whether this was saved. Check the versions before saving again.', 'warn')
}

// ---- private recovery drafts (the host's draft routes: this person, this app, this swarm only)
const keyFor = () => ('studio-' + (state.ref ? state.ref.artifact_id : (state.source && state.source.id) || 'new')).toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 80)
const DRAFT_WORDS = { unavailable: 'Private drafts are not available here.', conflict: 'That draft changed in another window. The list is refreshed; try again.', 'not-found': 'That draft is gone.', busy: 'That draft is still being written.', 'too-large': 'This work is too large for a private draft.', 'rate-limited': 'Too many draft actions at once. Wait a moment.' }
async function listDrafts() {
  const r = await ask({ type: 'draft-list' })
  if (r.type === 'drafts') { state.drafts = r.drafts; for (const d of r.drafts) state.draftRev[d.draft_key] = d.revision }
  else state.draftNote = DRAFT_WORDS[r.reason] || 'Private drafts could not be listed.'
  render()
}
async function keepDraft() {
  if (!state.source) return
  const key = keyFor()
  const body = { title: state.source.title || 'Untitled', kind: state.kind, source_json: JSON.stringify(state.source) }
  const msg = { type: 'draft-save', draft_key: key, expected_revision: state.draftRev[key] || null, body: body }
  if (state.ref) msg.source_ref = { artifact_id: state.ref.artifact_id, revision: state.ref.revision, digest: state.ref.digest }
  const r = await ask(msg)
  if (r.type === 'draft-saved') { state.draftNote = 'Private draft kept (revision ' + r.revision + '). Only you can see it.'; await listDrafts(); return }
  state.draftNote = DRAFT_WORDS[r.reason] || 'The draft was not kept.'
  if (r.reason === 'conflict') await listDrafts()
  render()
}
async function openDraft(key) {
  const r = await ask({ type: 'draft-load', draft_key: key })
  if (r.type !== 'draft') { state.draftNote = DRAFT_WORDS[r.reason] || 'That draft could not be opened.'; return render() }
  try {
    state.source = JSON.parse(r.body.source_json)
    state.kind = state.source.schema === DECK ? 'deck' : 'design'
    state.ref = r.source_ref || null
    setDirty(true)
    state.draftNote = 'Opened your private draft (revision ' + r.revision + '). Save it to put it in the hive.'
  } catch (err) { state.draftNote = 'That draft could not be read.' }
  render()
}
async function deleteDraft(key) {
  state.confirmDelete = null
  const r = await ask({ type: 'draft-delete', draft_key: key })
  state.draftNote = r.type === 'draft-deleted' ? 'Private draft deleted.' : (DRAFT_WORDS[r.reason] || 'The draft was not deleted.')
  delete state.draftRev[key]
  await listDrafts()
}

// ---- drawing
function stage(scene) {
  const box = el('div', { class: 'stage', role: 'img', 'aria-label': 'Preview of ' + (scene.title || 'the slide'), style: 'aspect-ratio: ' + scene.width + ' / ' + scene.height + '; background: ' + scene.background })
  for (const e of scene.elements || []) {
    const pos = 'left:' + (e.x / scene.width * 100) + '%;top:' + (e.y / scene.height * 100) + '%;width:' + (e.width / scene.width * 100) + '%;height:' + (e.height / scene.height * 100) + '%;'
    if (e.kind === 'text') box.append(el('span', { style: pos + 'color:' + e.color + ';font-size:' + (e.fontSize / scene.width * 100) + 'cqw;font-weight:' + (e.weight === 'bold' ? 700 : 400), text: e.text }))
    else if (e.kind === 'rect') box.append(el('span', { style: pos + 'background:' + e.fill + ';border-radius:' + (e.radius ? (e.radius / scene.width * 100) + 'cqw' : '0') }))
  }
  return box
}
function deckView(deck) {
  const out = [el('label', { class: 'field' }, ['Deck title', el('input', { value: deck.title, 'aria-label': 'Deck title', oninput: (e) => { deck.title = e.target.value; if (!state.dirty) setDirty(true) } })])]
  deck.slides.forEach((s, i) => {
    const fields = (s.elements || []).filter((x) => x.kind === 'text').map((x) => el('label', { class: 'field' }, ['Slide ' + (i + 1) + ' · ' + x.id, el('textarea', { rows: 2, 'aria-label': 'Slide ' + (i + 1) + ' ' + x.id, oninput: (e) => { x.text = e.target.value; if (!state.dirty) setDirty(true); refreshStage(i) }, text: x.text })]))
    out.push(el('section', { class: 'slide', 'aria-label': 'Slide ' + (i + 1), 'data-slide': i + 1 }, [el('div', { 'data-stage': i }, [stage(s)])].concat(fields)))
  })
  return out
}
function refreshStage(i) {
  const holder = app.querySelector('[data-stage="' + i + '"]')
  if (holder && state.source && state.source.slides) holder.replaceChildren(stage(state.source.slides[i]))
}

function render() {
  const header = el('header', {}, [
    el('h1', { text: 'Studio' }),
    el('span', { class: 'chip', text: 'Simulated for the demo · invented designs' }),
    el('button', { onclick: () => void pick(), text: 'Open…' }),
    el('button', { onclick: newDeck, text: 'New deck' }),
    el('label', { class: 'filebtn' }, ['Import deck file', el('input', { type: 'file', accept: '.json,application/json', 'aria-label': 'Import a deck file', onchange: (e) => void importFile(e) })]),
  ])
  const main = el('main', { 'aria-label': 'Work' })
  if (state.status) main.append(el('p', { class: 'status ' + state.status.tone, role: 'status', 'data-studio-status': '', text: state.status.text }))
  if (live.waiting && !live.scene) main.append(el('p', { class: 'status warn', role: 'status', 'data-live-waiting': '', text: 'Waiting for the admitted canvas. Live edits have not started.' }))
  if (live.scene) for (const n of liveView()) main.append(n)
  if (!state.source && !live.scene) {
    main.append(el('div', { class: 'empty' }, [el('p', { text: 'Open a deck or a design from this swarm, start a new deck, or import a deck file.' })]))
  } else if (state.source) {
    const where = state.ref ? 'Revision ' + state.ref.revision + ' in the hive' + (state.dirty ? ' · changed, not saved yet' : '') : 'Not in the hive yet'
    main.append(el('h2', { text: state.kind === 'deck' ? 'Deck · ' + (state.source.slides || []).length + ' slides' : 'Single design' }))
    main.append(el('p', { class: 'muted', 'data-studio-where': '', text: where }))
    main.append(el('div', { class: 'bar' }, [el('button', { class: 'primary', disabled: state.busy || state.kind !== 'deck', onclick: () => void save(), text: state.busy ? 'Saving…' : 'Save to Hive' })]))
    if (state.kind === 'deck') for (const n of deckView(state.source)) main.append(n)
    else if (state.kind === 'design') {
      main.append(el('p', { class: 'muted', text: 'This is a single design. Edit it on the living canvas: Ω → View → Canvas. You can still keep a private draft of it here.' }))
      main.append(el('div', { class: 'slide' }, [el('div', { 'data-stage': 'design' }, [stage(state.source.current.scene)])]))
    }
  }

  const aside = el('aside', { 'aria-label': 'Private recovery drafts' }, [
    el('h2', { text: 'Private recovery drafts' }),
    el('p', { class: 'muted', text: 'Only you can see these. A draft keeps your work while it is not saved in the hive; it is not a saved design.' }),
  ])
  if (!state.person) aside.append(el('p', { class: 'muted', text: 'Private drafts need a signed-in person.' }))
  else {
    aside.append(el('button', { disabled: !state.source, onclick: () => void keepDraft(), text: 'Keep my work as a private draft' }))
    if (state.draftNote) aside.append(el('p', { class: 'status ok', role: 'status', 'data-draft-note': '', text: state.draftNote }))
    const list = el('ul', { class: 'drafts', 'aria-label': 'Your private drafts' })
    for (const d of state.drafts || []) {
      const asking = state.confirmDelete === d.draft_key
      list.append(el('li', { 'data-draft': d.draft_key }, [
        el('div', { text: d.draft_key }),
        el('div', { class: 'muted', text: 'Revision ' + d.revision + ' · kept ' + new Date(d.saved_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }),
        asking
          ? el('div', { class: 'bar' }, [el('span', { class: 'muted', text: 'Delete this draft?' }), el('button', { class: 'danger', onclick: () => void deleteDraft(d.draft_key), text: 'Delete draft' }), el('button', { onclick: () => { state.confirmDelete = null; render() }, text: 'Keep it' })])
          : el('div', { class: 'bar' }, [el('button', { onclick: () => void openDraft(d.draft_key), text: 'Open' }), el('button', { onclick: () => { state.confirmDelete = d.draft_key; render() }, text: 'Delete' })]),
      ]))
    }
    if (state.drafts && !state.drafts.length) aside.append(el('p', { class: 'muted', text: 'No private drafts in this swarm.' }))
    aside.append(list)
  }
  const focused = document.activeElement && document.activeElement.getAttribute('aria-label')
  app.replaceChildren(header, el('div', { class: 'body' }, [main, aside]))
  if (focused) { const again = app.querySelector('[aria-label="' + focused.replace(/"/g, '') + '"]'); if (again && again.focus) again.focus() }
}

// ---- J3 r4.3 live session. SIM-ONLY SEAM "simReceive": an invented stand-in for Design's createNativeStudioSession(...)
// (which owns the sole artifactLive receiver, live-edits, live-controls and the native snapshot/replace callbacks). Design's
// real factory replaces this whole block, fed the same admitted stream_id/scene_id/receiver_generation; nothing here is Design's code or wording. It exists so the host page's O3 bridge (mount,
// identity, Stop, piece custody, outcomes) can be exercised with ?sim=1.
const live = { session: null, pending: null, waiting: false, receiving: false, closed: null, scene: null, rev: 0, gen: 0, queue: [], busy: false, expect: 1, done: {}, history: [], fresh: {}, caption: null, reduced: false, timer: null }
const LIVE_W = 600, LIVE_H = 800
async function liveHex(text) {
  try {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
  } catch (e) {
    let h = 2166136261; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
    return (h.toString(16).padStart(8, '0')).repeat(8)
  }
}
async function liveRef() { return { scene_id: live.scene.id, revision: live.rev, digest: 'sha256:' + await liveHex(JSON.stringify(live.scene)) } }
async function liveCapture() {
  if (!live.receiving || !live.session) return
  const gen = live.gen
  const scene_ref = await liveRef()
  if (gen !== live.gen || !live.receiving) return liveCapture()   // changed while hashing: capture again
  const owned = {}
  for (const e of live.scene.elements) { const p = 'ask_' + live.session.stream_id + '_'; if (e.id.startsWith(p)) owned[e.id.slice(p.length)] = e.id }
  const body = JSON.stringify({ schema: 'omega-studio-current-piece-1', scene_ref: scene_ref, edit_generation: gen, pending_fields: false, scene: live.scene, owned: owned })
  send({ type: 'studio-live-piece', session_id: live.session.session_id, receiver_generation: live.session.receiver_generation, body: body, scene_ref: scene_ref, edit_generation: gen, pending_fields: false })
}
function liveHandEdit(id, text) {
  const e = live.scene && live.scene.elements.find((x) => x.id === id)
  if (!e) return
  live.history.push(JSON.stringify(live.scene)); e.text = text; live.rev++; live.gen++
  clearTimeout(live.timer); live.timer = setTimeout(() => void liveCapture(), 300)
  const st = app.querySelector('[data-live-stage]'); if (st) st.replaceChildren(liveStage())
}
function liveUndo() {
  if (!live.history.length) return
  live.scene = JSON.parse(live.history.pop()); live.rev++; live.gen++
  void liveCapture(); render()
}
async function simReceive(ref) {
  const sid = live.session.session_id
  const r = await ask({ type: 'read', query: 'studio-proposals', params: { artifact_id: ref.artifact_id, revision: ref.revision, digest: ref.digest } })
  if (r.type !== 'read-result' || !r.result || r.result.digest !== ref.digest) return 'retry'
  if (!live.receiving) return 'closed'   // Stop closed receiving: a late revision is not applied
  const body = JSON.parse(r.result.body)
  const before = await liveRef()
  const draft = JSON.parse(JSON.stringify(live.scene))
  let changed = false, refusal = null, caption = null, invalid = false
  const added = []
  for (const it of body.items) {
    const a = it.args || {}
    const id = 'ask_' + live.session.stream_id + '_' + a.id
    const el = draft.elements.find((x) => x.id === id)
    if (it.op === 'add-shape' || it.op === 'add-text') {
      if (el) { refusal = 'conflict'; break }
      const n = it.op === 'add-shape' ? { id: id, kind: 'rect', x: a.x, y: a.y, width: a.width, height: a.height, fill: a.fill, radius: a.radius || 0 } : { id: id, kind: 'text', x: a.x, y: a.y, width: a.width, height: a.height, text: a.text, fontSize: a.fontSize, color: a.color, weight: a.weight }
      draft.elements.push(n); added.push(id); changed = true
    } else if (it.op === 'set-element') {
      if (!el) { refusal = 'conflict'; break }
      // 0.4.20 p2a projection: prior and value must carry exactly the same keys, else the step is structurally invalid
      const pk = Object.keys(a.prior || {}).sort().join(','), vk = Object.keys(a.value || {}).sort().join(',')
      if (!pk || pk !== vk) { invalid = true; break }
      if (Object.keys(a.prior || {}).some((k) => el[k] !== a.prior[k])) { refusal = 'conflict'; break }
      Object.assign(el, a.value || {}); added.push(id); changed = true
    } else if (it.op === 'cursor') caption = a.caption || null
  }
  if (!live.receiving) return 'closed'
  let outcome
  if (invalid) outcome = 'invalid'
  else if (refusal) outcome = 'refused'
  else if (changed) { live.history.push(JSON.stringify(live.scene)); live.scene = draft; live.rev++; live.gen++; outcome = 'applied'; for (const id of added) live.fresh[id] = true }
  else outcome = 'accepted-no-source-change'
  live.caption = caption
  render()
  await liveCapture()
  const after = await liveRef()
  const receipt = await liveHex(JSON.stringify({ ref: ref, outcome: outcome, before: before, after: after }))
  live.done[ref.revision] = outcome
  // host R4 L6: the stand-in receiver names the op ids it validated in THIS exact proposal body (its own receipt)
  const opIds = body.items.map((it) => String(it.op_id))
  send(Object.assign({ type: 'studio-live-outcome', session_id: sid, receiver_generation: live.session.receiver_generation, proposal: { artifact_id: ref.artifact_id, revision: ref.revision, digest: ref.digest }, outcome: outcome, piece_before: before, piece_after: after, receipt_digest: receipt, observed_generation: live.gen, op_ids: opIds }, refusal ? { reason: refusal } : {}))
  setTimeout(() => { live.fresh = {}; render() }, 1400)
  return outcome
}
async function livePump() {
  if (live.busy || !live.receiving) return
  live.queue.sort((a, b) => a.revision - b.revision)
  const next = live.queue.find((q) => q.revision === live.expect)
  if (!next) return
  live.busy = true
  try {
    const out = await simReceive(next)
    if (out !== 'retry') { live.queue = live.queue.filter((q) => q !== next); if (out !== 'closed') live.expect++ }
  } finally { live.busy = false }
  if (live.receiving) void livePump()
}
addEventListener('message', (e) => {
  if (e.source !== parent) return
  const m = e.data
  if (!m || m.channel !== CHANNEL) return
  if (m.type === 'context') live.reduced = !!m.reducedMotion
  if (m.type === 'studio-live-open' && m.session && m.session.stream_id && m.session.scene_id) {
    // r1.13: the 0.4.20 receiver's rule, played: it mounts ONLY on the canvas actually open here, when that canvas's
    // current scene id equals the admitted scene id; otherwise it waits (it never invents or swaps a canvas)
    live.pending = m.session
    tryMount(); return
  }
  if (m.type === 'studio-live-close' && live.pending && m.session_id === live.pending.session_id) { live.pending = null; live.waiting = false; render(); return }
  if (m.type === 'studio-live-close' && live.session && m.session_id === live.session.session_id) { live.receiving = false; live.closed = m.reason; render(); return }
  if (m.type === 'studio-live-capture' && live.session && m.session_id === live.session.session_id) { void liveCapture(); return }
  // the host's step record (ledger) names each exact proposal ref: a missed or early notice is never a gap
  // r1.14d: Design's 0.4.20/0.4.21 receiver takes an upload tuple only with a BARE 64-hex body hash (native-frame
  // upload()); a step or recover failing it is dropped silently, as there. Played here so the sim catches the wire form.
  const bareUpload = (u) => !!u && typeof u === 'object' && typeof u.body_sha256 === 'string' && /^[a-f0-9]{64}$/.test(u.body_sha256)
  if (m.type === 'studio-live-step' && !bareUpload(m.piece_read)) return
  if (m.type === 'studio.recover' && !bareUpload(m.upload)) return
  if (m.type === 'studio-live-step' && live.session && m.session_id === live.session.session_id && live.receiving && m.proposal) {
    const p = m.proposal
    if (!live.queue.some((q) => q.revision === p.revision) && !live.done[p.revision]) live.queue.push({ artifact_id: p.artifact_id, revision: p.revision, digest: p.digest })
    void livePump(); return
  }
  // a fresh receiver on a reopened view starts after the host's last admitted revision k (nothing earlier is replayed)
  if (m.type === 'studio.recover' && live.session && m.session_id === live.session.session_id && typeof m.startRevision === 'number') {
    live.expect = m.startRevision + 1; live.queue = live.queue.filter((q) => q.revision > m.startRevision); void livePump(); return
  }
  if (m.type === 'artifact.revision' && live.session && m.artifact_id === live.session.proposal_artifact_id && live.receiving) {
    if (!live.queue.some((q) => q.revision === m.revision) && !live.done[m.revision]) live.queue.push({ artifact_id: m.artifact_id, revision: m.revision, digest: m.digest })
    void livePump()
  }
})
function tryMount() {
  const sess = live.pending
  if (!sess) return
  const cur = state.kind === 'design' && state.source && state.source.current ? state.source.current.scene : null
  if (!cur || cur.id !== sess.scene_id) { live.waiting = true; render(); return }
  live.pending = null; live.waiting = false
  live.session = sess; live.receiving = true; live.closed = null
  if (!live.scene || live.scene.id !== cur.id) { live.scene = JSON.parse(JSON.stringify(cur)); live.rev = 1; live.gen = 1 }
  void request('subscribe', { artifact_id: sess.proposal_artifact_id })
  void liveCapture(); render()
}
function liveStage() {
  const sc = live.scene
  const box = el('div', { class: 'stage live-stage', role: 'img', 'aria-label': 'The live piece', style: 'aspect-ratio: ' + sc.width + ' / ' + sc.height + '; background: ' + sc.background })
  for (const e of sc.elements) {
    const pos = 'left:' + (e.x / sc.width * 100) + '%;top:' + (e.y / sc.height * 100) + '%;width:' + (e.width / sc.width * 100) + '%;height:' + (e.height / sc.height * 100) + '%;'
    const cls = live.fresh[e.id] && !live.reduced ? (e.kind === 'text' ? 'grow type' : 'grow') : null
    if (e.kind === 'text') box.append(el('span', { class: cls, style: pos + 'color:' + e.color + ';font-size:' + (e.fontSize / sc.width * 100) + 'cqw;font-weight:' + (e.weight === 'bold' ? 700 : 400), text: e.text }))
    else box.append(el('span', { class: cls, style: pos + 'background:' + e.fill + ';border-radius:' + (e.radius ? (e.radius / sc.width * 100) + 'cqw' : '0') }))
  }
  if (live.caption) box.append(el('span', { class: 'live-caption', text: live.caption }))
  return box
}
function liveView() {
  if (!live.scene) return []
  const words = live.receiving ? 'Drawing live · simulated maker (invented)' : live.closed === 'stop' ? 'Stopped here. The piece, history and Undo stay.' : 'Not receiving (' + (live.closed || 'closed') + '). The piece stays.'
  const head = live.scene.elements.find((x) => x.id.endsWith('_headline'))
  return [el('section', { class: 'slide live', 'aria-label': 'Live piece', 'data-live-receiving': live.receiving ? 'yes' : 'no' }, [
    el('div', { 'data-live-stage': '' }, [liveStage()]),
    el('div', {}, [
      el('p', { class: 'status ' + (live.receiving ? 'ok' : 'warn'), role: 'status', 'data-live-status': '', text: words }),
      el('p', { class: 'muted', text: 'Revision ' + live.rev + ' · edit ' + live.gen + ' · not saved to the hive' }),
      head ? el('label', { class: 'field' }, ['Headline (your hand edit)', el('textarea', { rows: 2, 'aria-label': 'Live headline', 'data-live-headline': '', oninput: (e) => liveHandEdit(head.id, e.target.value), text: head.text })]) : null,
      el('div', { class: 'bar' }, [el('button', { disabled: !live.history.length, onclick: liveUndo, text: 'Undo' })]),
    ]),
  ])]
}

render()
send({ type: 'app-ready' })
`

/** The stand-in's pinned files, as `GET /api/programs/omegadesign/ui` returns them. */
export const SIM_STUDIO_FILES: { 'index.html': string; 'app.js': string; 'style.css': string } = { 'index.html': INDEX_HTML, 'app.js': APP_JS, 'style.css': STYLE_CSS }
