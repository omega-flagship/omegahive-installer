// Purpose: the Tasks board's cards read in every built-in look: the text tokens the theme's rules give the text role
// stand out at their floor on the card's surface, laid over either page ground. A tester on Paper Studio, the light look,
// found the cards dark navy on its cream page (20 Nov): the card drew a fixed #12122e at 80%, which no look recolours, so
// Paper Studio's dark ink sat on it at about 1.7:1.
import { describe, expect, it } from 'vitest'
import seeds from '../../shell/uiVariants.seed.json'
import { DEFAULT_VARIANT, lookVars } from '../../shell/uiVariant'
import rules from '../../theme/theme.rules.json'
import { contrast } from '../../theme/themeCheck'

async function source(rel: string): Promise<string> {
  const fsName = 'node:fs'
  const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string | URL, e: string) => string }
  return fs.readFileSync(new URL(rel, import.meta.url), 'utf8')
}

/** a colour as [r, g, b, alpha] from #rrggbb or rgb(r g b / a) (the forms the looks write) */
function rgba(c: string): number[] {
  const hex = c.match(/^#([0-9a-f]{6})$/i)
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1)
  const rgb = c.match(/^rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)(?:\s*[/,]\s*([\d.]+))?\)$/)
  if (!rgb) throw new Error(`unparsed colour ${c}`)
  return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] ? Number(rgb[4]) : 1]
}
const over = (top: number[], under: number[]) => [0, 1, 2].map((i) => Math.round(top[i] * top[3] + under[i] * (1 - top[3])))
const toHex = (c: number[]) => '#' + c.map((x) => x.toString(16).padStart(2, '0')).join('')

const r = rules as { roles: Record<string, string>; checks: { token: string; floor: number }[] }
/** each text token with the floor the rules hold it to against the page */
const textFloors = Object.entries(r.roles).filter(([, kind]) => kind === 'text')
  .map(([token]) => ({ token, floor: Math.max(...r.checks.filter((c) => c.token === token).map((c) => c.floor)) }))

describe("the Tasks board's cards read in every look", () => {
  it('the rules give text tokens and floors to check (the test is reading them)', () => {
    expect(textFloors.map((t) => t.token)).toEqual(expect.arrayContaining(['ink', 'ink-3']))
    expect(textFloors.every((t) => t.floor >= 4.5)).toBe(true)
  })
  it("every text token stands out on the card's surface at its floor, over either page ground, in every built-in look", async () => {
    // the card's own class list: GoalCard's article, whose text takes the look's ink
    const card = (await source('./GoalsBoard.tsx')).match(/data-goal=\{g\.id\}[\s\S]*?className=\{cx\('([^']*)'/)?.[1] ?? ''
    const bg = card.match(/(?<![\w:-])bg-(\[#[0-9a-f]{6}\]|[a-z][\w-]*)(?:\/(\d+))?(?![\w-])/i)
    expect(bg, card).not.toBeNull()
    const [, name, percent] = bg!
    for (const v of [DEFAULT_VARIANT, ...(seeds as (typeof DEFAULT_VARIANT)[])]) {
      const vars = lookVars(v)
      const base = rgba(name.startsWith('[') ? name.slice(1, -1) : vars[`--color-${name}`])
      const surface = [...base.slice(0, 3), base[3] * (percent ? Number(percent) / 100 : 1)]
      for (const ground of ['void', 'abyss']) {
        const on = toHex(over(surface, rgba(vars[`--color-${ground}`])))
        const short = textFloors.filter((t) => contrast(vars[`--color-${t.token}`], on) < t.floor).map((t) => `${t.token} ${contrast(vars[`--color-${t.token}`], on).toFixed(2)}:1`)
        expect({ look: v.id, ground, short }).toEqual({ look: v.id, ground, short: [] })
      }
    }
  })
})
