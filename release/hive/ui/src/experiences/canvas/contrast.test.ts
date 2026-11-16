import { describe, expect, it } from 'vitest'
import { contrast, dim, flatten, over, parse, ratio, type RGBA } from './contrast'
import { GOAL_PAPER, RISK_PAPER } from './data'
import { avatarFill, tint, TOKENS, type Mode } from './theme'

interface Row {
  mode: Mode | 'both'
  where: string
  fg: string
  bg: string
  ratio: number
  min: number
}

const hex = (c: RGBA) => '#' + c.slice(0, 3).map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')
const rgb = (c: RGBA) => `rgb(${c.slice(0, 3).map((v) => Math.round(v)).join(' ')})`

/** Every text/background (4.5:1) and UI-edge (3:1) pair the Canvas board draws, in both modes. */
function table(): Row[] {
  const rows: Row[] = []
  const add = (mode: Row['mode'], where: string, fg: RGBA | string, bg: RGBA | string, min = 4.5) => {
    const F = typeof fg === 'string' ? fg : rgb(fg)
    const B = typeof bg === 'string' ? bg : rgb(bg)
    rows.push({ mode, where, fg: typeof fg === 'string' ? fg : hex(fg), bg: typeof bg === 'string' ? bg : hex(bg), ratio: contrast(F, B), min })
  }
  const HUES = Array.from({ length: 24 }, (_, i) => i * 15)
  for (const mode of ['light', 'dark'] as Mode[]) {
    const T = TOKENS[mode]
    const paper = T['--paper']
    const surfaces: [string, RGBA][] = [
      ['paper', parse(paper)],
      ['card', parse(T['--card'])],
      ['card-2', parse(T['--card-2'])],
      ['bubble', parse(T['--bubble'])],
      ['chrome over paper', flatten(T['--chrome'], paper)],
      ['lane over paper', flatten(mode === 'light' ? 'rgba(22,22,26,0.035)' : 'rgba(255,255,255,0.03)', paper)],
    ]
    for (const [name, bg] of surfaces) for (const ink of ['--ink', '--ink-2', '--ink-3']) add(mode, `${ink} on ${name}`, T[ink], bg)
    // the thinking chip, accent text, strong buttons, own bubbles, badges, errors, selection bar
    add(mode, '--accent-ink on card', T['--accent-ink'], T['--card'])
    add(mode, '--accent-ink on accent-soft over card', T['--accent-ink'], flatten(T['--accent-soft'], T['--card']))
    add(mode, '--on-accent on accent', T['--on-accent'], T['--accent'])
    add(mode, '--bubble-me-ink on bubble-me', T['--bubble-me-ink'], T['--bubble-me'])
    add(mode, '--on-bad on bad (count badges)', T['--on-bad'], T['--bad'])
    add(mode, '--bad on card (errors, waiting)', T['--bad'], T['--card'])
    add(mode, '--paper on ink (selection bar, Approve)', T['--paper'], T['--ink'])
    add(mode, '--ink-2 on line badge over chrome', T['--ink-2'], flatten(T['--line'], T['--chrome'], paper))
    add(mode, '--ink on accent-soft over chrome (hover)', T['--ink'], flatten(T['--accent-soft'], T['--chrome'], paper))
    // islands: title and stats on every swarm tint, and the unassigned island
    for (const h of [...HUES, null]) {
      const t = tint(h, mode)
      const tag = h === null ? 'unassigned' : `hue ${h}`
      add(mode, `island title on fill (${tag})`, t.title, t.fill)
      add(mode, `--ink-2 on island fill (${tag})`, T['--ink-2'], t.fill)
      add(mode, `focus ring --accent vs island fill (${tag})`, T['--accent'], t.fill, 3)
    }
    // focus rings and edges
    for (const [name, bg] of surfaces.slice(0, 5)) add(mode, `focus ring --accent vs ${name}`, T['--accent'], bg, 3)
    add(mode, 'focus ring --paper inside selection bar (--ink)', paper, T['--ink'], 3)
    add(mode, 'Deny / dialog button edge --ink vs card', T['--ink'], T['--card'], 3)
    // paper stickies (dark mode draws them through brightness(0.93))
    const k = mode === 'dark' ? 0.93 : 1
    const fill = parse(tint(220, mode).fill)
    for (const [status, p] of Object.entries(GOAL_PAPER)) {
      const bg = dim(parse(p), k)
      add(mode, `goal ink on ${status} sticky`, dim(parse('#16161a'), k), bg)
      add(mode, `goal label .72 on ${status} sticky`, dim(flatten('rgba(22,22,26,.72)', p), k), bg)
      add(mode, `goal holder .74 on ${status} sticky`, dim(flatten('rgba(22,22,26,.74)', p), k), bg)
      if (status === 'done' || status === 'failed' || status === 'cancelled') {
        // the whole sticky is drawn at .78 opacity over the island
        const a = (c: RGBA): RGBA => [c[0], c[1], c[2], 0.78]
        add(mode, `goal ink on faded ${status} sticky`, over(a(dim(parse('#16161a'), k)), over(a(bg), fill)), over(a(bg), fill))
      }
      add(mode, `focus ring #16161a vs ${status} sticky`, '#16161a', hex(bg), 3)
    }
    for (const [risk, p] of Object.entries(RISK_PAPER)) {
      add(mode, `ink on ${risk}-risk note`, '#16161a', p)
      add(mode, `risk paper on #16161a chip (${risk})`, p, '#16161a')
      add(mode, `age .78 on ${risk}-risk note`, flatten('rgba(22,22,26,.78)', p), p)
      add(mode, `command preview on ${risk}-risk note`, '#16161a', flatten('rgba(22,22,26,.08)', p))
      add(mode, `focus ring #16161a vs ${risk}-risk note`, '#16161a', p, 3)
    }
  }
  add('both', 'white on Review button (#16161a)', '#ffffff', '#16161a')
  add('both', 'draft placeholder .62 on open sticky', flatten('rgba(22,22,26,.62)', GOAL_PAPER.open), GOAL_PAPER.open)
  add('both', 'draft Cancel .8 on open sticky', flatten('rgba(22,22,26,.8)', GOAL_PAPER.open), GOAL_PAPER.open)
  add('both', 'draft error #8f1d14 on open sticky', '#8f1d14', GOAL_PAPER.open)
  for (const p of ['#ff9b8c', '#fff1a8']) add('both', `search badge ink on ${p}`, '#16161a', p)
  for (let h = 0; h < 360; h++) {
    add('both', `white initial / cursor label on avatar (hue ${h})`, '#ffffff', avatarFill(h))
    add('both', `search swarm badge ink (hue ${h})`, '#16161a', `hsl(${h} 70% 88%)`)
  }
  return rows
}

describe('Canvas palette contrast (WCAG 2.x)', () => {
  it('measures known references correctly', () => {
    expect(ratio(parse('#000'), parse('#fff'))).toBeCloseTo(21, 5)
    expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.54, 2)
    expect(contrast('rgba(0,0,0,0.5)', '#ffffff')).toBeCloseTo(3.95, 1)
    expect(parse('hsl(0 100% 50%)').slice(0, 3)).toEqual([255, 0, 0])
  })

  it('every text pair reaches 4.5:1 and every UI edge 3:1, light and dark', async () => {
    const rows = table()
    // the app tsconfig has no node types; reach node only when asked to write the table
    const out = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.CONTRAST_TABLE
    if (out) {
      const lines = ['| mode | pair | fg | bg | ratio | min | ok |', '|---|---|---|---|---|---|---|']
      for (const r of rows) lines.push(`| ${r.mode} | ${r.where} | ${r.fg} | ${r.bg} | ${r.ratio.toFixed(2)} | ${r.min} | ${r.ratio >= r.min ? 'yes' : 'NO'} |`)
      // CONTRAST_TABLE=<path> writes the full measured table (markdown)
      const fs = (await import(/* @vite-ignore */ `node:${'fs'}`)) as { writeFileSync: (p: string, s: string) => void }
      fs.writeFileSync(out, lines.join('\n') + '\n')
    }
    const failing = rows.filter((r) => r.ratio < r.min).map((r) => `${r.mode} ${r.where}: ${r.ratio.toFixed(2)} < ${r.min}`)
    expect(failing).toEqual([])
    expect(rows.length).toBeGreaterThan(900)
  })
})
