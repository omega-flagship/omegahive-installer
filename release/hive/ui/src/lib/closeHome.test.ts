import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Jon 2026-10-08: "when I close an open surface using the X in the top right, it should just go back to the main Home
// Screen, but it seems to randomly open previously opened surfaces instead". A surface's X must land on a clean home:
// the home route (#/), with the experience's own panels closed and its view back at home, whatever was opened before.
// Esc and the browser's Back keep stepping through history.
//
// The X handlers and each experience's home:requested answer are read from the shipped source and executed here, in a
// small browser-history stand-in (entries, index, push, replace, go, hashchange, sessionStorage, reload).

const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: URL, e: 'utf8') => string }
const src = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8')

import { fakeBrowser } from './closeHome.testkit'

type Router = typeof import('./router')

/** Resolve an X's onClick/onClose expression, as written in the source, to the router call it makes. */
function runHandler(r: Router, expr: string, pageSource?: string): void {
  const e = expr.trim()
  const home = () => r.navigate({ name: 'hive' })
  if (e === 'closeToHome' || e === '() => closeToHome()') return r.closeToHome()
  // Embedded Code uses its guarded parent departure; the standalone branch still sends the X Home.
  if (e === 'close' && pageSource?.includes('const close = () => embedded ? leaveEmbedded(embedded.onClose) : closeToHome()')) return r.closeToHome()
  if (e === "() => closePage(() => navigate({ name: 'hive' }))") return r.closePage(home)
  // Page.tsx on 870dea4: the X calls a local that wraps closePage with the page's onClose (most pages pass "navigate home")
  if (pageSource?.match(new RegExp(`const ${e} = \\(\\) => closePage\\(onClose\\)`))) return r.closePage(home)
  throw new Error(`unrecognised X handler: ${e}`)
}

const PAGE = src('../ui/Page.tsx')
const CODE = src('../features/code/CodePage.tsx')
const pageX = PAGE.match(/<IconButton icon="x" label="Close" onClick=\{([^}]+)\} \/>/)?.[1]
// the Code canvas's X (CodeCanvas.tsx cc-close calls p.onClose): the onClose CodePage hands to CodeCanvas
const codeX = CODE.match(/<CodeCanvas[\s\S]*?\n\s+onClose=\{(.+)\}\n/)?.[1]

const SURFACES: [string, string | undefined, string | undefined][] = [
  ['a shared page (every experience opens these: Classic, Still, Cosmos, Construct, Flux, Canvas, OmegaTown, Professional)', pageX, PAGE],
  ['the Code canvas', codeX, CODE],
]

let r: Router
let b: ReturnType<typeof fakeBrowser>
async function boot(first: string) {
  vi.resetModules()
  b = fakeBrowser(first)
  r = await import('./router')
}
async function reload() {
  b.reload()
  vi.resetModules()
  r = await import('./router')
}

beforeEach(() => vi.unstubAllGlobals())
afterEach(() => vi.unstubAllGlobals())

describe('the X of a surface always returns to the home route', () => {
  it('finds the X handlers in the source', () => {
    expect(pageX).toBeTruthy()
    expect(codeX).toBeTruthy()
  })

  for (const [name, x, source] of SURFACES) {
    describe(name, () => {
      const X = () => runHandler(r, x!, source)

      it('open A, open B, X: home, not A', async () => {
        await boot('#/')
        r.navigate({ name: 'tasks' })
        r.navigate({ name: 'settings' })
        X()
        expect(b.location.hash).toBe('#/')
      })

      it('open A, X: home', async () => {
        await boot('#/')
        r.navigate({ name: 'usage' })
        X()
        expect(b.location.hash).toBe('#/')
      })

      it('deep link to A, X: home', async () => {
        await boot('#/lab/run/r1')
        X()
        expect(b.location.hash).toBe('#/')
      })

      it('open A, B, C across families, X from C: home, and again after reopening B: home', async () => {
        await boot('#/')
        r.navigate({ name: 'swarms' })
        r.navigate({ name: 'swarm', id: 's1' })
        r.navigate({ name: 'approvals' })
        X()
        expect(b.location.hash).toBe('#/')
        r.navigate({ name: 'swarm', id: 's1' })
        X()
        expect(b.location.hash).toBe('#/')
      })

      it('X does not leave the closed surface in history, and Back still steps through what came before', async () => {
        await boot('#/')
        r.navigate({ name: 'tasks' })
        r.navigate({ name: 'settings' })
        X()
        expect(b.location.hash).toBe('#/')
        expect(b.hashes()).not.toContain('#/settings')
        b.history.back()
        expect(b.location.hash).toBe('#/tasks')
      })
    })
  }

  it('every experience opens shared surfaces through the one router, and reaches closeToHome through the SDK', () => {
    const sdk = src('../experiences/sdk.ts')
    expect(sdk).toMatch(/export const openClassic = navigate\b/)
    expect(sdk).toMatch(/export \{[^}]*\bcloseToHome\b[^}]*\buseHomeRequested\b[^}]*\} from '\.\.\/lib\/router'/)
  })
})

describe('home:requested', () => {
  it('the X emits it once to every listener; Esc (closePage) does not; an unsubscribed listener hears nothing', async () => {
    await boot('#/')
    const heard: string[] = []
    const offA = r.onHomeRequested(() => heard.push('a'))
    r.onHomeRequested(() => heard.push('b'))
    r.navigate({ name: 'tasks' })
    r.navigate({ name: 'settings' })
    r.closePage(() => r.navigate({ name: 'hive' })) // Esc on the page
    expect(b.location.hash).toBe('#/tasks')
    expect(heard).toEqual([])
    runHandler(r, pageX!, PAGE) // the X
    expect(b.location.hash).toBe('#/')
    expect(heard).toEqual(['a', 'b'])
    offA()
    r.navigate({ name: 'usage' })
    runHandler(r, codeX!, CODE)
    expect(heard).toEqual(['a', 'b', 'b'])
  })

  it('a failing listener does not stop the others or the navigation', async () => {
    await boot('#/')
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const heard: string[] = []
    r.onHomeRequested(() => { throw new Error('boom') })
    r.onHomeRequested(() => heard.push('ok'))
    r.navigate({ name: 'tasks' })
    r.closeToHome()
    expect(b.location.hash).toBe('#/')
    expect(heard).toEqual(['ok'])
    err.mockRestore()
  })
})

describe('the trail in sessionStorage across X, Back, Forward and reload', () => {
  it('holds home where the closed surface was, follows Back and Forward, and survives a reload', async () => {
    await boot('#/')
    r.navigate({ name: 'tasks' })
    r.navigate({ name: 'settings' })
    expect(b.trail()).toEqual(['#/', '#/tasks', '#/settings'])
    r.closeToHome()
    expect(b.trail()).toEqual(['#/', '#/tasks', '#/'])
    b.history.back()
    expect(b.location.hash).toBe('#/tasks')
    expect(b.trail()).toEqual(['#/', '#/tasks'])
    b.history.forward()
    expect(b.location.hash).toBe('#/')
    expect(b.trail()).toEqual(['#/', '#/tasks', '#/'])
    // reload on home: the trail comes back from storage and still drives Esc; the X still goes home
    await reload()
    expect(b.trail()).toEqual(['#/', '#/tasks', '#/'])
    r.navigate({ name: 'usage' })
    expect(b.trail()).toEqual(['#/', '#/tasks', '#/', '#/usage'])
    r.closePage(() => r.navigate({ name: 'hive' })) // Esc steps back to home via the restored trail
    expect(b.location.hash).toBe('#/')
    r.navigate({ name: 'usage' })
    r.closeToHome()
    expect(b.location.hash).toBe('#/')
    expect(b.trail()).toEqual(['#/', '#/tasks', '#/', '#/'])
    expect(b.trail()).not.toContain('#/settings')
    expect(b.trail()).not.toContain('#/usage')
  })

  it('a reload with a surface open, then X: home, and the surface is gone from storage', async () => {
    await boot('#/')
    r.navigate({ name: 'tasks' })
    await reload()
    expect(b.location.hash).toBe('#/tasks')
    r.closeToHome()
    expect(b.location.hash).toBe('#/')
    expect(b.trail()).toEqual(['#/', '#/'])
  })
})

// ---------------------------------------------------------------- each experience's own home

/** The body of an experience's useHomeRequested(() => …) answer, exactly as shipped. */
function homeAnswer(file: string): string {
  const s = src(file)
  const at = s.indexOf('useHomeRequested(() =>')
  if (at < 0) throw new Error(`${file}: no useHomeRequested`)
  if (s.indexOf('useHomeRequested(() =>', at + 1) >= 0) throw new Error(`${file}: more than one useHomeRequested`)
  const start = at + 'useHomeRequested('.length
  let depth = 1
  let i = start
  while (depth > 0) {
    const c = s[i++]
    if (c === '(') depth++
    else if (c === ')') depth--
  }
  const fn = s.slice(start, i - 1).replace(/^\(\) =>\s*/, '').trim()
  return fn.startsWith('{') ? fn.slice(1, -1) : `return (${fn})`
}

/** Run an experience's shipped answer against its local state, given as setters over plain values. */
function runAnswer(file: string, scope: Record<string, unknown>) {
  return new Function(...Object.keys(scope), homeAnswer(file))(...Object.values(scope))
}

/** useState stand-ins: setX(value | updater) writes state[x]. */
function states(initial: Record<string, unknown>) {
  const state = { ...initial }
  const setters: Record<string, (v: unknown) => void> = {}
  for (const k of Object.keys(initial)) {
    const name = `set${k[0].toUpperCase()}${k.slice(1)}`
    setters[name] = (v) => { state[k] = typeof v === 'function' ? (v as (p: unknown) => unknown)(state[k]) : v }
  }
  return { state, setters }
}

type Experience = { id: string; file: string; mount: () => Promise<{ answer: () => void; open: () => void; isHome: () => void }> }

const EXPERIENCES: Experience[] = [
  {
    id: 'flux',
    file: '../experiences/flux/index.tsx',
    mount: async () => {
      const { usePickSwarm } = await import('../experiences/flux/nav')
      const { state, setters } = states({ nav: { view: { kind: 'home' } }, sheet: null, decision: null })
      return {
        open: () => {
          Object.assign(state, { nav: { view: { kind: 'swarm', id: 's1' }, origin: { x: 1, y: 2 } }, sheet: { page: 'index' }, decision: { id: 'ap1' } })
          usePickSwarm.setState({ picking: { id: 'swarms.edit' } as never })
        },
        answer: () => runAnswer('../experiences/flux/index.tsx', { ...setters, usePickSwarm }),
        isHome: () => {
          expect(state.sheet).toBeNull()
          expect(state.decision).toBeNull()
          expect((state.nav as { view: unknown }).view).toEqual({ kind: 'home' })
          expect(usePickSwarm.getState().picking).toBeNull()
        },
      }
    },
  },
  {
    id: 'cosmos',
    file: '../experiences/cosmos/index.tsx',
    mount: async () => {
      const { useCosmos } = await import('../experiences/cosmos/state')
      return {
        open: () => useCosmos.setState({ view: { kind: 'mind', id: 'a1' }, deck: 'goals', deckSwarm: 's1', approvalsOpen: true, pickingSwarm: { id: 'swarms.edit' } as never }),
        answer: () => runAnswer('../experiences/cosmos/index.tsx', { useCosmos }),
        isHome: () => {
          const s = useCosmos.getState()
          expect(s.view).toEqual({ kind: 'galaxy' })
          expect([s.deck, s.deckSwarm, s.pickingSwarm, s.approvalsOpen]).toEqual([null, null, null, false])
        },
      }
    },
  },
  {
    id: 'construct',
    file: '../experiences/construct/index.tsx',
    mount: async () => {
      const { useC } = await import('../experiences/construct/state')
      return {
        open: () => useC.setState({ consoleOpen: true, mind: 'a1', flash: { id: 1, lines: [] } }),
        answer: () => runAnswer('../experiences/construct/index.tsx', { useC }),
        isHome: () => {
          const s = useC.getState()
          expect([s.consoleOpen, s.mind, s.flash]).toEqual([false, null, null])
        },
      }
    },
  },
  {
    id: 'still',
    file: '../experiences/still/index.tsx',
    mount: async () => {
      // the answer also ends a pending focus restore and a leaving transition (both reset on a home request)
      const { state, setters } = states({ focus: null, sheet: null, exiting: false })
      const returnTo = { current: null as unknown }
      const restorePending = { current: false }
      return {
        open: () => { Object.assign(state, { focus: 'a1', sheet: 'all', exiting: true }); returnTo.current = {}; restorePending.current = true },
        answer: () => runAnswer('../experiences/still/index.tsx', { ...setters, returnTo, restorePending }),
        isHome: () => expect([state.focus, state.sheet, returnTo.current, state.exiting, restorePending.current]).toEqual([null, null, null, false, false]),
      }
    },
  },
  {
    id: 'canvas',
    file: '../experiences/canvas/index.tsx',
    mount: async () => {
      const closed = { inspectId: null, searchOpen: false, hiveOpen: false, outlineOpen: false, draft: null, openId: null, goalAsking: null, selected: null }
      const { state, setters } = states(closed)
      return {
        open: () => Object.assign(state, { inspectId: 'g1', searchOpen: true, hiveOpen: true, outlineOpen: true, draft: 'i1', openId: 'a1', goalAsking: { id: 'g1' }, selected: 'a1' }),
        answer: () => runAnswer('../experiences/canvas/index.tsx', setters),
        isHome: () => expect(state).toEqual(closed),
      }
    },
  },
  {
    // the retired town experience's source (out of the registry since Jon's 11-02 ruling; the town lives in Little
    // World): while the file is still in the tree its close contract holds. Not an experience anyone can choose.
    id: 'retired-town-source',
    file: '../experiences/omegatown/index.tsx',
    mount: async () => {
      const home = { view: 'residents', query: '', pick: null, room: null, selected: null }
      const { state, setters } = states(home)
      let renewed = 0
      let stopped = 0
      return {
        open: () => Object.assign(state, { view: 'tools', query: 'x', pick: { id: 'f' }, room: 'code', selected: 'a1' }),
        answer: () => runAnswer('../experiences/omegatown/index.tsx', { ...setters, current: () => true, ctx: {}, renewView: () => renewed++, walking: { stop: () => stopped++ } }),
        isHome: () => {
          expect(state).toEqual(home)
          expect(renewed).toBeGreaterThan(0)
          expect(stopped).toBeGreaterThan(0)
        },
      }
    },
  },
  {
    id: 'professional',
    file: '../experiences/professional/index.tsx',
    mount: async () => {
      const home = { view: 'overview', query: '', selected: null, pick: null }
      const { state, setters } = states(home)
      return {
        open: () => Object.assign(state, { view: 'minds', query: 'x', selected: 'a1', pick: { id: 'f' } }),
        answer: () => runAnswer('../experiences/professional/index.tsx', { ...setters, current: () => true, ctx: {}, renewView: () => undefined }),
        isHome: () => expect(state).toEqual(home),
      }
    },
  },
]

// importing an experience's store pulls in the feature registry: allow for a cold, loaded machine
describe('each experience answers home:requested with its own clean home', { timeout: 30_000 }, () => {
  for (const e of EXPERIENCES) {
    it(`${e.id}: a page opened from an open panel, then X: home route, panels closed, view at home`, async () => {
      await boot('#/')
      const x = await e.mount()
      const off = r.onHomeRequested(x.answer) // the experience is mounted (useHomeRequested subscribes)
      x.open() // the person opens a panel / focuses a mind or system…
      r.navigate({ name: 'tasks' }) // …opens a shared page from it…
      r.navigate({ name: 'settings' }) // …and another
      runHandler(r, pageX!, PAGE) // the page's X
      expect(b.location.hash).toBe('#/')
      x.isHome()
      off()
    })
  }

  it('an actual experience switch: the experience left behind no longer answers, the current one does', async () => {
    for (let i = 0; i < EXPERIENCES.length; i++) {
      const from = EXPERIENCES[i]
      const to = EXPERIENCES[(i + 1) % EXPERIENCES.length]
      await boot('#/')
      const a = await from.mount()
      let heardFrom = 0
      const offA = r.onHomeRequested(() => (heardFrom++, a.answer())) // mounted in `from`
      a.open()
      r.navigate({ name: 'tasks' }) // a shared page opened in `from`
      offA() // switch: ExperienceHost unmounts `from` (its useHomeRequested unsubscribes)…
      const z = await to.mount()
      let heardTo = 0
      const offZ = r.onHomeRequested(() => (heardTo++, z.answer())) // …and mounts `to`
      z.open()
      runHandler(r, pageX!, PAGE) // X on the page, now over `to`
      expect(b.location.hash).toBe('#/')
      expect([heardFrom, heardTo]).toEqual([0, 1])
      z.isHome()
      offZ()
    }
  })

  it('every experience except Classic subscribes exactly once; Classic keeps no panels under a page', () => {
    for (const e of EXPERIENCES) expect(() => homeAnswer(e.file)).not.toThrow()
    expect(EXPERIENCES.map((e) => e.id).sort()).toEqual(['canvas', 'construct', 'cosmos', 'flux', 'professional', 'retired-town-source', 'still'])
  })
})

describe('native top-right X controls join the same close contract', () => {
  const X_CONTROLS: [string, RegExp][] = [
    ['../experiences/flux/sheets.tsx', /<GlassButton label="Close" icon="close" size=\{38\} onClick=\{(\w+)\} autoFocus/],
    ['../experiences/flux/panels.tsx', /<GlassButton label="Close" icon="close" onClick=\{(\w+)\} autoFocus \/>/],
    ['../experiences/flux/panels.tsx', /<GlassButton label="Close" icon="close" size=\{38\} onClick=\{(\w+)\} \/>/],
    ['../experiences/cosmos/Deck.tsx', /aria-label="Close the flight deck" onClick=\{(\w+)\}/],
    ['../experiences/cosmos/Panels.tsx', /aria-label="Close incoming transmissions" onClick=\{(\w+)\}/],
    ['../experiences/cosmos/Panels.tsx', /<MindHeader [^>]*onClose=\{(\w+)\} \/>/],
    ['../experiences/construct/Panes.tsx', /aria-label="Close session" onClick=\{(\w+)\}/],
    ['../experiences/canvas/index.tsx', /onCloseX=\{(\w+)\}\n\s+onDismiss=\{closeChat\}/],
  ]
  it.each(X_CONTROLS)('%s: %s calls closeToHome', (file, re) => {
    expect(src(file).match(re)?.[1]).toBe('closeToHome')
  })
  it('the Canvas conversation: the X is onCloseX, Esc is onDismiss (closes just the conversation)', () => {
    const chat = src('../experiences/canvas/chat.tsx')
    expect(chat).toMatch(/aria-label="Close the conversation" title="Close \(Esc\)" onClick=\{onCloseX\}/)
    expect(chat).toMatch(/if \(e\.key === 'Escape'\) \{[\s\S]{0,80}onDismiss\(\)/)
    expect(src('../experiences/canvas/index.tsx')).toMatch(/const closeChat = useCallback\(\(\) => \{ if \(current\(\)\) setOpenId\(null\) \}, \[current\]\)/)
  })
  it('mind panel and Create a mind: the visible X is closeToHome; the Sheet (Esc, phone drag) gets the plain dismissal', () => {
    const dot = src('../features/dot/DotPanel.tsx')
    expect(dot).toMatch(/const dismiss = \(\) => navigate\(\{ name: 'hive' \}\)/)
    expect(dot.match(/<Sheet [^>]*onClose=\{(\w+)\}/g)?.map((x) => x.match(/onClose=\{(\w+)\}/)![1])).toEqual(['dismiss', 'dismiss', 'onDismiss'])
    expect(dot.match(/<IconButton icon="x" label="Close panel" onClick=\{(\w+)\}/g)).toHaveLength(2)
    expect(dot).not.toMatch(/<IconButton icon="x" label="Close panel" onClick=\{(?!onCloseX\})/)
    expect(dot).toMatch(/onCloseX=\{closeToHome\} onDismiss=\{dismiss\}/)
    expect(dot).toMatch(/<PanelHeader agent=\{agent\} onCloseX=\{closeToHome\}/)
    const create = src('../features/create/CreateFlow.tsx')
    expect(create).toMatch(/const close = \(\) => navigate\(\{ name: 'hive' \}\)/)
    expect(create).toMatch(/<Sheet label="Create a mind" onClose=\{close\}/)
    expect(create).toMatch(/<IconButton icon="x" label="Cancel" onClick=\{closeToHome\}/)
  })
})

describe('Esc (Back semantics) is unchanged', () => {
  it('Esc on a page with no Back or own Esc still steps back through in-app history', async () => {
    expect(PAGE).toMatch(/useEscape\(onEscape \?\? onBack \?\? (\w+)\)/)
    await boot('#/')
    r.navigate({ name: 'tasks' })
    r.navigate({ name: 'settings' })
    r.closePage(() => r.navigate({ name: 'hive' }))
    expect(b.location.hash).toBe('#/tasks')
  })
})

describe('no X close goes through closePage (history-stepping) any more', () => {
  it('Page.tsx and CodePage.tsx X handlers are closeToHome', () => {
    expect(pageX).toBe('closeToHome')
    expect(codeX).toBe('close')
    expect(CODE).toContain('const close = () => embedded ? leaveEmbedded(embedded.onClose) : closeToHome()')
  })
})
