import { describe, expect, it } from 'vitest'
import { scanShown, scanShownTree } from './shownStrings.testkit'
import { chromeWord, nativeWords } from './inventory/nativeWords'
import { NAV_ITEMS } from './shell/navItems'
import { PANE_TITLE } from './experiences/construct/state'
import { COMMANDS } from './experiences/construct/commands'

/**
 * The page where a person answers what minds ask is named once, in inventory/intents.metta (chrome.inbox), and every
 * screen reads the name there: MeTTa composes the screen and React only draws it. Jon, testers' chat, 13 Nov 2026:
 * the Inbox becomes Notifications. So no shown string spells the page's name, old or new, and a rename is one atom.
 *
 * Allowances are exact: `file:text`, the whole shown string as the scanner reads it, with a reason. Never a whole file.
 */
type Allow = { at: string; why: string }
// the word, never part of a key such as the intent id chrome.inbox or the class name cx-inbox
const NAME = /(?<![-_/.$\w])(inbox|notifications?)(?![-_/(\w]|\.\w)/i
const ALLOWED: Allow[] = [
  { at: 'experiences/construct/index.tsx:inbox', why: "the asks pane's id (PaneId), a key the scanner reads inside JSX, never shown" },
  { at: 'features/guided/scripts/people.ts:A joined agent is a member: it has an inbox, can take on tasks, publish beliefs, make requests and record motivations, under the same rules and limits as everyone else.', why: "an outside agent's own message inbox (an MCP member), not this page" },
  { at: 'features/palette/navCommands.ts:approve deny pending gate approvals decisions waiting answered asks requests history inbox', why: 'search words, never shown: the old name still finds the page' },
  { at: 'lib/intent/features.ts:request inbox', why: "words people may type for a swarm's incoming requests (swarms.requests), not this page" },
  { at: 'lib/intent/features.ts:my inbox', why: "words a person may type for the home page's place for what needs them (HOME_PLACES.needs), never shown" },
  { at: 'lib/intent/features.ts:my notifications', why: "words a person may type for the home page's place for what needs them (HOME_PLACES.needs), never shown" },
]
const allowed = (rel: string, text: string) => ALLOWED.some((a) => a.at === `${rel}:${text}`)
const said = (look: string) => nativeWords().say(look, 'chrome.inbox')

describe('the page a person answers minds on is named by intents.metta (chrome.inbox)', () => {
  it('the default look calls it Notifications, and the navigation reads that word', () => {
    expect(said('default')).toBe('Notifications')
    expect(NAV_ITEMS.find((i) => i.key === 'inbox')?.label).toBe(said('default'))
  })

  it("Construct's pane and command use its own word from the table, one lowercase word it can type", () => {
    const word = said('construct') ?? ''
    expect(word).toMatch(/^[a-z]+$/)
    expect(PANE_TITLE.inbox).toBe(word.toUpperCase())
    expect(COMMANDS.some((c) => c.name === word)).toBe(true)
  })

  it('chromeWord reads the table, and fails loudly for an intent it says nothing about', () => {
    expect(chromeWord('chrome.inbox')).toBe(said('default'))
    expect(chromeWord('chrome.inbox', 'construct')).toBe(said('construct'))
    expect(() => chromeWord('chrome.no-such-page')).toThrow(/says nothing for chrome\.no-such-page/)
  })

  it('the scanner catches the name in labels, prose and JSX, old or new, and leaves keys alone', () => {
    const src = [
      "const a = { label: 'Inbox' }",
      'const b = <p>waits in your Inbox for a yes</p>',
      "const c = { title: 'Opened Notifications to answer this' }",
      "const d = route.name === 'inbox' && setFocus('inbox')",
    ].join('\n')
    expect(scanShown('x/words.tsx', src, NAME, allowed)).toEqual([
      'x/words.tsx:1: Inbox',
      'x/words.tsx:2: waits in your Inbox for a yes',
      'x/words.tsx:3: Opened Notifications to answer this',
    ])
  })

  it('no shown string spells the name: every screen reads it from intents.metta', () => {
    const hits = scanShownTree(NAME, allowed)
    if (hits.length) throw new Error(`${hits.length} shown strings spell the page's name (file:line):\n${hits.join('\n')}`)
    expect(hits).toEqual([])
  }, 60_000)

  it('every allowance still matches something (a stale one is removed, not kept)', () => {
    const used = new Set<string>()
    scanShownTree(NAME, (rel, text) => {
      const key = `${rel}:${text}`
      if (ALLOWED.some((a) => a.at === key)) used.add(key)
      return true
    })
    expect(ALLOWED.map((a) => a.at).filter((at) => !used.has(at))).toEqual([])
  }, 60_000)
})
