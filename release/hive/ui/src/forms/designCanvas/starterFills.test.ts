import { describe, expect, it } from 'vitest'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { Empty } from './Chrome'
import { SUGGESTIONS } from './words'

const fsName = 'node:fs'
const { readFileSync } = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string, e: 'utf8') => string }

/**
 * j0-fixes r1 item 2: a Studio starter FILLS the Ask and never sends (live J0 finding: tapping "A poster for a
 * neighbourhood event" sent a paid request at once). Two halves, both needed:
 *  1. pressing each starter button in the empty state hands its words to the canvas's `ask` callback, unchanged;
 *  2. that callback is the fill path: DesignCanvas builds it from `fillAsk` and nothing in the canvas reaches the Ask
 *     store's send or steer (the pre-fix `useAskSend` called `st.send` / `st.steer`).
 */

function buttons(node: ReactNode, out: ReactElement<{ className?: string; onClick?: () => void }>[] = []) {
  if (Array.isArray(node)) { for (const n of node) buttons(n, out); return out }
  if (!isValidElement(node)) return out
  const el = node as ReactElement<{ className?: string; onClick?: () => void; children?: ReactNode }>
  if (el.type === 'button' && el.props.className === 'dc-suggestion') out.push(el)
  buttons(el.props.children, out)
  return out
}

describe('Studio starters fill the Ask (never send)', () => {
  it('each starter button passes its own words to the ask callback', () => {
    const got: string[] = []
    const tree = Empty({ ask: (t: string) => { got.push(t) }, askReady: true, recent: [], scope: undefined })
    const starters = buttons(tree)
    expect(starters.length).toBe(SUGGESTIONS.length)
    starters.forEach((b) => b.props.onClick?.())
    expect(got).toEqual(SUGGESTIONS.map((x) => x.ask))
  })

  it('the canvas builds its ask callback from fillAsk and never reaches send or steer', () => {
    const src = readFileSync(decodeURIComponent(new URL('./DesignCanvas.tsx', import.meta.url).pathname), 'utf8')
    const hook = src.slice(src.indexOf('function useAskFill'), src.indexOf('function useAskRoom'))
    expect(hook).toMatch(/fillAsk\(/)
    expect(src).toMatch(/const ask = useAskFill\(\)/)
    // no route from the canvas to a model request: the store's send/steer, or the old send hook
    expect(src).not.toMatch(/\.send\(|\.steer\(|useAskSend|requestSubmit\(/)
  })
})
