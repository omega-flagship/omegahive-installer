import { describe, expect, it } from 'vitest'
import {
  buildName,
  createChunkRecovery,
  entryOf,
  GUARD_KEY,
  isChunkLoadError,
  bustUrl,
  failedStylesheet,
  onChunkRetry,
  onChunkRetryMounted,
  retryChunks,
  type ChunkEnv,
  type UpdateNotice,
} from './chunkReload'

/** One browser tab's session: sessionStorage survives the page's reloads; the server's build can change (a deploy). */
function session(serverBuild: string | null = 'index-A.js') {
  const store = new Map<string, string>()
  let clock = 1_000_000
  const server = { build: serverBuild as string | null, fails: false, fetches: 0 }
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
  /** a page of this tab, booted from `build` */
  function page(build: string | null, opts: { storage?: ChunkEnv['storage']; unsaved?: () => boolean; slowMs?: number } = {}) {
    const notices: UpdateNotice[] = []
    let reloads = 0
    const env: ChunkEnv = {
      storage: opts.storage === undefined ? storage : opts.storage,
      pageBuild: build,
      fetchBuild: async () => {
        server.fetches++
        if (server.fails) throw new TypeError('Failed to fetch')
        return server.build
      },
      unsaved: opts.unsaved ?? (() => false),
      now: () => clock,
      reload: () => void reloads++,
      show: (n) => void notices.push(n),
    }
    return { r: createChunkRecovery(env), notices, reloads: () => reloads }
  }
  return { store, server, page, advance: (ms: number) => void (clock += ms) }
}

const chunkErr = () => new TypeError('Failed to fetch dynamically imported module: https://x/omegahive/assets/ProgramPage-abc123.js')

describe('isChunkLoadError', () => {
  it('knows each engine’s chunk failure and nothing else', () => {
    expect(isChunkLoadError(chunkErr())).toBe(true)
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true)
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module: https://x/a.js'))).toBe(true)
    expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/ProgramHost-1.css'))).toBe(true)
    expect(isChunkLoadError(Object.assign(new Error('Loading chunk 42 failed.'), { name: 'ChunkLoadError' }))).toBe(true)
    expect(isChunkLoadError('Uncaught TypeError: Failed to fetch dynamically imported module: /a.js')).toBe(true)
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'id')"))).toBe(false)
    expect(isChunkLoadError(new Error('Failed to fetch'))).toBe(false) // an API call, not a chunk
    expect(isChunkLoadError(null)).toBe(false)
    expect(isChunkLoadError(42)).toBe(false)
  })
})

describe('the build an index.html boots', () => {
  it('is its module entry script, whatever the attribute order or path', () => {
    expect(entryOf('<script>inline()</script><script type="module" crossorigin src="./assets/index-AbC1.js"></script>')).toBe('index-AbC1.js')
    expect(entryOf("<script src='/omegahive/assets/index-Z9.js?v=1' type='module'></script>")).toBe('index-Z9.js')
    expect(entryOf('<script src="/legacy.js"></script>')).toBe(null)
    expect(entryOf('<html>offline page</html>')).toBe(null)
    expect(buildName('https://h/omegahive/assets/index-AbC1.js#x')).toBe('index-AbC1.js')
  })
})

describe('chunk recovery: is it a deploy?', () => {
  it('changed build, nothing unsaved: shows "Updating…" and reloads once, guarded on the target build', async () => {
    const s = session('index-B.js')
    const p = s.page('index-A.js')
    expect(await p.r.handle(chunkErr())).toBe('updating')
    expect(p.notices).toEqual(['updating'])
    expect(p.reloads()).toBe(1)
    expect(JSON.parse(s.store.get(GUARD_KEY)!).target).toBe('index-B.js')
  })

  it('same build: "Couldn’t load this part…" with Retry, no reload, no guard', async () => {
    const s = session('index-A.js')
    const p = s.page('index-A.js')
    expect(await p.r.handle(chunkErr())).toBe('retry')
    expect(p.notices).toEqual(['retry'])
    expect(p.reloads()).toBe(0)
    expect(s.store.has(GUARD_KEY)).toBe(false)
  })

  it('the index fetch fails, or names no build: Retry, no reload', async () => {
    const s = session('index-B.js')
    s.server.fails = true
    const p = s.page('index-A.js')
    expect(await p.r.handle(chunkErr())).toBe('retry')
    expect(p.reloads()).toBe(0)
    s.server.fails = false
    s.server.build = null // e.g. a captive portal's page
    const q = s.page('index-A.js')
    expect(await q.r.handle(chunkErr())).toBe('retry')
    expect(q.reloads()).toBe(0)
    // and a page that cannot name its own build never claims an update
    const u = session('index-B.js').page(null)
    expect(await u.r.handle(chunkErr())).toBe('retry')
    expect(u.reloads()).toBe(0)
  })

  it('handles one failure once however many routes report it, and only Retry opens a new decision', async () => {
    const s = session('index-A.js')
    const p = s.page('index-A.js')
    const a = p.r.handle(chunkErr())
    const b = p.r.handle(new TypeError('Importing a module script failed.'))
    expect(await a).toBe('retry')
    expect(await b).toBe('retry')
    expect(await p.r.handle(chunkErr())).toBe('retry')
    expect(s.server.fetches).toBe(1)
    expect(p.notices).toEqual(['retry'])
    p.r.rearm()
    // decided afresh (fetched again); the same failure after Retry is now "Reload to continue"
    expect(await p.r.handle(chunkErr())).toBe('reload')
    expect(s.server.fetches).toBe(2)
  })

  it('a non-chunk error is not handled: nothing fetched, shown, reloaded or guarded', () => {
    const s = session('index-B.js')
    const p = s.page('index-A.js')
    expect(p.r.handle(new TypeError("Cannot read properties of undefined (reading 'id')"))).toBe(null)
    expect(p.r.handle(new Error('Failed to fetch'))).toBe(null)
    expect(p.r.handle('Script error.')).toBe(null)
    expect(s.server.fetches).toBe(0)
    expect(p.notices).toEqual([])
    expect(p.reloads()).toBe(0)
    expect(s.store.has(GUARD_KEY)).toBe(false)
    expect(p.r.state).toBe('idle')
  })
})

describe('chunk recovery: unsaved work', () => {
  it('a new build with something unsaved: asks to save or copy, then Reload; never reloads by itself', async () => {
    const s = session('index-B.js')
    const p = s.page('index-A.js', { unsaved: () => true })
    expect(await p.r.handle(chunkErr())).toBe('unsaved')
    expect(p.notices).toEqual(['unsaved'])
    expect(p.reloads()).toBe(0)
    expect(s.store.has(GUARD_KEY)).toBe(false)
    expect(await p.r.handle(chunkErr())).toBe('unsaved')
    expect(p.reloads()).toBe(0)
  })

  it('an unsaved probe that throws counts as unsaved', async () => {
    const p = session('index-B.js').page('index-A.js', {
      unsaved: () => {
        throw new Error('probe')
      },
    })
    expect(await p.r.handle(chunkErr())).toBe('unsaved')
    expect(p.reloads()).toBe(0)
  })
})

describe('chunk recovery: never a loop', () => {
  it('a persistent failure on the new build, however late it rejects, never causes a second reload', async () => {
    const s = session('index-B.js')
    await s.page('index-A.js').r.handle(chunkErr()) // deploy: reload toward B
    const second = s.page('index-B.js') // the reloaded page, a chunk of B still failing
    second.r.healthy() // another lazy view of B did show first: the guard is released (proof of health)
    expect(s.store.has(GUARD_KEY)).toBe(false)
    s.advance(60_000) // the failing import rejects only a minute later
    expect(await second.r.handle(chunkErr())).toBe('retry')
    expect(second.reloads()).toBe(0)
    // again and again, across Retry and across pages of the same build: never a reload
    second.r.rearm() // Retry: the same slow failure again is "Reload to continue", by hand
    s.advance(15_000)
    expect(await second.r.handle(chunkErr())).toBe('reload')
    for (let i = 0; i < 3; i++) {
      const again = s.page('index-B.js')
      s.advance(15_000)
      expect(await again.r.handle(chunkErr())).toBe('retry')
      expect(again.reloads()).toBe(0)
    }
    expect(second.reloads()).toBe(0)
  })

  it('a reload that still runs the old build (a cached index) is not tried again: reload by hand', async () => {
    const s = session('index-B.js')
    expect(await s.page('index-A.js').r.handle(chunkErr())).toBe('updating')
    const stillOld = s.page('index-A.js')
    s.advance(60_000)
    expect(await stillOld.r.handle(chunkErr())).toBe('updated')
    expect(stillOld.notices).toEqual(['updated'])
    expect(stillOld.reloads()).toBe(0)
    // healthy() on the old build does not release a guard that names the new one
    stillOld.r.healthy()
    expect(JSON.parse(s.store.get(GUARD_KEY)!).target).toBe('index-B.js')
  })

  it('time alone never releases the guard; a view shown by the guarded build does', async () => {
    const s = session('index-B.js')
    await s.page('index-A.js').r.handle(chunkErr())
    const b = s.page('index-B.js')
    s.advance(10 * 60_000)
    expect(s.store.has(GUARD_KEY)).toBe(true)
    b.r.healthy()
    expect(s.store.has(GUARD_KEY)).toBe(false)
  })

  it('a later deploy in the same session gets its one reload too', async () => {
    const s = session('index-B.js')
    await s.page('index-A.js').r.handle(chunkErr())
    const b = s.page('index-B.js')
    s.server.build = 'index-C.js' // deploy 2
    expect(await b.r.handle(chunkErr())).toBe('updating')
    expect(b.reloads()).toBe(1)
    expect(JSON.parse(s.store.get(GUARD_KEY)!).target).toBe('index-C.js')
  })

  it('without sessionStorage it cannot guard a reload, so it only says so', async () => {
    const s = session('index-B.js')
    const p = s.page('index-A.js', { storage: null })
    expect(await p.r.handle(chunkErr())).toBe('updated')
    expect(p.reloads()).toBe(0)
    const throwing = s.page('index-A.js', {
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota')
        },
        removeItem: () => {},
      },
    })
    expect(await throwing.r.handle(chunkErr())).toBe('updated')
    expect(throwing.reloads()).toBe(0)
  })
})

describe('chunk recovery: later failures are not stranded (Kimi r1 #3)', () => {
  const otherRoute = () => new TypeError('Failed to fetch dynamically imported module: https://x/omegahive/assets/CodePage-def456.js')

  it('"save first", then the work is saved: the next failure on another route gets its one reload', async () => {
    const s = session('index-B.js')
    let unsaved = true
    const p = s.page('index-A.js', { unsaved: () => unsaved })
    expect(await p.r.handle(chunkErr())).toBe('unsaved')
    // the same failure, reported again by another route (the uncaught report's words): still the same answer
    expect(await p.r.handle('Uncaught TypeError: ' + chunkErr().message)).toBe('unsaved')
    expect(s.server.fetches).toBe(1)
    unsaved = false
    expect(await p.r.handle(otherRoute())).toBe('updating')
    expect(p.reloads()).toBe(1)
  })

  it('"retry" (not a deploy then), and later a deploy: a failure on another route reloads once', async () => {
    const s = session('index-A.js')
    const p = s.page('index-A.js')
    expect(await p.r.handle(chunkErr())).toBe('retry')
    s.server.build = 'index-B.js'
    expect(await p.r.handle(otherRoute())).toBe('updating')
    expect(p.reloads()).toBe(1)
  })

  it('reloaded, healthy, then a later deploy: a failure on another route reloads once more, never twice', async () => {
    const s = session('index-B.js')
    await s.page('index-A.js').r.handle(chunkErr())
    const b = s.page('index-B.js')
    b.r.healthy()
    s.advance(5 * 60_000)
    s.server.build = 'index-C.js'
    expect(await b.r.handle(otherRoute())).toBe('updating')
    const c = s.page('index-C.js')
    expect(await c.r.handle(otherRoute())).toBe('retry') // C's own chunk failing is not a deploy
    expect(c.reloads()).toBe(0)
  })

  it('says it is checking before it waits on the server (index.html’s fallback stands aside at once)', () => {
    const s = session('index-B.js')
    const order: string[] = []
    const env: ChunkEnv = {
      storage: null,
      pageBuild: 'index-A.js',
      fetchBuild: () => {
        order.push('fetch')
        return new Promise(() => {})
      },
      unsaved: () => false,
      now: () => 0,
      reload: () => {},
      show: () => {},
      checking: () => order.push('checking'),
    }
    void createChunkRecovery(env).handle(chunkErr())
    expect(order[0]).toBe('checking')
    expect(s.server.fetches).toBe(0)
  })
})

describe('Retry', () => {
  it('only a failed stylesheet is asked for again by address; a failed script never is (it may be a dependency)', () => {
    expect(failedStylesheet(new Error('Unable to preload CSS for https://x/assets/CodePage-DRugEDNw.css'))).toBe('https://x/assets/CodePage-DRugEDNw.css')
    expect(failedStylesheet(chunkErr())).toBe(null)
    expect(failedStylesheet(new TypeError('Importing a module script failed.'))).toBe(null)
    expect(bustUrl('https://x/a.css', 2)).toBe('https://x/a.css?retry=2')
    expect(bustUrl('https://x/a.css?v=1', 3)).toBe('https://x/a.css?v=1&retry=3')
  })

  it('the same failure again after Retry: Reload by hand (save first if anything is unsaved), never Retry again', async () => {
    const s = session('index-A.js')
    const p = s.page('index-A.js')
    expect(await p.r.handle(chunkErr())).toBe('retry')
    p.r.rearm() // Retry pressed: the view's own loader runs again and fails the same way
    expect(await p.r.handle(chunkErr())).toBe('reload')
    expect(p.notices).toEqual(['retry', 'reload'])
    expect(p.reloads()).toBe(0)
    expect(await p.r.handle(chunkErr())).toBe('reload') // it stands
    p.r.rearm() // not a Retry state: nothing reopens
    expect(await p.r.handle(chunkErr())).toBe('reload')
    const q = s.page('index-A.js', { unsaved: () => true })
    await q.r.handle(chunkErr())
    q.r.rearm()
    expect(await q.r.handle(chunkErr())).toBe('reload-unsaved')
    expect(q.reloads()).toBe(0)
  })

  it('after Retry, a different failure still gets Retry first', async () => {
    const s = session('index-A.js')
    const p = s.page('index-A.js')
    await p.r.handle(chunkErr())
    p.r.rearm()
    expect(await p.r.handle(new TypeError('Failed to fetch dynamically imported module: https://x/omegahive/assets/CodePage-def456.js'))).toBe('retry')
  })

  it('re-runs failed loads and failed views in place; reloads only when the app’s tree is gone', () => {
    const calls: string[] = []
    const offLoader = onChunkRetry(() => calls.push('loader'))
    let reloads = 0
    const env = { treeGone: () => false, reload: () => void reloads++ }
    retryChunks(env)
    expect(calls).toEqual(['loader'])
    expect(reloads).toBe(0) // no failed view, the shell is up: nothing to lose by a reload, but nothing gained either
    const offView = onChunkRetryMounted(() => calls.push('view'))
    retryChunks({ ...env, treeGone: () => true })
    expect(calls).toEqual(['loader', 'loader', 'view'])
    expect(reloads).toBe(0)
    offView()
    retryChunks({ ...env, treeGone: () => true })
    expect(reloads).toBe(1)
    offLoader()
  })
})

describe('boot fallback (index.html) defers to the recovery', () => {
  /** Run index.html's inline boot-fallback script against a tiny stand-in DOM; the React root stays empty. */
  async function bootFallback() {
    const fsName = 'node:fs'
    const { readFileSync } = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string, e: 'utf8') => string }
    const html = readFileSync(new URL('../../index.html', import.meta.url).pathname, 'utf8')
    const code = /<script>([\s\S]*?)<\/script>/.exec(html)![1]
    const attrs = new Map<string, string>()
    const listeners: Record<string, ((e: unknown) => void)[]> = {}
    const timers: (() => void)[] = []
    const shown: string[] = []
    const why = { textContent: '' }
    const document = {
      documentElement: { hasAttribute: (k: string) => attrs.has(k) },
      getElementById: (id: string) => (id === 'root' ? { childElementCount: 0 } : id === 'boot-why' ? why : null),
      createElement: () => ({ style: {}, setAttribute: () => {}, innerHTML: '' }),
      body: { appendChild: () => void shown.push('did not start') },
    }
    const window = { addEventListener: (t: string, fn: (e: unknown) => void) => void (listeners[t] ??= []).push(fn) }
    new Function('window', 'document', 'setTimeout', code)(window, document, (fn: () => void) => void timers.push(fn))
    return {
      attrs,
      shown,
      fire: (t: string, e: unknown = {}) => listeners[t]?.forEach((fn) => fn(e)),
      runTimers: () => timers.splice(0).forEach((fn) => fn()),
    }
  }
  const uncaught = { message: 'Uncaught TypeError: Failed to fetch dynamically imported module: /assets/ProgramPage-x.js' }

  it('control: with no recovery, an uncaught error still shows "did not start"', async () => {
    const b = await bootFallback()
    b.fire('error', { message: 'Uncaught ReferenceError: x is not defined' })
    b.runTimers()
    expect(b.shown).toEqual(['did not start'])
  })

  it('a timer scheduled before the recovery took over stands aside, then and for good', async () => {
    const b = await bootFallback()
    b.fire('error', uncaught) // the fallback's capture listener runs first and schedules show()
    b.attrs.set('data-hive-update', 'checking') // the recovery takes the page in the same dispatch (before any await)
    b.runTimers()
    expect(b.shown).toEqual([])
    b.attrs.delete('data-hive-update') // e.g. Retry cleared the notice
    b.fire('load')
    b.fire('error', uncaught)
    b.runTimers()
    expect(b.shown).toEqual([])
  })
})
