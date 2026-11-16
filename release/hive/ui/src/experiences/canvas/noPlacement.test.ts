// Purpose: no Canvas placement is decided in TypeScript. The Canvas look's sources hold no geometry of their own (no
// size, gap or lane constant, no layout function) and build no board item; the look takes its board from MeTTa
// (board.ts's composeBoard) alone; and each part of the board draws exactly the rectangle MeTTa gave its item.
// INVENTED swarms, minds, tasks and decisions.
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Agent, Approval, Goal, Swarm } from '../sdk'
import { boardInput, composeBoard } from './board'
import { pendingDecisions, type Item } from './layout'
import { AddSticky, DecisionSticky, GoalSticky, Lane, MindCard } from './parts'

const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: URL, e: 'utf8') => string; readdirSync: (p: URL) => string[] }
const sources = fs.readdirSync(new URL('./', import.meta.url))
  .filter((f) => /\.tsx?$/.test(f) && !/\.test\.|\.testkit\./.test(f))
  .map((f) => [f, fs.readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')] as const)

describe('no Canvas placement is decided in TypeScript', () => {
  it('the look’s sources hold no size, gap or lane constant and no layout function', () => {
    const found: string[] = []
    // numbers that place nothing: how long a decision's buttons wait before they arm, and how far the camera zooms
    const notPlacement = new Set(['decision.ts: ARM_MS', 'engine.ts: MIN_Z', 'engine.ts: MAX_Z'])
    for (const [f, text] of sources) {
      // a named number at module level is a size, gap or count someone chose: the board's are MeTTa's (board.metta)
      for (const m of text.matchAll(/^(?:export )?const ([A-Z][A-Z0-9_]+) = -?\d/gm)) if (!notPlacement.has(`${f}: ${m[1]}`)) found.push(`${f}: ${m[1]}`)
      for (const word of ['computeLayout', 'goalOrder', 'CARD_W', 'CARD_H', 'ST_W', 'ST_H', 'LANE_W', 'DEC_H', 'CHAT_W', 'CHAT_H', 'ISLAND_GAP']) {
        if (new RegExp(`\\b${word}\\b`).test(text)) found.push(`${f}: ${word}`)
      }
    }
    expect(found).toEqual([])
  })

  it('builds board items only from MeTTa’s answer, and the look takes its board from it alone', () => {
    const builders = sources.filter(([, text]) => /\bitems\.set\(/.test(text)).map(([f]) => f)
    expect(builders).toEqual(['board.ts'])
    const index = sources.find(([f]) => f === 'index.tsx')![1]
    expect(index.match(/composeBoard\(/g)).toHaveLength(1)
  })

  it('draws each part at the rectangle MeTTa gave its item', () => {
    const swarm = { id: 's_home', name: 'Home', hue: 120, coordinator_id: 'a_vega', description: '', member_ids: [], created_at: '2026-10-01T00:00:00Z' } as unknown as Swarm
    const agent = (id: string, name: string) => ({ id, name, swarm_id: 's_home', status: 'awake', kind: 'omega', model: 'x/m', persona: '', hue: 200, driver: 'd', budget_usd: 1, spent_usd: 0, connected: true, last_active_at: null, created_at: '2026-10-01T00:00:00Z' }) as unknown as Agent
    const goal = (id: string, status: Goal['status']) => ({ id, swarm_id: 's_home', parent_id: null, title: `Task ${id}`, detail: '', priority: 0.5, status, created_by: 'user:p_ada', claimed_by: null, result: null, created_at: '2026-11-10T10:00:00Z', updated_at: '2026-11-10T10:00:00Z' }) as Goal
    const approval = { id: 'ap_one', agent_id: 'a_vega', skill: 'shell', command: '(shell "ls")', reason: 'r', risk: 'high', status: 'pending', decided_by: null, created_at: '2026-11-10T10:00:00Z', decided_at: null } as Approval
    const agents = [agent('a_vega', 'Vega'), agent('a_orion', 'Orion'), agent('a_lyra', 'Lyra')]
    const goals = [goal('g_one', 'open'), goal('g_two', 'claimed'), goal('g_three', 'done')]
    const board = composeBoard(boardInput(agents, [swarm], goals, pendingDecisions({ ap_one: approval }), 1.6))
    const noop = () => undefined
    const drawn = (it: Item): string => {
      switch (it.kind) {
        case 'mind': return renderToStaticMarkup(createElement(MindCard, { r: it, agent: agents.find((a) => a.id === it.id)!, lod: 'detail', phase: undefined, said: null, heard: null, heardFrom: null, now: 0, selected: false, onSelect: noop, onOpen: noop, onFocusItem: noop } as never))
        case 'goal': return renderToStaticMarkup(createElement(GoalSticky, { r: it, goal: goals.find((g) => g.id === it.id)!, lod: 'detail', holder: null, motivations: [], selected: false, mode: 'light', onSelect: noop, onFocusItem: noop }))
        case 'add': return renderToStaticMarkup(createElement(AddSticky, { r: it, lod: 'detail', drafting: false, reduced: true, draftKey: 'k', onStart: noop, onCancel: noop, onSubmit: () => Promise.resolve(true) }))
        case 'lane': return renderToStaticMarkup(createElement(Lane, { r: it, lod: 'detail', count: 1, mode: 'light' }))
        case 'decision': return renderToStaticMarkup(createElement(DecisionSticky, { r: it, approval, agent: agents[0], lod: 'detail', now: 0, selected: false, reduced: true, onSelect: noop, onInspect: noop, onFocusItem: noop } as never))
        default: return ''
      }
    }
    const kinds = new Set<string>()
    for (const it of board.items.values()) {
      const html = drawn(it)
      if (!html) continue
      kinds.add(it.kind)
      // the part's own position: left and top, or a translate
      const at = /left:\s*(-?[\d.]+)px;\s*top:\s*(-?[\d.]+)px/.exec(html) ?? /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(html)
      expect(at, it.key).not.toBeNull()
      expect([Number(at![1]), Number(at![2])], it.key).toEqual([it.x, it.y])
      const size = /width:\s*(-?[\d.]+)px;\s*height:\s*(-?[\d.]+)px/.exec(html)
      if (size) expect([Number(size[1]), Number(size[2])], it.key).toEqual([it.w, it.h])
    }
    expect([...kinds].sort()).toEqual(['add', 'decision', 'goal', 'lane', 'mind'])
  })
})
