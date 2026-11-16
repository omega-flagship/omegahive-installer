// @vitest-environment node
// Purpose: the stage as a person sees it over any look (screens/arrange/StageView.tsx): each item drawn at the rectangle
// MeTTa gave it, in the window the Ask's open thread leaves, a picture in its own shape once loaded, a recalled item
// beside the shown one, what was put away in the tray and back with a press, a dragged divider learned for the same
// kinds, Escape putting the stage away, a view still waiting for its person's Run it, and the stage's one mount beside
// the Ask in App.tsx, so every look draws it. INVENTED ids, titles and texts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { useHive } from '../../store/store'
import { useScene } from '../../scene/sceneStore'
import { mountPage, settle, type MountedPage } from '../../features/views/mountedView.testkit'
import { press, reactProps, type MiniNode } from '../../ui/miniDom.testkit'
import { bindPerson, credit, say } from './arrange'
import { ArrangeSpace, type ArrangeItem, type Statement } from './arrangeSpace'
import StageView from './StageView'

const photo = 'ar_photo01'
const text = 'ar_text01'
const sketch = 'ar_sketch01'
const notes = 'ar_notes01'
const tipView = 'ar_tipview01'
const art = (key: string, stored: string): ArrangeItem => ({ key, source: 'artifact', stored })
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><rect width="4" height="3" fill="teal"/></svg>'
const rows: Record<string, { kind: string; title: string; body: string }> = {
  [photo]: { kind: 'image', title: 'Harbour at dusk', body: svg },
  [text]: { kind: 'note', title: 'What I wrote about it', body: 'Low sun, two boats, the light on the water.' },
  [sketch]: { kind: 'image', title: 'Second sketch', body: svg },
  [notes]: { kind: 'note', title: 'Second notes', body: 'More words.' },
  [tipView]: { kind: 'view', title: 'Tip calculator', body: '' },
}
const client = {
  artifact: (id: string) => Promise.resolve({ artifact_id: id, kind: rows[id].kind, title: rows[id].title, swarm_id: 's1', mind_id: 'a_vega01', revision: 1, digest: `sha256:${'d'.repeat(64)}`, created_at: '2026-11-15T00:00:00Z', revised_at: null }),
  creationText: (id: string) => Promise.resolve({ artifact_id: id, kind: rows[id].kind, title: rows[id].title, swarm_id: 's1', revision: 1, digest: `sha256:${'d'.repeat(64)}`, body: rows[id].body, created_at: '2026-11-15T00:00:00Z' }),
  artifactView: (id: string) => Promise.resolve({ artifact_id: id, kind: 'view', title: rows[id].title, swarm_id: 's1', mind_id: 'a_vega01', revision: 1, digest: `sha256:${'d'.repeat(64)}`,
    created_at: '2026-11-15T00:00:00Z', grant: { ran: false, reach: false }, carrier: 'metta', source: null }),
}

let page: MountedPage
let person = 0
let keydown: ((e: { key: string; target: unknown; defaultPrevented: boolean }) => void) | null = null
const g = globalThis as unknown as Record<string, unknown>
beforeEach(async () => {
  page = await mountPage()
  const win = g.window as Record<string, unknown>
  Object.assign(win, { innerWidth: 1440, innerHeight: 900 })
  win.addEventListener = (type: string, f: never) => { if (type === 'keydown') keydown = f }
  win.removeEventListener = () => undefined
  g.requestAnimationFrame = (f: (t: number) => void) => { f(0); return 1 }
  g.cancelAnimationFrame = () => undefined
  useHive.setState({ client: client as never })
  // a fresh stage for a new person each time, nothing taught yet
  bindPerson(null)
  bindPerson(`p_test${++person}`)
})
afterEach(async () => {
  await page.restore()
  useHive.setState({ client: null as never })
  bindPerson(null)
})

const mount = async () => {
  await act(async () => page.root.render(<StageView />))
  await settle()
}
const drawn = (key: string) => page.container.findAll((n) => n.getAttribute('data-stage-item') === key)[0]
const rect = (n: MiniNode) => ['left', 'top', 'width', 'height'].map((k) => parseFloat(String((n.style as Record<string, unknown>)[k])))
const buttons = (name: string) => page.container.findAll((n) => n.tagName === 'BUTTON' && (n.getAttribute('aria-label') === name || n.textContent === name))
const separators = () => page.container.findAll((n) => n.getAttribute('role') === 'separator')
const expected = (log: Statement[], items: ArrangeItem[]) =>
  ArrangeSpace.open().compose({ stage: { w: 1440, h: 900 }, items, relates: [], interest: {}, shares: [], log, episode: log.length })

describe('the stage', () => {
  it('redraws a picture in its own shape once it has loaded, at the rectangle MeTTa gives that shape', async () => {
    const shown: Statement = { say: 'show', key: photo, task: null }
    say(shown, [art(photo, 'image')])
    await mount()
    const img = drawn(photo).findAll((n) => n.tagName === 'IMG')[0]
    // a tall picture: its natural pixels, as the browser reports them when it has loaded
    await act(async () => (reactProps(img).onLoad as (e: unknown) => void)({ currentTarget: { naturalWidth: 300, naturalHeight: 600 } }))
    await settle()
    const want = ArrangeSpace.open().compose({ stage: { w: 1440, h: 900 }, items: [{ ...art(photo, 'image'), shape: [300, 600] }], relates: [], interest: {}, shares: [], log: [shown], episode: 1 }).placed[0]
    expect(want.h / want.w).toBeCloseTo(2, 6)
    expect(rect(drawn(photo))).toEqual([want.x, want.y, want.w, want.h])
  })

  it('arranges what is shown above the Ask’s open thread, and over the whole screen again once it closes', async () => {
    // the thread rising over the dock on a classic desktop, as the Ask reports it (features/ask/askRoom)
    const thread = { left: 558, top: 563, right: 1117, bottom: 805 }
    useScene.getState().setAskThread(thread)
    try {
      const shown: Statement = { say: 'show', key: photo, task: null }
      say(shown, [art(photo, 'image')])
      await mount()
      const win = page.container.findAll((n) => n.getAttribute('data-stage-window') !== null)[0]
      expect(rect(win)).toEqual([0, 0, 1440, 563])
      const want = ArrangeSpace.open().compose({ stage: { w: 1440, h: 563 }, items: [art(photo, 'image')], relates: [], interest: {}, shares: [], log: [shown], episode: 1 }).placed[0]
      const [x, y, w, h] = rect(drawn(photo))
      expect([x, y, w, h]).toEqual([want.x, want.y, want.w, want.h])
      // on screen (the window starts at the viewport's top left here), the picture ends above the thread
      expect(y + h).toBeLessThanOrEqual(thread.top)
      await act(async () => useScene.getState().setAskThread(null))
      await settle()
      expect(rect(page.container.findAll((n) => n.getAttribute('data-stage-window') !== null)[0])).toEqual([0, 0, 1440, 900])
      const whole = expected([shown], [art(photo, 'image')]).placed[0]
      expect(rect(drawn(photo))).toEqual([whole.x, whole.y, whole.w, whole.h])
    } finally {
      useScene.getState().setAskThread(null)
    }
  })

  it('with the Ask at half size, what is shown fills the right half the Ask leaves (Haley, Lisbon 16 Nov)', async () => {
    // the half size's column as the Ask reports it: placeHalf's left half, from 12 px below the top to just above the
    // field (features/ask/ClassicAsk, ask.css .ask-half)
    const { placeHalf } = await import('../../features/ask/placement')
    const place = placeHalf({ width: 1440, height: 900, layout: 'rail', page: false, tabBar: false, omegaRight: null, clockLeft: null, railX: null }, [])
    const thread = { left: place.left, top: 12, right: place.left + place.width, bottom: 900 - (place.bottom + 64) }
    useScene.getState().setAskThread(thread)
    try {
      const shown: Statement = { say: 'show', key: photo, task: null }
      say(shown, [art(photo, 'image')])
      await mount()
      const win = page.container.findAll((n) => n.getAttribute('data-stage-window') !== null)[0]
      expect(rect(win)).toEqual([thread.right, 0, 1440 - thread.right, 900])
      const want = ArrangeSpace.open().compose({ stage: { w: 1440 - thread.right, h: 900 }, items: [art(photo, 'image')], relates: [], interest: {}, shares: [], log: [shown], episode: 1 }).placed[0]
      expect(rect(drawn(photo))).toEqual([want.x, want.y, want.w, want.h])
      // the window's right half is the stage's: the picture sits in it, centred across it, clear of the Ask's column
      expect(want.x).toBeGreaterThanOrEqual(0)
      expect(want.x + want.w).toBeLessThanOrEqual(1440 - thread.right)
      expect(want.x + want.w / 2).toBeCloseTo((1440 - thread.right) / 2, 0)
      // the stage's own bar keeps to that half too, so the Ask's column never covers its Put away
      const putAway = buttons('Put away')[0]
      const bar = putAway.parentNode as MiniNode
      expect([(bar.style as Record<string, unknown>).marginLeft, (bar.style as Record<string, unknown>).width]).toEqual([`${thread.right}px`, `${1440 - thread.right}px`])
    } finally {
      useScene.getState().setAskThread(null)
    }
  })

  it('draws a shown item at the rectangle MeTTa gave it, in the hive’s own words for it', async () => {
    say({ say: 'show', key: photo, task: null }, [art(photo, 'image')])
    await mount()
    const want = expected([{ say: 'show', key: photo, task: null }], [art(photo, 'image')]).placed[0]
    expect(rect(drawn(photo))).toEqual([want.x, want.y, want.w, want.h])
    expect(page.container.textContent).toContain('Harbour at dusk')
    // an image saved as an SVG is drawn as one, never run as markup
    const img = page.container.findAll((n) => n.tagName === 'IMG')[0]
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml;charset=utf-8,/)
  })

  it('brings a recalled item beside the shown one, puts one away into the tray, and back with a press', async () => {
    say({ say: 'show', key: photo, task: null }, [art(photo, 'image')])
    say({ say: 'recall', key: text }, [art(text, 'note')])
    await mount()
    const [a, b] = [rect(drawn(photo)), rect(drawn(text))]
    expect(a[1]).toBe(b[1])
    expect(a[0] + a[2]).toBeLessThan(b[0])
    await act(async () => press(buttons('Put What I wrote about it away')[0]))
    await settle()
    expect(drawn(text)).toBeUndefined()
    const chip = page.container.findAll((n) => n.getAttribute('data-stage-tray') === text)[0]
    expect(chip.textContent).toBe('What I wrote about it')
    await act(async () => press(chip))
    await settle()
    expect(drawn(text)).toBeDefined()
  })

  it('learns a dragged divider for the same kinds, by pointer and by keyboard', async () => {
    say({ say: 'show', key: photo, task: null }, [art(photo, 'image')])
    say({ say: 'recall', key: text }, [art(text, 'note')])
    await mount()
    const sep = separators()[0]
    expect(sep.getAttribute('aria-valuenow')).toBe('50')
    const props = reactProps(sep) as Record<string, (e: unknown) => void>
    // the pointer drags the divider to a third of the way along
    const divider = expected([{ say: 'show', key: photo, task: null }, { say: 'recall', key: text }], [art(photo, 'image'), art(text, 'note')]).dividers[0]
    const x = divider.offset + divider.room / 3
    await act(async () => {
      props.onPointerDown({ pointerId: 1, clientX: x, clientY: 0, currentTarget: { setPointerCapture: () => undefined } })
      props.onPointerMove({ pointerId: 1, clientX: x, clientY: 0 })
      props.onPointerUp({ pointerId: 1, clientX: x, clientY: 0 })
    })
    await settle()
    expect(separators()[0].getAttribute('aria-valuenow')).toBe('33')
    // a new image and text side by side open where this split was left
    say({ say: 'clear' })
    say({ say: 'show', key: sketch, task: null }, [art(sketch, 'image')])
    say({ say: 'recall', key: notes }, [art(notes, 'note')])
    await settle()
    expect(separators()[0].getAttribute('aria-valuenow')).toBe('33')
    const [s, n] = [rect(drawn(sketch)), rect(drawn(notes))]
    expect(s[2] / (s[2] + n[2])).toBeCloseTo(1 / 3, 6)
    // the keyboard moves it by five hundredths and keeps that too
    await act(async () => (reactProps(separators()[0]) as Record<string, (e: unknown) => void>).onKeyDown({ key: 'ArrowRight', preventDefault: () => undefined }))
    await settle()
    expect(separators()[0].getAttribute('aria-valuenow')).toBe('38')
  })

  it('is put away by Escape when the person is on it, and draws nothing then', async () => {
    say({ say: 'show', key: photo, task: null }, [art(photo, 'image')])
    await mount()
    expect(drawn(photo)).toBeDefined()
    await act(async () => keydown?.({ key: 'Escape', target: (g.document as { body: unknown }).body, defaultPrevented: false }))
    await settle()
    expect(page.container.findAll((n) => n.getAttribute('data-stage') !== null)).toHaveLength(0)
  })

  it('draws a view a mind shows waiting for its person’s Run it, running nothing', async () => {
    say({ say: 'show', key: tipView, task: null }, [art(tipView, 'view')])
    await mount()
    expect(drawn(tipView)).toBeDefined()
    expect(buttons('Run it').length).toBe(1)
  })

  it('brings back beside the shown item what was once in view with its task, and leaves out what never was', async () => {
    useHive.setState({ agents: { a_orion01: { id: 'a_orion01', name: 'Orion', hue: 40, status: 'awake' }, a_lyra01: { id: 'a_lyra01', name: 'Lyra', hue: 90, status: 'awake' } } as never })
    // an earlier statement in the task had Orion in view; Lyra never was
    say({ say: 'show', key: photo, task: 'g_tip01' }, [art(photo, 'image')])
    credit(1, 'g_tip01', ['a_orion01'])
    say({ say: 'show', key: sketch, task: 'g_tip01' }, [art(sketch, 'image')])
    await mount()
    expect(drawn(sketch)?.getAttribute('data-stage-role')).toBe('shown')
    expect(drawn('a_orion01')?.getAttribute('data-stage-role')).toBe('beside')
    expect(drawn('a_lyra01')).toBeUndefined()
    useHive.setState({ agents: {} })
  })

  it('says so when a statement names something it has nothing for', async () => {
    say({ say: 'recall', key: 'ar_gone01' })
    await mount()
    expect(page.container.textContent).toContain('Something asked to be shown is not here, or is not shown to you.')
  })
})

describe('every look draws the stage', () => {
  it('StageHost is mounted ONCE in App.tsx, outside the route switch and beside the Ask, so every look and page has it', async () => {
    const fsName = 'node:fs'
    const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: URL, e: 'utf8') => string }
    const app = fs.readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8')
    expect(app.match(/<StageHost\b/g)).toHaveLength(1)
    const at = app.indexOf('<StageHost')
    const before = app.slice(0, at)
    // not inside any route-conditional block, nor inside the branch that mounts one experience
    expect((before.match(/<AnimatePresence/g) ?? []).length).toBe((before.match(/<\/AnimatePresence>/g) ?? []).length)
    expect(app.slice(Math.max(0, at - 200), at)).not.toMatch(/route\.name ===|experience !==/)
    expect(app.indexOf('<AskHost')).toBeGreaterThan(at)
  })
})
