import { useMemo, useState } from 'react'
import { cx } from '../../lib/cx'
import { navigate } from '../../lib/router'
import { useMe } from '../../lib/useAdmin'
import { has, need, useResource } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { Button } from '../../ui/primitives'
import { doneCount, isDismissed, setDismissed, setupSteps, type SetupFacts } from './checklist'

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
              className="flex w-full items-start gap-2.5 rounded-xl border border-line bg-white/[0.02] px-3 py-2 text-left hover:border-line-2 hover:bg-white/[0.05]"
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

/** Whether the checklist is hidden for the signed-in person (and a setter that re-renders). */
export function useSetupDismissed(): [boolean, (v: boolean) => void, string | undefined] {
  const { me } = useMe()
  const principal = me?.principal
  // read per render (a cheap localStorage lookup, per person); the counter re-renders after a change here
  const [, bump] = useState(0)
  return [
    isDismissed(principal),
    (next) => {
      if (principal) setDismissed(principal, next)
      bump((n) => n + 1)
    },
    principal,
  ]
}

/** The page form (#/setup): always shown, with a way to show it on the hive again. */
export function SetupStatus() {
  const [dismissed, setDismissedState, principal] = useSetupDismissed()
  if (!principal) return null
  return (
    <p className="mt-4 text-[12.5px] text-ink-3">
      {dismissed ? 'Hidden from your hive view. ' : 'Shown on your hive view until every step is done. '}
      <Button variant="ghost" className="min-h-9 px-2 text-[12.5px]" onClick={() => setDismissedState(!dismissed)}>
        {dismissed ? 'Show it there again' : 'Hide it there'}
      </Button>
    </p>
  )
}

/**
 * Classic hive view: a small "Getting started" pill while steps remain, until the person hides it (per person). On an
 * empty hive the checklist is in the empty-hive card instead.
 */
export function SetupNudge() {
  const ready = useHive((s) => s.ready)
  const count = useHive((s) => Object.keys(s.agents).length)
  const [dismissed, setDismissedState] = useSetupDismissed()
  const { facts, ready: factsReady } = useSetupFacts()
  const steps = useMemo(() => setupSteps(facts), [facts])
  const done = doneCount(steps)
  const todo = steps.filter((s) => s.state === 'todo').length
  if (!ready || !factsReady || count === 0 || dismissed || todo === 0) return null
  return (
    <div className="glass fixed top-[128px] left-3 z-10 flex items-center rounded-full md:top-[88px] md:left-1/2 md:-translate-x-1/2" data-tour="setup-nudge">
      <button onClick={() => navigate({ name: 'setup' })} className="flex min-h-10 items-center gap-2 rounded-full pr-1 pl-3.5 text-[12.5px] text-ink-2 hover:text-ink">
        <Icon name="check" size={13} className="text-accent" />
        Getting started · {done} of {steps.length}
      </button>
      <button onClick={() => setDismissedState(true)} aria-label="Hide getting started for me" className="flex size-10 items-center justify-center rounded-full text-ink-4 hover:text-ink">
        <Icon name="x" size={13} />
      </button>
    </div>
  )
}
