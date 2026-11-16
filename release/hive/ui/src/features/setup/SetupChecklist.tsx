import { useMemo } from 'react'
import { cx } from '../../lib/cx'
import { useClassicChromeHidden } from '../../experiences/classicChrome'
import { navigate } from '../../lib/router'
import { useAdminView, useMe } from '../../lib/useAdmin'
import { has, need, useResource } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { doneCount, setDismissed, setupSteps, type SetupFacts } from './checklist'
import { FinishSetup, NudgePill, useNudgeHidden } from './finishSetup'
import { useFinishSetup } from './finishSetupRule'
import { useLocalOwnerHive } from './localOwner'

/** Read everything the checklist needs from routes that already exist; each read that fails or is missing is `unknown`. */
export function useSetupFacts(): { facts: SetupFacts; principal: string | undefined; ready: boolean } {
  const client = useHive((s) => s.client)
  const swarms = useHive((s) => s.swarms)
  const hive = useHive((s) => s.hive)
  const { me, admin, loaded } = useMe()
  const opt = <T,>(fn: () => Promise<T>) => fn().catch(() => null)
  // every read here is bound to the current client (useResource); people also to who is asking (Surface K1)
  const providers = useResource(() => opt(() => need(client, 'listProviders')()), { isEmpty: () => false })
  const keys = useResource(() => opt(() => need(client, 'listKeys')()), { isEmpty: () => false })
  const budgets = useResource(() => (has(client, 'listBudgets') ? opt(() => need(client, 'listBudgets')()) : Promise.resolve(undefined)), { isEmpty: () => false })
  const people = useResource(
    () => (admin && has(client, 'listPeople') ? opt(() => need(client, 'listPeople')().then((p) => ({ people: p.people.filter((x) => x.id !== me?.person?.id).length, invites: p.invites.filter((i) => i.status === 'pending').length }))) : Promise.resolve(null)),
    { context: [me?.principal, me?.person?.id, admin], isEmpty: () => false },
  )
  const facts: SetupFacts = { admin, providers: providers.data, keys: keys.data, budgets: budgets.data, hive, swarms: Object.values(swarms), people: people.data }
  const ready = loaded && providers.status !== 'loading' && keys.status !== 'loading'
  return { facts, principal: me?.principal, ready }
}

/**
 * Getting started: five steps ticked from the hive's real state, each linking to its page. Dismissed per person
 * (in this browser); it can always be opened again from the palette, Settings or #/setup.
 */
export function SetupChecklist({ compact, onDismiss }: { compact?: boolean; onDismiss?: () => void }) {
  const { facts, principal } = useSetupFacts()
  const steps = useMemo(() => setupSteps(facts), [facts])
  const done = doneCount(steps)
  return (
    <section aria-labelledby="setup-h" data-tour="setup-checklist" className="text-left">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="setup-h" className={cx('font-display font-semibold', compact ? 'text-[15px]' : 'text-lg')}>
          Getting started
        </h2>
        <span className="text-meta text-ink-4">
          {done} of {steps.length} done
        </span>
      </div>
      <ol className="mt-2 space-y-1.5">
        {steps.map((s) => (
          <li key={s.id}>
            <button
              onClick={() => navigate(s.route)}
              data-step={s.id}
              data-state={s.state}
              className="flex w-full items-start gap-2.5 rounded-xl border border-line bg-tint/[0.02] px-3 py-2 text-left hover:border-line-2 hover:bg-tint/[0.05]"
            >
              <span className={cx('mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border', s.state === 'done' ? 'border-good/50 bg-good/15 text-good' : s.state === 'unknown' ? 'border-dashed border-line-2 text-ink-4' : 'border-line-2 text-ink-3')} aria-hidden="true">
                {s.state === 'done' ? <Icon name="check" size={12} strokeWidth={2.6} /> : s.state === 'unknown' ? '?' : <Icon name={s.icon} size={11} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cx('block text-[13px] font-medium', s.state === 'done' ? 'text-ink-2' : 'text-ink')}>
                  {s.label}
                  <span className="sr-only">{s.state === 'done' ? ' (done)' : s.state === 'unknown' ? ' (cannot tell here)' : ' (to do)'}</span>
                </span>
                {!compact && <span className="block text-meta text-ink-3">{s.why}</span>}
                <span className="block truncate text-meta text-ink-4">{s.found}</span>
              </span>
              <Icon name="chevron" size={14} className="mt-1 shrink-0 text-ink-4" />
            </button>
          </li>
        ))}
      </ol>
      {principal && onDismiss !== undefined && (
        <div className="mt-2 flex justify-end">
          <button
            className="min-h-9 rounded-lg px-2 text-[12px] text-ink-3 hover:text-ink"
            onClick={() => {
              setDismissed(principal, true)
              onDismiss()
            }}
          >
            Hide this for me
          </button>
        </div>
      )}
    </section>
  )
}

/**
 * The setup nudge, one small pill, which App mounts once, outside every experience:
 *
 * - "Finish setup" for anyone whose First Light is set aside, until their mind has been awake (./finishSetup): on every
 *   page and in every experience, in a ui/Page header's own row where there is one, floating here otherwise.
 * - otherwise, on the classic hive view, "Getting started" while steps remain, until the person hides it (per person).
 *   On an empty hive the checklist is in the empty-hive card instead. Admins only: the steps set up the hive itself
 *   (its provider, who pays, its limit), so a member never sees them, nor while the hive has not yet said who is signed
 *   in (adminViewOf), and a member's view reads none of them. Never on a hive installed on its owner's own computer,
 *   where First Light is the onboarding (useLocalOwnerHive), nor while the hive has not said which kind it is. It sits
 *   under pages and is put away with Classic's chrome (useClassicChromeHidden), as it always was.
 */
export function SetupNudge({ experience = 'classic' }: { experience?: string }) {
  const finishing = useFinishSetup()
  const adminView = useAdminView().adminView
  const chromeHidden = useClassicChromeHidden()
  if (finishing) return <FinishSetup inline={false} />
  return experience === 'classic' && !chromeHidden && adminView ? <AdminSetupNudge /> : null
}

function AdminSetupNudge() {
  const localOwner = useLocalOwnerHive()
  return localOwner === false ? <OrdinaryHiveNudge /> : null
}

function OrdinaryHiveNudge() {
  const ready = useHive((s) => s.ready)
  const count = useHive((s) => Object.keys(s.agents).length)
  const [dismissed, setDismissedState] = useNudgeHidden('setup')
  const { facts, ready: factsReady } = useSetupFacts()
  const steps = useMemo(() => setupSteps(facts), [facts])
  const done = doneCount(steps)
  const todo = steps.filter((s) => s.state === 'todo').length
  if (!ready || !factsReady || count === 0 || dismissed || todo === 0) return null
  return (
    <NudgePill tour="setup-nudge" icon="check" onOpen={() => navigate({ name: 'setup' })} hide={{ label: 'Hide getting started for me', onHide: () => setDismissedState(true) }}>
      Getting started · {done} of {steps.length}
    </NudgePill>
  )
}

