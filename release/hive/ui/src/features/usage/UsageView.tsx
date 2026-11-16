// Purpose: the Usage page, a screen MeTTa composes (usage.metta): the person's month, the held calls and estimates, the spending limits, and spend and tokens over time by mind or model. This file loads the lists and keeps them current, states their facts (usageScreen.ts, heldCallsScreen.ts, limitsScreen.ts), draws the plan and carries out its presses, and hosts the money decisions and the confirmation a removal asks for.
import { AnimatePresence } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import type { EstimatedCall } from '../../api/moneyWork'
import { experienceById } from '../../experiences/registry'
import { modelLabel, money } from '../../lib/format'
import { useNow } from '../../lib/hooks'
import { navigate } from '../../lib/router'
import { useSim } from '../../lib/sim'
import { actionFailure, has, need, useResource } from '../../lib/useResource'
import { Screen, type ScreenItem } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { useLook } from '../../shell/uiVariant'
import { hiveBus, useHive } from '../../store/store'
import { askConfirm, ConfirmHost } from '../../ui/confirm'
import { Page } from '../../ui/Page'
import { PlanUsage } from '../plans/PlanUsage'
import { CorrectAllDialog, CorrectDialog } from './EstimateDialogs'
import { seenEstimate, useNamer } from './estimates'
import { correctable, heldCallsScreen } from './heldCallsScreen'
import { HIVE_EDITOR, limitDraft, limitsScreen, limitToSave, oldDefaultsById, PERIOD, whoOf, type AddingCap } from './limitsScreen'
import { readLimitsView, type OldDefault } from './limitsView'
import { joinScreens, mySpendScreen, RANGES, spendScreen, type Group, type Range, type View } from './usageScreen'

/** Only what a person types into a dollar field: digits and a decimal point. */
const dollars = (v: string) => v.replace(/[^\d.]/g, '')

export default function UsageView() {
  const client = useHive((s) => s.client)
  const usage = useHive((s) => s.usage)
  const agents = useHive((s) => s.agents)
  const models = useHive((s) => s.models)
  const swarms = useHive((s) => s.swarms)
  const keys = useHive((s) => s.keys)
  const toast = useHive((s) => s.toast)
  const sim = useSim()
  const now = useNow(30_000)
  const look = experienceById(useLook().current?.experience).id
  const compose = useCompose(look)
  const namer = useNamer()

  // the person's own month
  const mine = useResource(() => need(client, 'usageMe', 'Your spend')(), { poll: 30000 })
  // the held calls, the estimates and the overruns; budget.overrun (audit drift) and budget.estimated (an expiry pass)
  // are read at once instead of at the next poll
  const held = useResource(() => need(client, 'listReservations', 'Held costs')(), { poll: 15_000, isEmpty: () => false })
  const over = useResource(() => need(client, 'listOverruns', 'Overruns')(), { poll: 60_000 })
  const est = useResource(() => need(client, 'listEstimated', 'Estimated calls')(), { poll: 60_000, isEmpty: () => false })
  const reloads = useRef([over.reload, held.reload, est.reload])
  useEffect(() => {
    reloads.current = [over.reload, held.reload, est.reload]
  })
  useEffect(() => hiveBus.on((e) => { if (e.type === 'budget.overrun' || e.type === 'budget.estimated') reloads.current.forEach((r) => r()) }), [])
  // the spending limits: a failed load, or an answer this page can't read, is an error with a retry, never "no limits"
  const limits = useResource(() => need(client, 'budgetLimitsView', 'Spending limits')().then((v) => {
    const view = readLimitsView(v)
    if (!view) throw new Error('The hive answered in a shape this page does not understand.')
    return view
  }), { isEmpty: () => false })
  // the spend over time: the last 30 days read once, merged with what the store already holds live
  const [spendState, setSpendState] = useState<'loading' | 'ready' | 'error'>(usage.length ? 'ready' : 'loading')
  const [spendError, setSpendError] = useState<unknown>(undefined)
  useEffect(() => {
    if (!client) return
    const since = new Date(Date.now() - RANGES['30d'].ms).toISOString()
    client.listUsage({ since }).then(
      (list) => {
        useHive.setState((s) => {
          const seen = new Set(list.map((u) => `${u.agent_id}|${u.created_at}|${u.cost_usd}`))
          const live = s.usage.filter((u) => !seen.has(`${u.agent_id}|${u.created_at}|${u.cost_usd}`))
          return { usage: [...list, ...live].sort((a, b) => a.created_at.localeCompare(b.created_at)) }
        })
        setSpendState('ready')
      },
      (e: unknown) => {
        setSpendError(e instanceof Error ? e : new Error('Could not load usage'))
        setSpendState('error')
      },
    )
  }, [client])

  const [range, setRange] = useState<Range>('7d')
  const [group, setGroup] = useState<Group>('agent')
  const [view, setView] = useState<View>('chart')
  const [inFlightOpen, setInFlightOpen] = useState(false)
  const [fixing, setFixing] = useState<EstimatedCall | null>(null)
  const [fixAll, setFixAll] = useState<EstimatedCall[] | null>(null)
  // the limit editors open now, by row id, with what is typed in each; and the Add a cap form while it is open
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [adding, setAdding] = useState<AddingCap | null>(null)

  const canSet = has(client, 'setBudget')
  const canRemove = has(client, 'removeBudget')
  const estimates = est.status === 'ready' ? est.data : undefined
  // a hive without a held list says so at once, rather than loading one it cannot read
  const heldList = has(client, 'listReservations') ? held : { status: 'unsupported' as const, error: undefined }
  const names = { swarms, agents, keys: keys ?? [] }
  const lim = limitsScreen(limits, { view: limits.data, names, canSet, canRemove, canPatchAgent: has(client, 'patchAgent'), drafts, adding }, compose)
  const nameOf = (k: string) => (group === 'agent' ? (agents[k]?.name ?? k) : (models.find((m) => m.id === k)?.label ?? modelLabel(k)))
  const screen = joinScreens(
    mySpendScreen(mine),
    heldCallsScreen(heldList, estimates, over.data, namer, now, inFlightOpen),
    lim,
    spendScreen({ status: spendState, error: spendError }, { usage, range, group, view, now, name: nameOf, mind: (id) => agents[id], sim }),
  )
  // composing runs MeTTa; the composer keeps each answer, so it runs again only when a count, a flag, a state or the look
  // changes, and the words and rows are data, filled at draw time
  const plan = compose('usage', screen.facts)

  const save = async (scope: string, period: string, limit: number, label: string) => {
    try {
      await need(client, 'setBudget', 'Setting limits')({ scope, period, limit_usd: limit })
      limits.reload()
      toast({ tone: 'success', icon: 'coin', title: 'Limit saved', body: `${label}: ${money(limit)} ${PERIOD[period] ?? ''}`.trim() })
    } catch (e) {
      toast(actionFailure(e, 'Could not save the limit'))
    }
  }
  const closeEditor = (id: string) => setDrafts(({ [id]: _closed, ...rest }) => rest)
  // an editor saves what was typed when it differs from the figure it started from, and closes either way
  const saveDraft = async (id: string) => {
    const a = lim.actions[id]
    const draft = drafts[id]
    closeEditor(id)
    const n = draft === undefined ? null : limitToSave(draft, a?.current ?? null)
    if (a?.save && n !== null) await save(a.save.scope, a.save.period, n, a.save.label)
  }
  const removeRow = async (id: string) => {
    const r = lim.actions[id]?.remove
    if (!r?.row.rule_id) return
    const ok = await askConfirm(`Remove the ${money(r.row.limit_usd)} ${PERIOD[r.row.period] ?? ''} limit on ${r.label}? ${r.after}`, 'Remove limit', { danger: true })
    if (!ok) return
    try {
      await need(client, 'removeBudget', 'Removing limits')(r.row.rule_id)
      limits.reload()
      toast({ tone: 'success', icon: 'coin', title: 'Limit removed', body: `${r.label}: ${money(r.row.limit_usd)} ${PERIOD[r.row.period] ?? ''}`.trim() })
    } catch (e) {
      toast(actionFailure(e, 'Could not remove the limit'))
    }
  }
  // the old form defaults go in one action: one confirmation that lists every change, then each removal in turn; a
  // removal that fails is named and the rest still go
  const removeOld = async (items: OldDefault[]) => {
    if (items.length === 0) return
    const ok = await askConfirm(
      `${items.length === 1 ? 'Remove this old default?' : `Remove these ${items.length} old defaults?`} ${items.map((i) => i.change).join('; ')}.`,
      items.length === 1 ? 'Remove it' : `Remove all ${items.length}`,
      { danger: true },
    )
    if (!ok) return
    const failed: string[] = []
    for (const item of items) {
      try {
        if (item.reset.kind === 'mind') await need(client, 'patchAgent', 'Changing a mind')(item.reset.agent_id, { budget_usd: 0 })
        else await need(client, 'removeBudget', 'Removing limits')(item.reset.rule_id)
      } catch {
        failed.push(item.name)
      }
    }
    limits.reload()
    if (failed.length) toast({ tone: 'error', icon: 'coin', title: 'Some old defaults stayed', body: `Could not remove: ${failed.join(', ')}. The others are gone.` })
    else toast({ tone: 'success', icon: 'coin', title: items.length === 1 ? 'Old default removed' : `${items.length} old defaults removed`, body: 'The hive cap and each payer’s allowance hold that spending now.' })
  }
  // a new cap needs what it applies to and a figure someone typed; every mind's is a month's
  const addCap = async () => {
    if (!adding || !adding.scope) return
    const n = Number(adding.limit)
    if (adding.limit.trim() === '' || !Number.isFinite(n) || n < 0) return
    await save(adding.scope, adding.scope === 'every-mind' ? 'month' : adding.period, n, whoOf(adding.scope, limits.data?.people ?? [], names).label)
    setAdding(null)
  }
  // the held calls sit above the limits on this page
  const seeHeld = () => document.querySelector('[data-tour="held-calls"]')?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })

  const onInput = (bind: string, value: string, scope?: string[]) => {
    if (bind === 'spend.range') { if (value in RANGES) setRange(value as Range) }
    else if (bind === 'spend.group') { if (value === 'agent' || value === 'model') setGroup(value) }
    else if (bind === 'spend.view') { if (value === 'chart' || value === 'table') setView(value) }
    else if (bind === 'limit.draft' && scope?.[0]) setDrafts((d) => ({ ...d, [scope[0]]: dollars(value) }))
    else if (bind === 'limits.hive.draft') setDrafts((d) => ({ ...d, [HIVE_EDITOR]: dollars(value) }))
    else if (bind === 'limits.add.scope') setAdding((a) => a && { ...a, scope: value })
    else if (bind === 'limits.add.period') setAdding((a) => a && { ...a, period: value })
    else if (bind === 'limits.add.limit') setAdding((a) => a && { ...a, limit: dollars(value) })
  }
  const onAction = (action: string, item: ScreenItem) => {
    // a press inside a limit's row comes with that row's id first in its scope
    const row = Array.isArray(item.scope) && typeof item.scope[0] === 'string' ? item.scope[0] : ''
    if (action === 'reload-held') held.reload()
    else if (action === 'toggle-in-flight') setInFlightOpen((o) => !o)
    else if (action === 'correct-all') setFixAll(correctable(estimates, now).map(seenEstimate))
    else if (action === 'add-key') navigate({ name: 'me' })
    else if (action === 'ask-more') navigate({ name: 'approvals' })
    else if (action === 'add-cap') setAdding({ scope: Object.keys(swarms)[0] ? `swarm:${Object.keys(swarms)[0]}` : 'every-mind', period: 'month', limit: '10' })
    else if (action === 'add-cancel') setAdding(null)
    else if (action === 'add-save') void addCap()
    else if (action === 'reload-limits') limits.reload()
    else if (action === 'set-hive') setDrafts((d) => ({ ...d, [HIVE_EDITOR]: '' }))
    else if (action === 'save-hive') void saveDraft(HIVE_EDITOR)
    else if (action === 'edit' && lim.actions[row]?.save) {
      const current = lim.actions[row].current
      setDrafts((d) => ({ ...d, [row]: current === null ? '' : limitDraft(current) }))
    }
    else if (action === 'save' && row) void saveDraft(row)
    else if (action === 'remove' && row) void removeRow(row)
    else if (action === 'see-held') seeHeld()
    else if (action === 'remove-old') void removeOld(limits.data?.old_defaults ?? [])
  }
  const onOpen = (target: string, item: ScreenItem) => {
    if (target === 'correct') {
      const e = est.data?.find((x) => x.id === item.id)
      if (e) setFixing(seenEstimate(e))
    } else if (target === 'remove-old-one') {
      const o = oldDefaultsById(limits.data)[String(item.id)]
      if (o) void removeOld([o])
    }
  }

  return (
    <Page label="Usage" eyebrow="Spend & tokens" title="Usage" onClose={() => navigate({ name: 'hive' })}>
      <div className="px-3 pb-28 md:px-6 md:pb-8">
        <Screen plan={plan} host={{ data: screen.data, onInput, onAction, onOpen, islands: { 'plan-usage': <PlanUsage /> } }} />
      </div>
      <AnimatePresence>
        {fixing && <CorrectDialog seen={fixing} live={est.data?.find((e) => e.id === fixing.id)} onClose={() => setFixing(null)} onDone={est.reload} />}
        {fixAll && <CorrectAllDialog seen={fixAll} live={est.data} onClose={() => setFixAll(null)} onDone={est.reload} />}
      </AnimatePresence>
      <ConfirmHost />
    </Page>
  )
}
