import { AnimatePresence, m } from 'framer-motion'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Role, RoleRule } from '../../api/types'
import { hsl } from '../../lib/color'
import { cx } from '../../lib/cx'
import { money } from '../../lib/format'
import { navigate, useRoute } from '../../lib/router'
import { actionFailure, has, need, type ResourceState } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { Page } from '../../ui/Page'
import { Button, EmptyState, Orb, Segmented, Skeleton } from '../../ui/primitives'
import { ResourceView } from '../../ui/ResourceView'
import { ModelPicker } from '../models/ModelPicker'
import { buildRows } from '../models/modelUtil'
import { shown } from '../../lib/displayName'

const SKILL_HINTS = ['web-search', 'shell*', 'write-file*', 'metta', 'remember', 'hive-publish', 'hive-goal-create', 'code-edit', 'code-run', 'codex-*']
const PLACEHOLDERS = [
  { token: '{name}', label: "the mind's name" },
  { token: '{swarm}', label: 'its swarm' },
  { token: '{purpose}', label: "its swarm's purpose" },
]

export const renderRole = (prompt: string, name: string, swarm: string, purpose: string) =>
  prompt.replace(/\{(name|swarm|purpose)\}/g, (_, k: string) => (k === 'name' ? name : k === 'swarm' ? swarm || 'this hive' : purpose))

/** #/roles: the role library. A role sets a mind's prompt, defaults and approval rules; edits reach every mind that has it. */
export default function RolesPage() {
  const route = useRoute()
  const roles = useHive((s) => s.roles)
  const rolesState = useHive((s) => s.rolesState)
  const rolesError = useHive((s) => s.rolesError)
  const loadRoles = useHive((s) => s.loadRoles)
  const client = useHive((s) => s.client)
  const toast = useHive((s) => s.toast)
  const selected = route.name === 'roles' ? route.id : undefined
  useEffect(() => {
    void loadRoles().catch(() => undefined)
  }, [loadRoles, client])
  const current = roles?.find((r) => r.id === selected) ?? null
  const res: ResourceState<Role[]> & { reload: () => void } = {
    status: rolesState === 'unsupported' ? 'unsupported' : rolesState === 'error' ? 'error' : rolesState === 'ready' && roles ? (roles.length ? 'ready' : 'empty') : 'loading',
    data: roles ?? undefined,
    error: rolesError,
    refreshing: false,
    reload: () => void loadRoles().catch(() => undefined),
  }

  const create = async () => {
    try {
      const r = await need(client, 'createRole', 'Creating roles')({ name: `New role ${(roles?.length ?? 0) + 1}`, summary: '', prompt: 'You are {name}, a member of {swarm}. ' })
      await loadRoles()
      navigate({ name: 'roles', id: r.id })
    } catch (e) {
      toast(actionFailure(e, 'Could not create the role'))
    }
  }

  return (
    <Page
      title="Roles"
      eyebrow="What shapes a mind"
      label="Roles"
      onClose={() => navigate({ name: 'hive' })}
      actions={
        has(client, 'createRole') && (
          <Button variant="primary" icon="plus" onClick={() => void create()} className="mr-1">
            New role
          </Button>
        )
      }
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 pt-2 pb-12 md:flex-row md:px-6">
        <aside className="md:w-72 md:shrink-0">
          <ResourceView
            res={res}
            loading={<Skeleton className="h-64" />}
            errorTitle="Could not load roles"
            forbidden={{ icon: 'shield', title: 'Admins only', body: 'Ask an admin of this hive to change roles.' }}
            unsupported={{ body: 'This hive or the demo does not have a role library.' }}
            empty={{ icon: 'user', title: 'No roles yet', body: has(client, 'createRole') ? 'Create one with New role.' : undefined }}
          >
            {(list) => (
            <div className="overflow-hidden rounded-2xl border border-line">
              {list.map((r, i) => (
                <button key={r.id} onClick={() => navigate({ name: 'roles', id: r.id })} className={cx('flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors', i > 0 && 'border-t border-line', r.id === selected ? 'bg-white/[0.08]' : 'hover:bg-white/[0.04]')}>
                  <span className="mt-1 size-2.5 shrink-0 rounded-full" style={{ background: hsl(hueOf(r.name), 90, 68), boxShadow: `0 0 8px ${hsl(hueOf(r.name), 100, 65, 0.6)}` }} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[13.5px] text-ink">{shown(r.name)}</span>
                      {r.builtin && <span className="text-[10px] text-ink-4">built in</span>}
                    </span>
                    <span className="block truncate text-[11.5px] text-ink-4">{r.summary || 'No summary'}</span>
                  </span>
                  {r.minds.length > 0 && <span className="mt-0.5 font-mono text-[11px] text-ink-3">{r.minds.length}</span>}
                </button>
              ))}
            </div>
            )}
          </ResourceView>
        </aside>
        <section className="min-w-0 flex-1">
          {current ? (
            <RoleEditor key={current.id} role={current} />
          ) : (
            <EmptyState icon="user" title="Pick a role" body="A role sets a mind's prompt, its default model and budget, and what it must ask before doing. Edit a role and every mind that has it follows." />
          )}
        </section>
      </div>
    </Page>
  )
}

const hueOf = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 11)

function RoleEditor({ role }: { role: Role }) {
  const client = useHive((s) => s.client)
  const loadRoles = useHive((s) => s.loadRoles)
  const toast = useHive((s) => s.toast)
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const models = useHive((s) => s.models)
  const catalog = useHive((s) => s.catalog)
  const [name, setName] = useState(role.name)
  const [summary, setSummary] = useState(role.summary)
  const [prompt, setPrompt] = useState(role.prompt)
  const [model, setModel] = useState(role.default_model ?? '')
  const [budget, setBudget] = useState(role.default_budget == null ? '' : String(role.default_budget))
  const [rules, setRules] = useState<RoleRule[]>(role.rules)
  const [pickModel, setPickModel] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const minds = role.minds.map((id) => agents[id]).filter(Boolean)
  const example = minds[0] ?? null
  const exampleSwarm = example?.swarm_id ? swarms[example.swarm_id] : Object.values(swarms)[0]
  const rows = useMemo(() => buildRows(models, catalog?.models), [models, catalog])
  const dirty =
    name !== role.name || summary !== role.summary || prompt !== role.prompt || (model || null) !== role.default_model ||
    (budget === '' ? null : Number(budget)) !== role.default_budget || JSON.stringify(rules) !== JSON.stringify(role.rules)

  const insert = (token: string) => {
    const el = area.current
    if (!el) return setPrompt((p) => p + token)
    const [a, b] = [el.selectionStart, el.selectionEnd]
    setPrompt((p) => p.slice(0, a) + token + p.slice(b))
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(a + token.length, a + token.length)
    })
  }

  const save = async () => {
    setBusy(true)
    try {
      await need(client, 'updateRole', 'Saving roles')(role.id, { name: name.trim(), summary, prompt, default_model: model || null, default_budget: budget === '' ? null : Number(budget), rules })
      await loadRoles()
      toast({ tone: 'success', icon: 'check', title: `${name.trim()} saved`, body: minds.length ? `${minds.length} mind${minds.length === 1 ? '' : 's'} updated from their next turn.` : undefined })
    } catch (e) {
      toast(actionFailure(e, 'Could not save the role'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-line bg-white/[0.03] p-4" style={{ boxShadow: `0 24px 60px -36px ${hsl(hueOf(role.name), 100, 60, 0.7)}` }}>
        <div className="grid gap-2 md:grid-cols-[1fr_1.4fr]">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} aria-label="Role name" className="min-h-11 rounded-xl border border-line bg-black/25 px-3 font-display text-lg text-ink outline-none focus:border-line-2" />
          <input value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={120} placeholder="One line: what this role is for" aria-label="Summary" className="min-h-11 rounded-xl border border-line bg-black/25 px-3 text-[14px] text-ink-2 outline-none placeholder:text-ink-4 focus:border-line-2" />
        </div>

        <div className="mt-4 flex items-baseline justify-between gap-2">
          <span className="eyebrow">Prompt</span>
          <span className="flex flex-wrap gap-1">
            {PLACEHOLDERS.map((p) => (
              <button key={p.token} onClick={() => insert(p.token)} title={`Insert ${p.label}`} className="rounded-md border border-line bg-white/[0.04] px-1.5 py-0.5 font-mono text-[11px] text-ink-3 hover:border-line-2 hover:text-ink">
                {p.token}
              </button>
            ))}
          </span>
        </div>
        <textarea ref={area} value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={7} maxLength={6000} aria-label="Prompt" className="thin-scroll mt-2 w-full resize-y rounded-xl border border-line bg-black/25 p-3 font-mono text-[13px] leading-relaxed text-ink outline-none focus:border-line-2" />
        <div className="mt-2 rounded-xl border border-dashed border-line px-3 py-2">
          <div className="text-[11px] text-ink-4">As {example?.name ?? 'Vega'} reads it{exampleSwarm ? ` in ${exampleSwarm.name}` : ''}</div>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{renderRole(prompt, example?.name ?? 'Vega', exampleSwarm?.name ?? '', exampleSwarm?.description ?? '')}</p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-line bg-white/[0.03] p-4">
          <span className="eyebrow">Defaults for new minds</span>
          <button onClick={() => setPickModel(!pickModel)} className="mt-3 flex w-full items-center gap-2 rounded-xl border border-line bg-black/20 px-3 py-2 text-left text-[13px] hover:border-line-2">
            <Icon name="cpu" size={14} className="text-ink-3" />
            <span className="min-w-0 flex-1 truncate text-ink-2">{model ? (rows.find((r) => r.id === model)?.name ?? model) : 'No default model (the hive default)'}</span>
            <span className="text-[11.5px] text-ink-4">{pickModel ? 'Done' : 'Change'}</span>
          </button>
          <AnimatePresence initial={false}>
            {pickModel && (
              <m.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="mt-3 overflow-hidden">
                <ModelPicker value={model} hue={hueOf(role.name)} onChange={(mdl) => setModel(mdl)} />
                {model && (
                  <button onClick={() => setModel('')} className="mt-2 text-[12px] text-ink-3 hover:text-ink">
                    Clear the default model
                  </button>
                )}
              </m.div>
            )}
          </AnimatePresence>
          <label className="mt-3 flex items-center gap-2 text-[13px] text-ink-2">
            Budget cap
            <span className="flex items-center rounded-lg border border-line bg-black/25 px-2">
              <span className="text-ink-3">$</span>
              <input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^\d.]/g, ''))} placeholder="none" aria-label="Default budget" className="min-h-9 w-16 bg-transparent px-1 font-mono text-ink outline-none placeholder:text-ink-4" />
            </span>
          </label>
          <p className="mt-2 text-[11.5px] text-ink-4">Used when a mind is created with this role; each mind can change its own afterwards.</p>
        </div>

        <div className="rounded-2xl border border-line bg-white/[0.03] p-4">
          <span className="eyebrow">Must ask, or may not</span>
          <div className="mt-3 space-y-1.5">
            {rules.length === 0 && <p className="text-[12.5px] text-ink-3">No extra rules: the hive's defaults apply (risky skills already ask).</p>}
            {rules.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <input value={r.skill} onChange={(e) => setRules((l) => l.map((x, j) => (j === i ? { ...x, skill: e.target.value } : x)))} aria-label="Skill" list="role-skill-hints" className="min-h-9 min-w-0 flex-1 rounded-lg border border-line bg-black/25 px-2 font-mono text-[12.5px] text-ink outline-none focus:border-line-2" />
                <Segmented value={r.mode} onChange={(mode) => setRules((l) => l.map((x, j) => (j === i ? { ...x, mode } : x)))} label={`Mode for ${r.skill}`} dense options={[{ value: 'allow', label: 'Allow' }, { value: 'ask', label: 'Ask' }, { value: 'deny', label: 'Deny' }]} />
                <button onClick={() => setRules((l) => l.filter((_, j) => j !== i))} aria-label="Remove rule" className="flex size-8 items-center justify-center rounded-lg text-ink-4 hover:bg-white/[0.06] hover:text-ink">
                  <Icon name="x" size={13} />
                </button>
              </div>
            ))}
            <datalist id="role-skill-hints">
              {SKILL_HINTS.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
            <Button variant="ghost" icon="plus" className="min-h-9 px-2.5 text-[12.5px]" onClick={() => setRules((l) => [...l, { skill: '', mode: 'ask' }])}>
              Add a rule
            </Button>
          </div>
          <p className="mt-2 text-[11.5px] text-ink-4">Applied to every mind with this role. Human-only actions (money, passwords) stay refused whatever a role says.</p>
        </div>
      </div>

      <div className="rounded-2xl border border-line bg-white/[0.03] p-4">
        <span className="eyebrow">Minds with this role</span>
        <div className="mt-3 flex flex-wrap gap-2">
          {minds.length === 0 && <span className="text-[12.5px] text-ink-3">None yet. Pick it when you create a mind or start a swarm.</span>}
          {minds.map((a) => (
            <button key={a.id} onClick={() => navigate({ name: 'dot', id: a.id, tab: 'model' })} className="flex min-h-9 items-center gap-1.5 rounded-full border border-line px-2.5 text-[12.5px] text-ink-2 hover:border-line-2">
              <Orb hue={a.hue} status={a.status} size={16} /> {shown(a.name)}
              <span className="text-ink-4">· {money(a.spent_usd)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" icon="check" disabled={!has(client, 'updateRole') || !dirty || busy || !name.trim() || !prompt.trim()} onClick={() => void save()}>
          {busy ? 'Saving…' : minds.length ? `Save and update ${minds.length} mind${minds.length === 1 ? '' : 's'}` : 'Save'}
        </Button>
        <Button
          variant="subtle"
          icon="copy"
          disabled={!has(client, 'duplicateRole')}
          onClick={async () => {
            try {
              const r = await need(client, 'duplicateRole', 'Duplicating roles')(role.id)
              await loadRoles()
              navigate({ name: 'roles', id: r.id })
            } catch (e) {
              toast(actionFailure(e, 'Could not duplicate the role'))
            }
          }}
        >
          Duplicate
        </Button>
        <div className="flex-1" />
        {!has(client, 'removeRole') ? null : confirmDelete ? (
          <>
            <Button
              variant="danger"
              onClick={async () => {
                try {
                  const r = await need(client, 'removeRole', 'Removing roles')(role.id)
                  await loadRoles()
                  toast({ tone: 'success', title: 'Role removed', body: r.unassigned ? `${r.unassigned} mind${r.unassigned === 1 ? '' : 's'} keep their own instructions.` : undefined })
                  navigate({ name: 'roles' })
                } catch (e) {
                  setConfirmDelete(false)
                  toast(actionFailure(e, 'Could not remove the role'))
                }
              }}
            >
              Remove {shown(role.name)}
            </Button>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Keep
            </Button>
          </>
        ) : (
          <Button variant="ghost" className="text-ink-3" onClick={() => setConfirmDelete(true)}>
            Remove
          </Button>
        )}
      </div>
    </div>
  )
}
