// Purpose: the Ask's screen as every look draws it (screens/ask.metta): MeTTa composes, for the look being worn, the
// person's size and the kind of screen, the mark when the Ask is collapsed and the region the look's own Ask sits in;
// AskHost states the facts and draws the answer with InlineParts through the host this gives, the look's own Ask as
// the island `ask` and its living Omega as the mark's glyph, placing nothing itself.
import { useState, type ReactNode } from 'react'
import { macKeys } from '../../lib/shortcutOwner'
import type { ScreenHost } from '../../screens/Screen'
import { rememberedCompose, SCREEN_SOURCES, ScreensSpace, type Compose, type ScreenPlan } from '../../screens/screenSpace'
import type { AskSize } from '../../shell/uiVariant'
import { useAskStore } from '../../store/ask'
import type { AskMode, Placement } from './placement'
import { SIZE_WORDS } from './words'

/** How the look's own Ask lays itself out (screens/ask.metta): hidden behind the mark, the bubble, the left half, or a phone's full sheet. */
export type AskRegion = 'mark' | 'bubble' | 'half-left' | 'sheet'
const REGIONS: readonly string[] = ['mark', 'bubble', 'half-left', 'sheet']

export class AskScreenError extends Error {}

/**
 * The sources the Ask's screen is composed from: the rules, the looks' preferences and the screen itself. The Ask is on
 * every page from the first paint, so it opens these three rather than every screen; its answers are the whole space's
 * (askScreen.test.ts compares them for every look, size and kind of screen).
 */
export const ASK_SOURCES = SCREEN_SOURCES.filter(([name]) => name === 'lib_screens' || name === 'looks' || name === 'ask')
let space: ScreensSpace | null = null
const askSpace = (): ScreensSpace => (space ??= ScreensSpace.open(ASK_SOURCES))
// one composer per look: MeTTa answers once per look, size, kind of screen and whether the host draws the Ask
const composers = new Map<string, Compose>()

/**
 * MeTTa composes the Ask for `look` at the person's `size` on this kind of screen (`mode`); `drawn`: the host draws the
 * look's Ask on this page, so its mark may stand in for it. The region is the one island part's: an answer without
 * exactly one, or with a region the looks do not draw, is an error, never a guess.
 */
export function composeAsk(look: string, size: AskSize, mode: AskMode, drawn: boolean): { plan: ScreenPlan; region: AskRegion } {
  let compose = composers.get(look)
  if (!compose) composers.set(look, (compose = rememberedCompose(look, askSpace)))
  const plan = compose('ask', { values: { 'ask.size': size, 'ask.mode': mode }, flags: { 'ask.drawn': drawn } })
  const placed = plan.parts.filter((p) => p.block === 'island' && p.props.name === 'ask')
  const region = placed.length === 1 ? placed[0].props.region : undefined
  if (typeof region !== 'string' || !REGIONS.includes(region)) throw new AskScreenError(`the Ask's screen gave ${look} no single region at ${size} on a ${mode}`)
  return { plan, region: region as AskRegion }
}

export interface MarkState { state: 'answering' | 'resting'; news: boolean; label: string; title: string }

/**
 * What the mark says while it stands in for the Ask (`marked`): answering while a turn runs, and news when the thread
 * gained a row since it began to (an answer the person has not seen), counted from the render it began in.
 */
export function useMarkState(marked: boolean): MarkState {
  const answering = useAskStore((s) => !!s.open)
  const rows = useAskStore((s) => s.log.length)
  // the thread's rows when the mark began to stand in (state derived from the previous render, set during render)
  const [since, setSince] = useState({ marked, rows })
  if (since.marked !== marked) setSince({ marked, rows })
  const news = marked && !answering && rows > (since.marked === marked ? since.rows : rows)
  return {
    state: answering ? 'answering' : 'resting',
    news,
    label: answering ? SIZE_WORDS.openAnswering : news ? SIZE_WORDS.openNews : SIZE_WORDS.open,
    title: `${SIZE_WORDS.open} (${macKeys() ? '⌘K' : 'Ctrl+K'} or /)`,
  }
}

/**
 * The host the Ask's screen is drawn with (InlineParts, which draws its parts without wrappers, since they place
 * themselves over the page): the look's own Ask is the island `ask`, its living Omega the mark's glyph, the mark's words
 * and place are its data, and a press on the mark opens the Ask.
 */
export function askScreenHost({ island, glyph, place, mark, onOpen }: { island: ReactNode; glyph: ReactNode; place: Placement; mark: MarkState; onOpen: () => void }): ScreenHost {
  return {
    data: { 'ask.mark.label': mark.label, 'ask.mark.title': mark.title, 'ask.state': mark.state, 'ask.news': mark.news, 'ask.left': place.left, 'ask.bottom': place.bottom, 'ask.mode': place.mode },
    islands: { 'ask': island, 'ask-glyph': glyph },
    onAction: (action) => {
      if (action === 'open-ask') onOpen()
    },
  }
}
