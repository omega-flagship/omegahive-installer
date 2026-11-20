// Purpose: the feedback and bug-report entry on every page, in every look and at every width: one button in the host's
// bottom-right corner beside the clock (shell/clockModel.ts reserves its place), counting the drafts waiting, and the
// area it opens, a sheet over the page whose content MeTTa composes (feedback.metta) and Screen draws. It also watches
// for what the hive drafts reports from: the page's errors and the Ask's turns (drafts.ts, watchAsk.ts).
import { AnimatePresence } from 'framer-motion'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { experienceById } from '../../experiences/registry'
import { useMediaQuery } from '../../lib/hooks'
import { usePageErrors, watchPageErrors } from '../../lib/recentErrors'
import { Screen, type ScreenItem } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { FEEDBACK_BESIDE_MIN } from '../../shell/clockModel'
import { KEEP_CLEAR } from '../../shell/experienceStage'
import { useAppStage } from '../../shell/appStage'
import { useStepAside } from '../../shell/stepAside'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { IconButton } from '../../ui/primitives'
import { Sheet } from '../../ui/Sheet'
import { LEAVE_OUT } from './capture'
import { feedbackScreen } from './data'
import { draftEvent, loadMindDrafts, settleDraft, useDrafts, watchHiveDrafts } from './drafts'
import { mergeErrors } from './report'
import { useOpenFeedback } from './open'
import { addPicture, canSharePicture, closeFeedback, copyLogs, copyReport, extrasOfState, openFeedback, openOnBoard, reportOf, saveLogs, saveReport, sendReport, sharePicture, showLogs, useFeedback } from './store'
import { watchScreens } from './trail'
import { watchAsk } from './watchAsk'
import './feedback.css'

const SKINS = new Set(['classic', 'still', 'canvas', 'cosmos', 'flux', 'construct'])
/** The words the entry is known by, everywhere: its accessible name and its hint. */
export const ENTRY_NAME = 'Send feedback or report a bug'
/** The entry's accessible name with the drafts waiting: "Send feedback or report a bug, 2 drafts waiting". */
const entryName = (waiting: number) => (waiting > 0 ? `${ENTRY_NAME}, ${waiting} draft${waiting === 1 ? '' : 's'} waiting` : ENTRY_NAME)

export function FeedbackHost({ experience }: { experience: string }) {
  const open = useFeedback((s) => s.open)
  const client = useHive((st) => st.client)
  // the page's errors and the screens visited are kept from the start, so a report made later carries them
  useEffect(() => watchPageErrors(), [])
  useEffect(() => watchScreens(), [])
  // what the hive drafts from: the page's errors as they come, and the Ask's turns
  useEffect(() => watchHiveDrafts(), [])
  useEffect(() => watchAsk(() => useHive.getState().client), [])
  // the minds' drafts, now and as the hive says they change; a read the hive refused is with the page's errors already
  useEffect(() => {
    if (!client) return
    loadMindDrafts(client).catch(() => undefined)
    return client.subscribe(draftEvent)
  }, [client])
  return (
    <>
      <FeedbackEntry experience={experience} hidden={open} />
      <AnimatePresence>{open && <FeedbackSheet key="feedback" experience={experience} />}</AnimatePresence>
    </>
  )
}

/**
 * The entry: a pill with its word just left of the clock's reserved slot from 1024 px, its icon standing on the clock
 * in a narrower window (feedback.css). It steps aside where all host chrome does, for a modal dialog and for a
 * full-bleed app (whose Omega menu carries the same entry), and while its own area is open; it stays for the rest,
 * whose own home has no clock.
 */
function FeedbackEntry({ experience, hidden }: { experience: string; hidden: boolean }) {
  const ref = useRef<HTMLButtonElement>(null)
  const aside = useStepAside(ref)
  const stage = useAppStage()
  const openFeedbackArea = useOpenFeedback()
  const waiting = useDrafts((s) => s.drafts.length)
  const shown = !hidden && aside !== 'modal' && stage?.mode !== 'full'
  const skin = SKINS.has(experience) ? experience : 'classic'
  const word = useWordFit(skin)
  return (
    <button
      ref={ref}
      type="button"
      hidden={!shown}
      className="feedback-entry"
      data-skin={skin}
      {...{ [KEEP_CLEAR]: '', [LEAVE_OUT]: '' }}
      data-tour="feedback-entry"
      aria-label={entryName(waiting)}
      onClick={() => openFeedbackArea()}
    >
      <Icon name="feedback" size={16} className="feedback-entry-icon" />
      <span ref={word} className="feedback-entry-word" aria-hidden="true">Feedback</span>
      {waiting > 0 && <span className="feedback-entry-count" aria-hidden="true">{waiting}</span>}
      <span className="feedback-entry-hint" aria-hidden="true">{entryName(waiting)}</span>
    </button>
  )
}

/**
 * The word whole in its room: at its own size where it fits, else just small enough. The skins name faces each platform
 * draws differently (canvas's Bradley Hand is Segoe Print on Windows and the system sans on Linux, where the word needed
 * 72 px against the 69 the fixed slot leaves it: shell/osClock.css --feedback-slot), so the fit is measured where the
 * word is drawn, each time it appears from 1024 px (FEEDBACK_BESIDE_MIN) and once the page's fonts have loaded.
 * Returns the ref the word's element takes.
 */
function useWordFit(skin: string) {
  const word = useRef<HTMLSpanElement>(null)
  const wide = useMediaQuery(`(min-width: ${FEEDBACK_BESIDE_MIN}px)`)
  useLayoutEffect(() => {
    const el = word.current
    if (!el || !wide) return
    const fit = () => {
      el.style.fontSize = ''
      if (el.scrollWidth <= el.clientWidth) return
      const size = parseFloat(getComputedStyle(el).fontSize)
      // in half pixels, rounded down, so the smaller word never overflows by a rounding
      el.style.fontSize = `${Math.floor((size * el.clientWidth * 2) / el.scrollWidth) / 2}px`
    }
    fit()
    document.fonts.addEventListener('loadingdone', fit)
    return () => document.fonts.removeEventListener('loadingdone', fit)
  }, [skin, wide])
  return word
}

function FeedbackSheet({ experience }: { experience: string }) {
  const s = useFeedback()
  const client = useHive((st) => st.client)
  const page = usePageErrors()
  const drafts = useDrafts((st) => st.drafts)
  const compose = useCompose(experienceById(experience).id)
  const share = useMemo(() => canSharePicture(), [])
  const { plan, data } = useMemo(() => {
    const report = reportOf(s, page)
    const available = mergeErrors(s.ctx?.errors ?? [], page).length
    const { data, facts } = feedbackScreen(s, report, { share }, available, drafts, extrasOfState(s, page))
    return { plan: compose('feedback', facts), data }
  }, [s, page, share, compose, drafts])

  const onInput = (bind: string, value: string) => {
    if (bind === 'report.kind' && (value === 'bug' || value === 'ux' || value === 'idea')) useFeedback.setState({ kind: value, done: 'none' })
    else if (bind === 'report.words') useFeedback.setState({ words: value, done: 'none' })
    else if (bind === 'report.expected') useFeedback.setState({ expected: value, done: 'none' })
    else if (bind === 'report.steps') useFeedback.setState({ steps: value, done: 'none' })
  }
  const onAction = (action: string, item?: ScreenItem, value?: boolean) => {
    if (action === 'attach-logs') useFeedback.setState((st) => ({ attach: { ...st.attach, kept: value === true }, done: 'none' }))
    else if (action === 'remove-picture') useFeedback.setState((st) => ({ picture: { ...st.picture, kept: false }, done: 'none' }))
    else if (action === 'add-picture') addPicture()
    else if (action === 'drop-errors') useFeedback.setState({ errorsKept: false, done: 'none' })
    else if (action === 'keep-errors') useFeedback.setState({ errorsKept: true, done: 'none' })
    else if (action === 'send') void sendReport(client)
    else if (action === 'open-board') void openOnBoard(client)
    else if (action === 'copy') void copyReport(client)
    else if (action === 'save') saveReport(client)
    else if (action === 'share-picture') void sharePicture()
    else if (action === 'logs-show') void showLogs(client)
    else if (action === 'logs-save') saveLogs()
    else if (action === 'logs-copy') void copyLogs()
    else if (action === 'use-draft') {
      const d = drafts.find((x) => x.id === item?.id)
      if (d) openFeedback(client, s.page.look, d)
    } else if (action === 'dismiss-draft' && typeof item?.id === 'string') void settleDraft(client, item.id)
  }

  const header = (
    <div className="flex items-center gap-2 px-4 pt-1 pb-2 md:pt-4">
      <div className="min-w-0 flex-1">
        <div className="eyebrow">Feedback</div>
      </div>
      <IconButton icon="x" label="Close feedback" onClick={closeFeedback} className="-mr-2" />
    </div>
  )
  return (
    // the whole sheet, its frame and backdrop included, stays out of the picture of the page (capture.ts LEAVE_OUT)
    <Sheet label={ENTRY_NAME} onClose={closeFeedback} header={header} width={480} attrs={{ [LEAVE_OUT]: '' }}>
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-6" {...{ [LEAVE_OUT]: '' }} data-feedback-area="">
        <Screen plan={plan} host={{ data, framed: true, busy: s.sending, onInput, onAction }} />
      </div>
    </Sheet>
  )
}
