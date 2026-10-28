import type { PrepareResult } from './machine'
import { targetName, type Chapter, type Rect, type Target, type TourCtx } from './script'

/** One beat as played, for automated checks (the end-to-end script reads `window.__hiveTour.report`). */
export interface ReportRow {
  chapter: string
  beat: number
  targets: { name: string; found: boolean }[]
  /** The beat's subject was not on screen, so it was skipped with a note (followups-r6). */
  skipped?: boolean
}

/**
 * Shown in place of the caption when a beat's subject is not on screen (a page that did not open in time, a list with
 * nothing in it): the tour says so and moves on, rather than narrating something that is not there (followups-r6).
 */
export const SKIP_NOTE = 'This step isn’t on screen here, so the tour skips it.'

/** What preparing a beat needs from the player: its targets, spotlight and pointer, injected so it is tested. */
export interface PrepareDeps {
  chapters: Chapter[]
  ctx: TourCtx
  reduced: boolean
  /** The target as an element or a rect, waiting up to `ms` for it; null when it never shows. */
  resolve(t: Target, ms?: number): Promise<Element | Rect | null>
  /** Scroll it into view when it is not. */
  reveal(got: Element | Rect): Promise<void>
  setTarget(t: Target | null, el: Element | null): void
  hasTarget(): boolean
  /** The pointer's click ripple. */
  click(): void
  /** A beat starts: its report row; the previous caption goes. */
  begin(row: ReportRow): void
}

const isElement = (x: unknown): x is Element => typeof Element !== 'undefined' && x instanceof Element
const isHTMLElement = (x: unknown): x is HTMLElement => typeof HTMLElement !== 'undefined' && x instanceof HTMLElement

/**
 * Put the UI in place for one beat (the runner's `prepare`): the chapter's setup on its first beat, the pointer and its
 * click, the beat's `do`, then the spotlight on what the sentence is about. When that subject never shows, the beat is
 * skipped with SKIP_NOTE (`{ skip }`): a `waitFor` that timed out (it returns null) ends here, honestly, never in a hang
 * or a crash. A beat whose pointer found its element narrates while the click runs (`{ rest }`), as before.
 */
export function beatPreparer(d: PrepareDeps) {
  return async (ci: number, bi: number, fresh: boolean, isCurrent: () => boolean): Promise<PrepareResult | void> => {
    const ch = d.chapters[ci]
    const b = ch.beats[bi]
    const row: ReportRow = { chapter: ch.id, beat: bi, targets: [] }
    d.begin(row)
    if (fresh) {
      d.setTarget(null, null)
      await ch.setup(d.ctx)
      if (!isCurrent()) return
    }
    const show = b.show === undefined ? b.point : b.show
    // spotlight what the sentence is about (after the click, when there is one); false: it is not on screen
    const spotlight = async (): Promise<boolean> => {
      if (!show) {
        d.setTarget(null, null)
        return true
      }
      const same = show === b.point && !b.do && !b.press
      const got = same ? await d.resolve(show, 100) : await d.resolve(show)
      if (!same) row.targets.push({ name: targetName(show) ?? '?', found: !!got })
      if (!isCurrent()) return true
      if (!got) {
        d.setTarget(null, null)
        return false
      }
      await d.reveal(got)
      if (!same || !d.hasTarget()) d.setTarget(show, isElement(got) ? got : null)
      return true
    }
    const skip = (): PrepareResult => {
      row.skipped = true
      return { skip: SKIP_NOTE }
    }
    if (b.point) {
      const got = await d.resolve(b.point)
      row.targets.push({ name: targetName(b.point) ?? '?', found: !!got })
      if (!isCurrent()) return
      if (got) {
        await d.reveal(got)
        d.setTarget(b.point, isElement(got) ? got : null)
        // the sentence starts now, while the pointer travels; the click and what follows run alongside it
        const rest = (async () => {
          await d.ctx.sleep(d.reduced ? 150 : 700)
          if (!isCurrent()) return
          d.click()
          await d.ctx.sleep(220)
          if (b.press && isHTMLElement(got)) got.click()
          if (b.do) await b.do(d.ctx)
          if (isCurrent()) await spotlight()
        })()
        return { rest }
      }
      // nothing to point at: the beat's own work first, then it narrates only if its subject is there
    }
    if (b.do) await b.do(d.ctx)
    if (!isCurrent()) return
    if (!(await spotlight())) return skip()
  }
}
