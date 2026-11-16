// Purpose: Jon on #283: the battery belongs where each look shows usage, so every look's frame carries the frame screen's usage region (screens/frame.metta, drawn by shell/UsageRegion.tsx), every view drawn over a look's frame (a page, a mind's panel, Still's reading) carries it in its own header, every mind's chat sits in a view that carries it, the battery's parts land in that region for every look, and no component mounts the battery or composes the frame by hand. A look added to the registry without a frame entry here fails the build.
import { describe, expect, it } from 'vitest'
import { ScreensSpace } from '../../screens/screenSpace'

const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string, e: 'utf8') => string; readdirSync: (p: string, o?: { recursive?: boolean }) => string[] }
const SRC = new URL('../..', import.meta.url).pathname
const read = (p: string) => fs.readFileSync(`${SRC}${p}`, 'utf8')

/** Each look's frame: the file that draws its usage region where the look shows usage (classic: its top bar after
 *  Spend). A look's rest and awake views show no usage, so they carry none. */
const FRAMES: Record<string, string> = {
  classic: 'shell/Hud.tsx',
  cosmos: 'experiences/cosmos/index.tsx',
  still: 'experiences/still/index.tsx',
  professional: 'experiences/professional/index.tsx',
  construct: 'experiences/construct/index.tsx',
  flux: 'experiences/flux/index.tsx',
  canvas: 'experiences/canvas/overlays.tsx',
}
/** Views drawn over a look's frame, in every look or in one: each draws the region in its own header, marked covering,
 *  so the frame's yields while it is open. */
const COVERING = ['ui/Page.tsx', 'features/dot/DotPanel.tsx', 'experiences/still/Reading.tsx']
/** Where a person writes to one mind, and the view around it that draws the region: classic's chat in a mind's panel,
 *  Professional's in its workspace under the top bar, and Still's reading, which is that view itself. Each component is
 *  named as its file is. */
const MIND_CHATS: [chat: string, drawnIn: string][] = [
  ['features/dot/Chat.tsx', 'features/dot/DotPanel.tsx'],
  ['experiences/professional/Conversation.tsx', 'experiences/professional/index.tsx'],
  ['experiences/still/Reading.tsx', 'experiences/still/Reading.tsx'],
]
/** Every look the registry offers, read from its source so a new look needs a frame entry. */
const LOOKS = [...read('experiences/registry.ts').matchAll(/^\s+id: '([a-z]+)',/gm)].map((m) => m[1]).sort()

describe("the battery is in every look's usage region", () => {
  it('names a frame for every look the registry offers', () => {
    expect(LOOKS.length).toBeGreaterThan(5)
    expect(Object.keys(FRAMES).sort()).toEqual(LOOKS)
  })

  it.each(Object.entries(FRAMES))("%s: %s draws the look's usage region", (_look, file) => {
    expect(read(file)).toMatch(/<UsageRegion(?![^>]*\bcovering\b)[^>]*\/>/)
  })

  it.each(COVERING)('%s is drawn over a frame and draws the region itself', (file) => {
    expect(read(file)).toMatch(/<UsageRegion\b[^>]*\bcovering\b/)
  })

  it.each(MIND_CHATS)('%s is drawn in %s, which draws the region', (chat, drawnIn) => {
    const name = chat.split('/').pop()!.replace(/\.tsx$/, '')
    expect(read(chat)).toMatch(new RegExp(`export function ${name}\\b`))
    expect(drawnIn === chat || new RegExp(`<${name}\\b`).test(read(drawnIn))).toBe(true)
    expect(read(drawnIn)).toMatch(/<UsageRegion\b/)
  })

  it.each(LOOKS)('%s: MeTTa places the battery in the usage region', (look) => {
    const plan = ScreensSpace.open().compose('frame', look, { flags: { 'allowance.mine': true } })
    expect(plan.parts.filter((p) => p.place.region === 'usage').map((p) => [p.order, p.block])).toEqual([[10, 'progress']])
  })

  it('mounts nothing by hand: only the usage region composes the frame, and no component draws the battery itself', () => {
    const files = fs.readdirSync(SRC, { recursive: true }).filter((p) => /\.tsx?$/.test(p) && !/\.(test|testkit)\./.test(p))
    const composers = files.filter((p) => /compose\('frame'/.test(read(p)))
    expect(composers).toEqual(['shell/FrameUsage.tsx'])
    expect(files.filter((p) => /AllowanceStat|AllowanceMeter\b/.test(read(p)))).toEqual([])
  })
})
