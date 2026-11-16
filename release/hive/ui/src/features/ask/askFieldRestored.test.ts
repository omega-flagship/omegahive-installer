import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { MiniDocument } from '../../ui/miniDom.testkit'

const fs = (await import(/* @vite-ignore */ 'node:' + 'fs')) as { readFileSync: (p: URL, e: 'utf8') => string }

/**
 * useAskField MOUNTED (real React): restored words (a known-unsent request put back) show no suggestion rows until the
 * person types; typed words do. The field used to decide that by reading a ref while rendering; it now draws from state
 * kept with the ref.
 */

const g = globalThis as Record<string, unknown>
const saved: Record<string, unknown> = {}
let doc: MiniDocument
beforeAll(() => {
  for (const k of ['window', 'document', 'HTMLIFrameElement', 'IS_REACT_ACT_ENVIRONMENT']) saved[k] = g[k]
  doc = new MiniDocument()
  g.window = {
    document: doc, HTMLIFrameElement: class {}, location: { hash: '', search: '', pathname: '/' },
    addEventListener: () => undefined, removeEventListener: () => undefined, setTimeout: (f: () => void, ms?: number) => setTimeout(f, ms), clearTimeout: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
  }
  g.HTMLIFrameElement = (g.window as { HTMLIFrameElement: unknown }).HTMLIFrameElement
  g.document = doc
  g.IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) g[k] = v
})
const unmounts: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const u of unmounts.splice(0)) await u()
})

async function mount() {
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useAskField, restoreAskDraft } = await import('./useAskField')
  let field: ReturnType<typeof useAskField> | null = null
  const Field = () => {
    field = useAskField({ experience: 'invented-test', onAct: async () => false })
    return createElement('p', null, `${field.value}|${field.list.length}`)
  }
  const container = doc.body.appendChild(doc.createElement('div'))
  const root = createRoot(container as unknown as HTMLElement)
  await act(async () => root.render(createElement(Field)))
  unmounts.push(async () => act(async () => root.unmount()))
  return {
    act,
    shown: () => { const [value, rows] = container.textContent.split('|'); return { value, rows: Number(rows) } },
    type: async (v: string) => act(async () => field!.change(v)),
    restore: async (v: string) => act(async () => { restoreAskDraft(v, 'invented-test') }),
  }
}

describe('restored words show no suggestion rows until the person types', () => {
  it('typed: rows; restored into an empty field: none; typing again: rows', async () => {
    const m = await mount()
    await m.type('kelp forests')
    const typed = m.shown()
    expect(typed.value).toBe('kelp forests')
    expect(typed.rows).toBeGreaterThan(0)
    await m.type('')
    await m.restore('kelp forests')
    expect(m.shown()).toEqual({ value: 'kelp forests', rows: 0 })
    await m.type('kelp forests!')
    expect(m.shown().rows).toBeGreaterThan(0)
  })

  it('the list is drawn from state, not the ref', () => {
    const src = fs.readFileSync(new URL('./useAskField.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/list: value\.trim\(\) && !wordsRestored \? shownList : \[\]/)
    expect(src).not.toMatch(/(?<!\.)\brestored\.current = (?!token; setWordsRestored)/)
  })
})
