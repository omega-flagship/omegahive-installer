import { useState } from 'react'
import type { Role, RoleRule } from '../../api/types'

/** The unsaved edits to one role. The screen holding it remounts per role, so a new role starts a fresh draft. */
export function useRoleDraft(role: Role | null) {
  const [name, setName] = useState(role?.name ?? '')
  const [summary, setSummary] = useState(role?.summary ?? '')
  const [prompt, setPrompt] = useState(role?.prompt ?? '')
  const [model, setModel] = useState(role?.default_model ?? '')
  const [budget, setBudget] = useState(role?.default_budget == null ? '' : String(role.default_budget))
  const [rules, setRules] = useState<RoleRule[]>(role?.rules ?? [])
  const dirty =
    role !== null &&
    (name !== role.name || summary !== role.summary || prompt !== role.prompt || (model || null) !== role.default_model ||
      (budget === '' ? null : Number(budget)) !== role.default_budget || JSON.stringify(rules) !== JSON.stringify(role.rules))
  return { name, setName, summary, setSummary, prompt, setPrompt, model, setModel, budget, setBudget, rules, setRules, dirty }
}
export type RoleDraft = ReturnType<typeof useRoleDraft>
