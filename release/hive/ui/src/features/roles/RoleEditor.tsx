import { AnimatePresence, m } from 'framer-motion'
import { useMemo, useRef, useState } from 'react'
import type { Role } from '../../api/types'
import { hsl } from '../../lib/color'
import { navigate } from '../../lib/router'
import { actionFailure, has, need } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { Button, Segmented } from '../../ui/primitives'
import { ModelPicker } from '../models/ModelPicker'
import { buildRows } from '../models/modelUtil'
import { shown } from '../../lib/displayName'
import { hueOf, renderRole } from './data'
import type { RoleDraft } from './useRoleDraft'

/**
 * The role editor: an island the role screen places (roles.metta: `island` parts role.form and role.commands). It stays
 * a hand-drawn form because it inserts placeholders at the caret, previews the prompt as a mind reads it, picks a model
 * from the catalogue, edits a list of rules each with its own mode, tracks unsaved changes and asks before removing.
 * The two islands share one draft, held by the screen that places them.
 */

const SKILL_HINTS = ['web-search', 'shell*', 'write-file*', 'metta', 'remember', 'hive-publish', 'hive-goal-create', 'code-edit', 'code-run', 'codex-*']
const PLACEHOLDERS = [
  { token: '{name}', label: "the mind's name" },
  { token: '{swarm}', label: 'its swarm' },
  { token: '{purpose}', label: "its swarm's purpose" },
]


/** The role's name, summary, prompt (with its preview), defaults for new minds, and approval rules. */
export function RoleFormIsland({ role, draft }: { role: Role; draft: RoleDraft }) {
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const models = useHive((s) => s.models)
  const catalog = useHive((s) => s.catalog)
  const { name, setName, summary, setSummary, prompt, setPrompt, model, setModel, budget, setBudget, rules, setRules } = draft
  const [pickModel, setPickModel] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const minds = role.minds.map((id) => agents[id]).filter(Boolean)
  const example = minds[0] ?? null
  const exampleSwarm = example?.swarm_id ? swarms[example.swarm_id] : Object.values(swarms)[0]
  const rows = useMemo(() => buildRows(models, catalog?.models), [models, catalog])

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

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-line bg-tint/[0.03] p-4" style={{ boxShadow: `0 24px 60px -36px ${hsl(hueOf(role.name), 100, 60, 0.7)}` }}>
        <div className="grid gap-2 md:grid-cols-[1fr_1.4fr]">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} aria-label="Role name" className="min-h-11 rounded-xl border border-line bg-shade/25 px-3 font-display text-lg text-ink outline-none focus:border-line-2" />
          <input value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={120} placeholder="One line: what this role is for" aria-label="Summary" className="min-h-11 rounded-xl border border-line bg-shade/25 px-3 text-[14px] text-ink-2 outline-none placeholder:text-ink-4 focus:border-line-2" />
        </div>

        <div className="mt-4 flex items-baseline justify-between gap-2">
          <span className="eyebrow">Prompt</span>
          <span className="flex flex-wrap gap-1">
            {PLACEHOLDERS.map((p) => (
              <button key={p.token} onClick={() => insert(p.token)} title={`Insert ${p.label}`} className="rounded-md border border-line bg-tint/[0.04] px-1.5 py-0.5 font-mono text-[11px] text-ink-3 hover:border-line-2 hover:text-ink">
                {p.token}
              </button>
            ))}
          </span>
        </div>
        <textarea ref={area} value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={7} maxLength={6000} aria-label="Prompt" className="thin-scroll mt-2 w-full resize-y rounded-xl border border-line bg-shade/25 p-3 font-mono text-[13px] leading-relaxed text-ink outline-none focus:border-line-2" />
        <div className="mt-2 rounded-xl border border-dashed border-line px-3 py-2">
          <div className="text-[11px] text-ink-4">As {example?.name ?? 'Vega'} reads it{exampleSwarm ? ` in ${exampleSwarm.name}` : ''}</div>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{renderRole(prompt, example?.name ?? 'Vega', exampleSwarm?.name ?? '', exampleSwarm?.description ?? '')}</p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-line bg-tint/[0.03] p-4">
          <span className="eyebrow">Defaults for new minds</span>
          <button onClick={() => setPickModel(!pickModel)} className="mt-3 flex w-full items-center gap-2 rounded-xl border border-line bg-shade/20 px-3 py-2 text-left text-[13px] hover:border-line-2">
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
            <span className="flex items-center rounded-lg border border-line bg-shade/25 px-2">
              <span className="text-ink-3">$</span>
              <input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^\d.]/g, ''))} placeholder="none" aria-label="Default budget" className="min-h-9 w-16 bg-transparent px-1 font-mono text-ink outline-none placeholder:text-ink-4" />
            </span>
          </label>
          <p className="mt-2 text-[11.5px] text-ink-4">Used when a mind is created with this role; each mind can change its own afterwards.</p>
        </div>

        <div className="rounded-2xl border border-line bg-tint/[0.03] p-4">
          <span className="eyebrow">Must ask, or may not</span>
          <div className="mt-3 space-y-1.5">
            {rules.length === 0 && <p className="text-[12.5px] text-ink-3">No extra rules: the hive's defaults apply (risky skills already ask).</p>}
            {rules.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <input value={r.skill} onChange={(e) => setRules((l) => l.map((x, j) => (j === i ? { ...x, skill: e.target.value } : x)))} aria-label="Skill" list="role-skill-hints" className="min-h-9 min-w-0 flex-1 rounded-lg border border-line bg-shade/25 px-2 font-mono text-[12.5px] text-ink outline-none focus:border-line-2" />
                <Segmented value={r.mode} onChange={(mode) => setRules((l) => l.map((x, j) => (j === i ? { ...x, mode } : x)))} label={`Mode for ${r.skill}`} dense options={[{ value: 'allow', label: 'Allow' }, { value: 'ask', label: 'Ask' }, { value: 'deny', label: 'Deny' }]} />
                <button onClick={() => setRules((l) => l.filter((_, j) => j !== i))} aria-label="Remove rule" className="flex size-8 items-center justify-center rounded-lg text-ink-4 hover:bg-tint/[0.06] hover:text-ink">
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
    </div>
  )
}

/** Save (which reaches every mind with the role), Duplicate, and Remove after a second press. */
export function RoleCommandsIsland({ role, draft, mindCount }: { role: Role; draft: RoleDraft; mindCount: number }) {
  const client = useHive((s) => s.client)
  const loadRoles = useHive((s) => s.loadRoles)
  const toast = useHive((s) => s.toast)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const { name, summary, prompt, model, budget, rules, dirty } = draft

  const save = async () => {
    setBusy(true)
    try {
      await need(client, 'updateRole', 'Saving roles')(role.id, { name: name.trim(), summary, prompt, default_model: model || null, default_budget: budget === '' ? null : Number(budget), rules })
      await loadRoles()
      toast({ tone: 'success', icon: 'check', title: `${name.trim()} saved`, body: mindCount ? `${mindCount} mind${mindCount === 1 ? '' : 's'} updated from their next turn.` : undefined })
    } catch (e) {
      toast(actionFailure(e, 'Could not save the role'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="primary" icon="check" disabled={!has(client, 'updateRole') || !dirty || busy || !name.trim() || !prompt.trim()} onClick={() => void save()}>
        {busy ? 'Saving…' : mindCount ? `Save and update ${mindCount} mind${mindCount === 1 ? '' : 's'}` : 'Save'}
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
  )
}
