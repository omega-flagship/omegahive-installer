/** Board-scoped styles (every rule hangs off .cv-root). */
export const CSS = `
.cv-root { cursor: default; }
.cv-root.cv-hand, .cv-root.cv-hand * { cursor: grab !important; }
.cv-root.cv-hand[data-panning], .cv-root.cv-hand[data-panning] * { cursor: grabbing !important; }
.cv-root.cv-place .cv-world, .cv-root.cv-place .cv-world * { cursor: copy !important; }
.cv-root[data-panning] .cv-world { pointer-events: none; }
.cv-root ::selection { background: var(--accent-soft); }
.cv-root .cv-world [data-item] { cursor: pointer; }
.cv-root .cv-card { transition: transform .5s cubic-bezier(.2,.8,.2,1), box-shadow .18s ease, border-color .18s ease, opacity .3s; }
.cv-root .cv-card:hover { border-color: var(--line-2) !important; }
.cv-root .cv-sticky { transition: transform .5s cubic-bezier(.2,.8,.2,1), box-shadow .18s ease; transform-origin: 50% 0; }
.cv-root .cv-island { transition: transform .5s cubic-bezier(.2,.8,.2,1), width .5s cubic-bezier(.2,.8,.2,1), height .5s cubic-bezier(.2,.8,.2,1), box-shadow .18s; }
.cv-root .cv-add { transition: background-color .15s, border-color .15s, color .15s; }
.cv-root .cv-add:hover { background: var(--accent-soft) !important; border-color: var(--accent) !important; color: var(--accent-ink) !important; }
.cv-root .cv-world [data-item]:focus-visible { box-shadow: 0 0 0 calc(3px * var(--iz, 1)) var(--accent), var(--shadow) !important; }
.cv-root button:focus-visible, .cv-root [tabindex]:focus-visible, .cv-root a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.cv-root .cv-paper button:focus-visible { outline: 2.5px solid #16161a; outline-offset: 2px; }
.cv-root .cv-bar button:focus-visible { outline: 2px solid var(--paper); outline-offset: -4px; }
.cv-root [role="dialog"] h2:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 4px; }
.cv-root .cv-outline:not([data-open]):not(:focus-within) { position: absolute !important; width: 1px !important; height: 1px !important; padding: 0 !important; margin: -1px; overflow: hidden !important; clip-path: inset(50%); white-space: nowrap; border: 0 !important; }
.cv-ping { animation: cv-ping 1.6s cubic-bezier(0,0,.2,1) infinite; }
@keyframes cv-ping { 70%, 100% { transform: scale(2.6); opacity: 0; } }
.cv-shimmer { animation: cv-breath 2.4s ease-in-out infinite; }
@keyframes cv-breath { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }
.cv-dot { animation: cv-bounce 1.1s ease-in-out infinite; }
@keyframes cv-bounce { 0%, 60%, 100% { transform: translateY(0); opacity: .5; } 30% { transform: translateY(-4px); opacity: 1; } }
.cv-flow { animation: cv-flow 1s linear infinite; }
@keyframes cv-flow { to { stroke-dashoffset: -24; } }
.cv-live { animation: cv-live 2.4s ease-in-out infinite; }
@keyframes cv-live { 0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--good) 45%, transparent); } 50% { box-shadow: 0 0 0 4px transparent; } }
@media (prefers-reduced-motion: reduce) {
  .cv-root *, .cv-root *::before, .cv-root *::after { animation: none !important; transition: none !important; }
}
`
