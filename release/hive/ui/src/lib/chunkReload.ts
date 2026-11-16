/**
 * A tab left open across a deploy keeps the old index.html, so a later lazy route asks for chunk files that the new
 * release no longer has (404). Recovery, r2 (stand-in r1 FIX-FIRST):
 *  - A chunk failure first asks the server which build it serves now (index.html, no-store) and compares it with the
 *    build this page booted from (the entry script). Only a different build is a deploy. The same build, or no answer,
 *    is a load problem: "Couldn't load this part…" with Retry, which re-runs the failed import. Never a reload.
 *  - A deploy reloads automatically only when nothing is unsaved (the Ask's words, kept drafts, a dirty page); otherwise
 *    it asks the person to save or copy first, then Reload.
 *  - The automatic reload is guarded per target build in sessionStorage: a tab reloads toward a given build at most once.
 *    Time alone never releases the guard; a lazy view revealed by the build the guard named does (proof of health).
 * Errors that are not chunk loads are never handled here: they are left to whatever handled them before (the boot
 * fallback in index.html, React's own reporting).
 */

/**
 * The guard lives in sessionStorage: per tab, surviving that tab's reloads only. It must never move to localStorage
 * (or any store shared between tabs): one tab's reload toward a build would then block or confuse every other tab's.
 */
export const GUARD_KEY = 'omegahive.chunkReload'

const CHUNK_PATTERNS = [
  /failed to fetch dynamically imported module/i, // Chromium
  /importing a module script failed/i, // Safari
  /error loading dynamically imported module/i, // Firefox
  /unable to preload css/i, // Vite's CSS preload
  /loading (css )?chunk [\w-]+ failed/i, // webpack-style ChunkLoadError text
]

/** True only for a failed load of a code chunk (a lazy route, its CSS or a dynamic import), never for other errors. */
export function isChunkLoadError(err: unknown): boolean {
  if (err == null) return false
  if (typeof err === 'string') return CHUNK_PATTERNS.some((re) => re.test(err))
  if (typeof err !== 'object') return false
  const e = err as { name?: unknown; message?: unknown }
  if (e.name === 'ChunkLoadError') return true
  return typeof e.message === 'string' && CHUNK_PATTERNS.some((re) => re.test(e.message as string))
}

/** The build an index.html boots: the file name of its module entry script ("index-AbC123.js"), or null. */
export function entryOf(html: string): string | null {
  for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
    const attrs = m[1]
    if (!/\btype\s*=\s*["']?module\b/i.test(attrs)) continue
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1]
    if (src) return buildName(src)
  }
  return null
}

/** "./assets/index-AbC.js?x" and "https://h/omegahive/assets/index-AbC.js" are the same build: index-AbC.js. */
export function buildName(src: string): string {
  return src.split(/[?#]/)[0].split('/').pop() || src
}

/**
 * updating: a new build, nothing unsaved, reloading now. updated: a new build, reload by hand (already tried once).
 * unsaved: a new build, but something would be lost: save or copy, then Reload. retry: not a deploy; try the load again.
 * reload / reload-unsaved: Retry ran the view's own loader again and the same load failed again (a browser may keep a
 * failed module for the life of the page): only a reload can load it, by hand, after saving if anything is unsaved.
 */
export type UpdateNotice = 'updating' | 'updated' | 'unsaved' | 'retry' | 'reload' | 'reload-unsaved'

export const NOTICE_TEXT: Record<UpdateNotice, string> = {
  updating: 'Updating…',
  updated: 'OmegaHive was updated. Reload to continue.',
  unsaved: 'OmegaHive was updated. Save or copy your work, then Reload.',
  retry: "Couldn't load this part of OmegaHive. Check your connection and try again.",
  reload: "Couldn't load this part of OmegaHive. Reload to continue.",
  'reload-unsaved': "Couldn't load this part of OmegaHive. Save or copy your work, then Reload.",
}

export interface ChunkEnv {
  /** null when storage is unavailable: then no automatic reload is possible, only the notice. */
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
  /** the build this page booted from (entryOf the current document), or null */
  pageBuild: string | null
  /** the build the server serves now (entryOf a no-store index.html), or null when it cannot be read */
  fetchBuild(): Promise<string | null>
  /** true while something on the page would be lost by a reload */
  unsaved(): boolean
  now(): number
  reload(): void
  show(notice: UpdateNotice): void
  /** a decision has started (before any await): the page is spoken for, so index.html's boot fallback stands aside */
  checking?(): void
}

export type ChunkState = 'idle' | 'checking' | UpdateNotice

export interface ChunkRecovery {
  /** Handle an error if it is a chunk load failure (resolves to what was done); null (nothing done) for any other error. */
  handle(err: unknown): Promise<ChunkState> | null
  /** A lazy view was revealed: this build's chunks load. Releases a guard that named this build. */
  healthy(): void
  /** On Retry: back to idle, so a failure of the next attempt is decided afresh. */
  rearm(): void
  readonly state: ChunkState
}

interface Guard {
  target: string
  at: number
}

function readGuard(env: ChunkEnv): Guard | null {
  try {
    const raw = env.storage?.getItem(GUARD_KEY)
    if (!raw) return null
    const g = JSON.parse(raw) as Partial<Guard>
    return typeof g?.target === 'string' && typeof g.at === 'number' ? { target: g.target, at: g.at } : null
  } catch {
    return null
  }
}

function writeGuard(env: ChunkEnv, target: string): boolean {
  if (!env.storage) return false
  try {
    env.storage.setItem(GUARD_KEY, JSON.stringify({ target, at: env.now() }))
    return readGuard(env)?.target === target
  } catch {
    return false
  }
}

/** A probe that throws counts as true: when in doubt, something is unsaved. */
function probe(fn: () => boolean): boolean {
  try {
    return fn()
  } catch {
    return true
  }
}

/** One failure arrives by several routes (a boundary, React's root report): its words identify it. */
function failureKey(err: unknown): string {
  if (typeof err === 'string') return err.replace(/^uncaught\s+\w*error:\s*/i, '')
  const m = (err as { message?: unknown }).message
  return typeof m === 'string' ? m : String(err)
}

export function createChunkRecovery(env: ChunkEnv): ChunkRecovery {
  let state: ChunkState = 'idle'
  let pending: Promise<ChunkState> | null = null
  /** the failure the standing answer was given for */
  let decidedFor: string | null = null
  /** the failure Retry was pressed for: failing the same way again means Retry cannot load it in this page */
  let retriedFor: string | null = null

  async function decide(key: string): Promise<UpdateNotice> {
    const server = await Promise.resolve().then(() => env.fetchBuild()).catch(() => null)
    // no proof of a new build: a load problem, not a deploy. Offer Retry once per failure; after that, Reload by hand.
    if (!server || !env.pageBuild || server === env.pageBuild) {
      if (key !== retriedFor) return 'retry'
      return probe(env.unsaved) ? 'reload-unsaved' : 'reload'
    }
    // this tab already reloaded toward that build and still runs another one: do not try again
    if (readGuard(env)?.target === server) return 'updated'
    if (probe(env.unsaved)) return 'unsaved'
    return writeGuard(env, server) ? 'updating' : 'updated'
  }

  return {
    get state() {
      return state
    },
    handle(err) {
      if (!isChunkLoadError(err)) return null
      // one decision at a time. Reloading, or "reload by hand", stands for this page. "Retry" and "save first" stand
      // for the failure they answered (it arrives by several routes); a different failure later (another route, after
      // the work was saved) is decided afresh, so a later deploy still gets its one reload.
      if (pending) return pending
      const key = failureKey(err)
      if (state === 'updating' || state === 'updated' || state === 'reload' || state === 'reload-unsaved') return Promise.resolve(state)
      if (state !== 'idle' && key === decidedFor) return Promise.resolve(state)
      state = 'checking'
      decidedFor = key
      env.checking?.()
      pending = decide(key).then((notice) => {
        state = notice
        pending = null
        env.show(notice)
        if (notice === 'updating') env.reload()
        return notice
      })
      return pending
    },
    healthy() {
      if (!env.pageBuild) return
      const g = readGuard(env)
      if (g && g.target === env.pageBuild) {
        try {
          env.storage?.removeItem(GUARD_KEY)
        } catch {
          /* storage gone: nothing to release */
        }
      }
    },
    rearm() {
      if (state !== 'retry') return
      state = 'idle'
      retriedFor = decidedFor
      decidedFor = null
    },
  }
}

// ---- retry: re-run failed lazy imports ----

/**
 * The stylesheet Vite could not preload, if that is what failed (its script was then never imported, so the view's own
 * loader can run again once the stylesheet is back). A failed script is never imported by its address: that address may
 * belong to a dependency of the view, not the view itself (lib/lazyRoute.ts runs the view's own loader instead).
 */
export function failedStylesheet(err: unknown): string | null {
  const msg = typeof err === 'string' ? err : typeof (err as { message?: unknown })?.message === 'string' ? (err as { message: string }).message : ''
  return /unable to preload css for\s+(\S+?\.css)/i.exec(msg)?.[1] ?? null
}

/** The same file under a new address, so the browser fetches it again instead of repeating its remembered failure. */
export function bustUrl(url: string, n: number): string {
  return `${url}${url.includes('?') ? '&' : '?'}retry=${n}`
}


const loaders = new Set<() => void>()
const mounted = new Set<() => void>()

/** A retryable loader (lib/lazyRoute.ts): on Retry it starts a fresh import if its last one failed. */
export function onChunkRetry(fn: () => void): () => void {
  loaders.add(fn)
  return () => void loaders.delete(fn)
}

/** A mounted boundary holding a failed view: on Retry it clears its error and renders the view again. */
export function onChunkRetryMounted(fn: () => void): () => void {
  mounted.add(fn)
  return () => void mounted.delete(fn)
}

/**
 * Retry the failed loads in place: failed imports start afresh, failed views render again. Only when the app's tree is
 * gone (an uncaught failure unmounted it; nothing is left to lose) does Retry reload the page.
 */
export function retryChunks(env: { treeGone: () => boolean; reload: () => void } = browserRetryEnv): void {
  active?.rearm()
  for (const fn of [...loaders]) fn()
  for (const fn of [...mounted]) fn()
  if (!mounted.size && env.treeGone()) env.reload()
}

const browserRetryEnv = {
  treeGone: () => !document.getElementById('root')?.childElementCount,
  reload: () => window.location.reload(),
}

// ---- the browser wiring ----

const NOTICE_ID = 'hive-update-notice'

function clearNotice() {
  document.documentElement.removeAttribute('data-hive-update')
  document.getElementById(NOTICE_ID)?.remove()
}

/** Plain DOM, outside React: it must work when the React tree is gone. index.html's boot fallback defers to it. */
function showNotice(notice: UpdateNotice) {
  document.documentElement.setAttribute('data-hive-update', notice)
  document.getElementById(NOTICE_ID)?.remove()
  const d = document.createElement('div')
  d.id = NOTICE_ID
  d.setAttribute('role', notice === 'updating' ? 'status' : 'alert')
  // above every dialog by design: an open modal must not make it inert (ui/useModalContainment.ts KEEP)
  d.setAttribute('data-modal-keep', '')
  const card =
    'max-width:360px;padding:18px 22px;border-radius:16px;background:#0b0820;color:#eceaff;font:15px/1.5 system-ui,sans-serif;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.5)'
  const c = document.createElement('div')
  c.style.cssText = card
  if (notice === 'updating') {
    // the page is about to reload: cover it so nothing half-loaded is clickable
    d.style.cssText =
      'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in oklab, var(--color-void) 88%, transparent);z-index:2147483000'
    c.textContent = NOTICE_TEXT.updating
  } else {
    // not a cover: where the shell is still up, it and the Ask stay usable beneath this card
    d.style.cssText =
      'position:fixed;left:50%;top:max(16px,env(safe-area-inset-top));transform:translateX(-50%);width:calc(100% - 32px);max-width:360px;z-index:2147483000'
    const msg = document.createElement('div')
    msg.style.cssText = 'margin-bottom:12px'
    msg.textContent = NOTICE_TEXT[notice]
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = notice === 'retry' ? 'Retry' : 'Reload'
    btn.style.cssText = 'padding:10px 18px;border-radius:12px;border:0;background:#a493ff;color:#0b0820;font-weight:600;cursor:pointer'
    btn.addEventListener('click', () => {
      if (notice !== 'retry') return window.location.reload()
      clearNotice()
      retryChunks()
    })
    c.append(msg, btn)
  }
  d.appendChild(c)
  document.body.appendChild(d)
}

function browserStorage(): ChunkEnv['storage'] {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function pageBuildNow(): string | null {
  const s = document.querySelector<HTMLScriptElement>('script[type="module"][src]')
  const src = s?.getAttribute('src')
  return src ? buildName(src) : null
}

async function fetchServerBuild(): Promise<string | null> {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = ctl ? window.setTimeout(() => ctl.abort(), 8000) : 0
  try {
    const res = await fetch(window.location.pathname, { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'text/html' }, signal: ctl?.signal })
    if (!res.ok) return null
    return entryOf(await res.text())
  } catch {
    return null
  } finally {
    window.clearTimeout(timer)
  }
}

let active: ChunkRecovery | null = null

/** Report a caught error (e.g. from a lazy view's boundary). Returns true when it was a chunk failure (being handled). */
export function reportChunkError(err: unknown): boolean {
  if (!isChunkLoadError(err)) return false
  void active?.handle(err)
  return true
}

/** A lazy view was revealed (PresenceLazy): proof this build's chunks load. */
export function reportChunkHealthy(): void {
  active?.healthy()
}

/** Install once, at boot: listens for Vite's preload failures and for chunk failures nobody caught. */
export function installChunkRecovery(opts: { unsaved: () => boolean }): ChunkRecovery {
  if (active) return active
  const recovery = createChunkRecovery({
    storage: browserStorage(),
    pageBuild: pageBuildNow(),
    fetchBuild: fetchServerBuild,
    unsaved: opts.unsaved,
    now: () => Date.now(),
    reload: () => window.location.reload(),
    show: showNotice,
    checking: () => document.documentElement.setAttribute('data-hive-update', 'checking'),
  })
  active = recovery
  // Only failures on what the person is opening count: a lazy view's boundary (ui/PresenceLazy.tsx) reports its own,
  // and a failure nobody caught reaches here (React reports a root error as an uncaught error). Not Vite's
  // vite:preloadError and not unhandledrejection: both also fire for background prefetches (App.tsx prefetch), which
  // must never reload or warn anyone; a view's own import still rejects into its boundary after Vite's event.
  window.addEventListener('error', (e) => {
    void recovery.handle(e.error ?? e.message)
  })
  return recovery
}
