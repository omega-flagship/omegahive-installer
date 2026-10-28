import { describe, expect, it } from 'vitest'
import { FEATURES } from './features/registry'
import { navCommands } from './features/palette/navCommands'
import { phrasesOf, WORDS } from './lib/intent/features'
import { STILL_VOCABULARY } from './experiences/still/vocab'
import { publicBlurb, publicLabel } from './experiences/publicWords'
import { scanShown, scanShownTree } from './shownStrings.testkit'

/**
 * Private apps (the owner's standing rule; stand-in TOWN_RELEASE r1/r2 BLOCKING): Atlas and Truth are never named by the UI's
 * own copy. An app appears by name only when the host lists it for that person (the Apps list, its own page, its own
 * form), never in shared or hard-coded words: directories, blurbs, search words, tours, notices, Change UI.
 * Logic vocabulary ("truth value", "TRUTH" as a belief's colour) is not the app and is not matched.
 */
export const PRIVATE_NAME = /(?<![-_/.$\w])(Atlas|ATLAS|atlas|OmegaTruth|Omega Truth|omegatruth|Truth)(?![-_/(\w]|\.\w)/
const PRIVATE_ANY = /atlas|omega ?truth|\btruth\b(?! values?)/i

/**
 * The few places allowed to name one, each because the host put the person there: `at` is a directory, a file or
 * `file:exact text`.
 */
const ALLOWED: { at: string; why: string }[] = [
  { at: 'ui/modal-harness-main.tsx', why: 'a developer harness page (modal-harness.html), not part of the hive build' },
  { at: 'forms/commons/parts.tsx:Truth', why: "a commons belief's truth (a column label in the Commons explorer), not the app" },
  { at: 'forms/commons/parts.tsx:Truth now', why: "a commons belief's current truth, not the app" },
]
const allowed = (rel: string, text: string) => ALLOWED.some((a) => (a.at.endsWith('/') ? rel.startsWith(a.at) : a.at === rel || a.at === `${rel}:${text}`))

describe('no private app is named by the UI’s own copy', () => {
  it('the scanner sees a private name in shown copy and leaves logic vocabulary alone', () => {
    expect(scanShown('x/a.tsx', "const a = <p>Open Atlas here</p>\n", PRIVATE_NAME, () => false)).toEqual(['x/a.tsx:1: Open Atlas here'])
    expect(scanShown('x/b.ts', "const b = { blurb: 'Truth, Fusion and the rest' }\n", PRIVATE_NAME, () => false)).toEqual(['x/b.ts:1: Truth, Fusion and the rest'])
    expect(scanShown('x/c.ts', "const c = { label: 'NAL truth value' }; const d = x === 'atlas'; const e = 'COLOUR = TRUTH'\n", PRIVATE_NAME, () => false)).toEqual([])
  })
  it('every shown string in hive/ui/src (tests, comments, keys and routes aside)', () => {
    const hits = scanShownTree(PRIVATE_NAME, allowed)
    if (hits.length) throw new Error(`${hits.length} shown strings name a private app (file:line):\n${hits.join('\n')}`)
    expect(hits).toEqual([])
  }, 60_000)
  it('the shared directory every experience renders (labels, blurbs, search words), as shown', () => {
    for (const f of FEATURES) expect(`${publicLabel(f)} | ${publicBlurb(f)} | ${f.keywords ?? ''}`, f.id).not.toMatch(PRIVATE_ANY)
  })
  it('the palette’s navigation search words', () => {
    for (const c of navCommands()) expect(JSON.stringify(c), c.label).not.toMatch(PRIVATE_ANY)
  })
  // Kimi town-r3 #1: the Ask's typed-intent vocabulary is the third sibling of those two lists (keywords are not shown
  // copy, so the scanner above cannot see them); every word table the fast path reads is listed here by hand
  it('the Ask’s intent words (lib/intent WORDS, every feature’s folded phrases, experience vocabularies)', () => {
    for (const [id, words] of Object.entries(WORDS)) expect(words.join(' | '), id).not.toMatch(PRIVATE_ANY)
    for (const f of FEATURES) expect(phrasesOf(f).join(' | '), f.id).not.toMatch(PRIVATE_ANY)
    expect(JSON.stringify(STILL_VOCABULARY)).not.toMatch(PRIVATE_ANY)
  })
})
