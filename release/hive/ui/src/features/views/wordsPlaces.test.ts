// Purpose: words said in the hive are the part MeTTa composes for them in every look (features/views/words.metta, drawn through features/views/Words.tsx): every look's chat with a mind draws them through Words, so does every view the looks share (a mind's answer in the Ask, a room, a session, a mind's note, a goal's detail, a belief as written), MeTTa gives every look the said block for them and the as-written part only when it is asked for, and no component draws an artifact chip or a statement's English by hand. A look added to the registry without a chat entry here fails the build.
import { describe, expect, it, vi } from 'vitest'
import { ScreensSpace } from '../../screens/screenSpace'

// MeTTa opens its space once for the file: allow for a loaded machine
vi.setConfig({ testTimeout: 20_000 })

const fsName = 'node:fs'
const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string, e: 'utf8') => string; readdirSync: (p: string, o?: { recursive?: boolean }) => string[] }
const SRC = new URL('../..', import.meta.url).pathname
const read = (p: string) => fs.readFileSync(`${SRC}${p}`, 'utf8')

/** Where each look draws its conversation with a mind, the words of both sides; each component is named as its file is,
 *  except a look whose chat is a part of a larger file. */
const CHATS: Record<string, string> = {
  classic: 'features/dot/Chat.tsx',
  cosmos: 'experiences/cosmos/Panels.tsx',
  still: 'experiences/still/Reading.tsx',
  professional: 'experiences/professional/Conversation.tsx',
  construct: 'experiences/construct/Panes.tsx',
  flux: 'experiences/flux/panels.tsx',
  canvas: 'experiences/canvas/chat.tsx',
}
/** Words drawn in views every look opens, or in a look's own sheets: a mind's answer in the Ask (in each look's grammar),
 *  a room's talk, a session, a mind's unprompted note, a goal's detail and result, and a statement as written beside a
 *  belief. */
const SHARED = [
  'features/ask/Thread.tsx',
  'features/messages/MessagesPage.tsx',
  'features/messages/SessionView.tsx',
  'features/messages/CoffeeParts.tsx',
  'experiences/flux/sheets.tsx',
  'experiences/cosmos/Deck.tsx',
  'ui/Belief.tsx',
]
/** Every look the registry offers, read from its source so a new look needs a chat entry. */
const LOOKS = [...read('experiences/registry.ts').matchAll(/^\s+id: '([a-z]+)',/gm)].map((m) => m[1]).sort()
const space = ScreensSpace.open()
const composed = (look: string, flags: Record<string, boolean>) => space.compose('words', look, { flags }).parts.map((p) => [p.order, p.block])

describe('words said in the hive are composed in every look', () => {
  it('names the chat of every look the registry offers', () => {
    expect(LOOKS.length).toBeGreaterThan(5)
    expect(Object.keys(CHATS).sort()).toEqual(LOOKS)
  })

  it.each(Object.entries(CHATS))("%s: %s draws a conversation's words through Words", (_look, file) => {
    expect(read(file)).toMatch(/<Words\b[^>]*\btext=/)
  })

  it.each(SHARED)('%s draws its words through Words', (file) => {
    expect(read(file)).toMatch(/<Words\b[^>]*\btext=/)
  })

  it.each(LOOKS)('%s: MeTTa composes the said block for the words, and the as-written part only when it is asked for', (look) => {
    expect(composed(look, { 'words.said': true })).toEqual([[10, 'said']])
    expect(composed(look, { 'words.said': true, 'words.written': true })).toEqual([[10, 'said'], [20, 'written']])
    expect(composed(look, { 'words.written': true })).toEqual([[20, 'written']])
    expect(composed(look, {})).toEqual([])
  })

  it('draws nothing by hand: only the composed part draws a chip or a statement, and only ComposedWords composes the words', () => {
    const files = fs.readdirSync(SRC, { recursive: true }).filter((p) => /\.tsx?$/.test(p) && !/\.(test|testkit)\./.test(p))
    expect(files.filter((p) => /\('words',/.test(read(p)))).toEqual(['features/views/ComposedWords.tsx'])
    // a chip carries data-artifact-ref and a statement said in English carries data-said: only the blocks draw them
    expect(files.filter((p) => /data-artifact-ref=|data-said=/.test(read(p)))).toEqual(['screens/Screen.tsx'])
    // the hand-drawn components this replaced are gone
    expect(files.filter((p) => /\b(RefText|PlainText|ArtifactRef)\b/.test(read(p)))).toEqual([])
  })
})
