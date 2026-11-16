/**
 * The setup nudge's pill, and its "Finish setup" (SetupChecklist's SetupNudge says it first): for anyone whose First
 * Light is set aside, until their mind has been awake, on every page and in every experience. A page drawn with ui/Page
 * shows it in its own header (`inline`); elsewhere App's one SetupNudge floats it at the nudge's place, above any page
 * drawn without that header (an app, Code). One tap reopens First Light over the page, where they left off. Its ×
 * hides it for that person in this browser, as Getting started's does; First Light stays one tap away on the Me page
 * ("Meet your mind") and by asking for it. Kept apart from the checklist, so every page header can carry it without
 * loading the checklist's reads.
 */
import { useLayoutEffect, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import { cx } from '../../lib/cx'
import { useMe } from '../../lib/useAdmin'
import { Icon, type IconName } from '../../ui/Icon'
import { startFirstLight } from '../firstlight/door'
import { isDismissed, setDismissed, type Nudge } from './checklist'
import { useFinishSetup } from './finishSetupRule'

/** Whether this nudge is hidden for the signed-in person (and a setter that re-renders), with who that is: undefined
 *  until the hive says, when nothing is known hidden or shown. */
export function useNudgeHidden(nudge: Nudge): [boolean, (v: boolean) => void, string | undefined] {
  const { me } = useMe()
  const principal = me?.principal
  // read per render (a cheap localStorage lookup, per person); the counter re-renders after a change here
  const [, bump] = useState(0)
  return [
    isDismissed(principal, undefined, nudge),
    (next) => {
      if (principal) setDismissed(principal, next, undefined, nudge)
      bump((n) => n + 1)
    },
    principal,
  ]
}

/**
 * Page headers showing Finish setup as their own row: while one is up, the floating copy stands down, so a page never
 * has it over its content (as StudioLiveBar's page row does for its bar).
 */
const usePageRows = create<{ n: number }>(() => ({ n: 0 }))

/** Finish setup, in a page header's flow (`inline`) or floating at the nudge's place; nothing while it does not apply. */
export function FinishSetup({ inline }: { inline: boolean }) {
  return useFinishSetup() ? <FinishSetupPill inline={inline} /> : null
}

/** The pill, mounted only while Finish setup applies, so who is signed in (its × is per person) is read only then. */
function FinishSetupPill({ inline }: { inline: boolean }) {
  const [hidden, hide, principal] = useNudgeHidden('finish-setup')
  // nothing until the hive says who is signed in, so a pill the person hid never shows for a moment
  const shown = !!principal && !hidden
  const covered = usePageRows((s) => s.n > 0)
  // registered before paint, so the floating copy never shows for a frame over a page that has its own row
  useLayoutEffect(() => {
    if (!inline || !shown) return
    usePageRows.setState((s) => ({ n: s.n + 1 }))
    return () => usePageRows.setState((s) => ({ n: s.n - 1 }))
  }, [inline, shown])
  if (!shown || (!inline && covered)) return null
  return (
    <NudgePill tour="finish-setup" icon="sparkles" place={inline ? 'page' : 'above'} onOpen={() => startFirstLight({ mode: 'live' })} hide={{ label: 'Hide Finish setup for me', onHide: () => hide(true) }}>
      Finish setup
    </NudgePill>
  )
}

// where the pill sits: the hive view's own place (under the HUD); the same place above pages drawn without ui/Page's
// header (z-[25]) and under sheets, menus and dialogs (z-40 and up); or in a page header's flow, beside the title on a
// wide screen and on its own row under it on a phone (as the header's actions are)
const NUDGE_PLACE = {
  hive: 'fixed top-[128px] left-3 z-10 md:top-[88px] md:left-1/2 md:-translate-x-1/2',
  above: 'fixed top-[128px] left-3 z-[26] md:top-[88px] md:left-1/2 md:-translate-x-1/2',
  page: '',
} as const

/** The nudge's pill: one tap opens what it names; `hide` adds the × that hides it for this person. */
export function NudgePill({ tour, icon, onOpen, hide, place = 'hive', children }: { tour: string; icon: IconName; onOpen: () => void; hide?: { label: string; onHide: () => void }; place?: keyof typeof NUDGE_PLACE; children: ReactNode }) {
  const pill = (
    <div className={cx('glass flex shrink-0 items-center rounded-full', NUDGE_PLACE[place])} data-tour={tour} data-place={place}>
      <button onClick={onOpen} className={cx('flex min-h-10 items-center gap-2 rounded-full pl-3.5 text-[12.5px] text-ink-2 hover:text-ink', hide ? 'pr-1' : 'pr-3.5')}>
        <Icon name={icon} size={13} className="text-accent" />
        {children}
      </button>
      {hide && (
        <button onClick={hide.onHide} aria-label={hide.label} className="flex size-10 items-center justify-center rounded-full text-ink-4 hover:text-ink">
          <Icon name="x" size={13} />
        </button>
      )}
    </div>
  )
  return place === 'page' ? <div className="order-last flex w-full px-1 md:order-none md:w-auto md:px-0">{pill}</div> : pill
}
