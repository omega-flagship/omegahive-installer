import type { PolicyMode, PolicyRule, PolicyScope, Risk } from '../api/types'

/** The default policy from hive/API.md, used when no rule matches. */
export const DEFAULT_POLICY: { mode: PolicyMode; skills: string[]; why: string }[] = [
  {
    mode: 'allow',
    skills: ['send', 'wait', 'pin', 'hive-*', 'query', 'remember', 'episodes', 'search', 'web-search', 'read-file', 'space reads'],
    why: 'No side effects outside the agent and the hive',
  },
  {
    mode: 'ask',
    skills: ['shell', 'shell-confirm', 'metta', 'write-file*', 'append-file*', 'send-file*', 'codex-*', 'space-transform', 'remove-atom', '*-commit'],
    why: 'Side effects on the machine or on durable memory',
  },
  {
    mode: 'deny',
    skills: ['change-password', 'transfer-funds', 'pay*', 'purchase*'],
    why: 'Human-only: these always need a human to act; no rule can open them',
  },
]

export const HUMAN_ONLY = DEFAULT_POLICY[2].skills

const globCache = new Map<string, RegExp>()
export function globMatch(glob: string, name: string): boolean {
  let re = globCache.get(glob)
  if (!re) {
    re = new RegExp(`^${glob.split('').map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('')}$`)
    globCache.set(glob, re)
  }
  return re.test(name)
}

/** Literal characters in a glob: more literal = more specific. */
const specificity = (glob: string) => glob.replace(/[*?]/g, '').length

export type Decision = {
  mode: PolicyMode
  source: 'human-only' | 'agent' | 'swarm' | 'hive' | 'default' | 'unlisted'
  rule?: PolicyRule
}

/**
 * Effective mode for a skill: human-only skills are always denied; otherwise the most specific
 * scope with a matching rule wins (agent > swarm > hive), then the defaults. Within one scope the
 * most literal glob wins, then the newest rule.
 */
export function resolvePolicy(rules: PolicyRule[], who: { agentId: string; swarmId: string | null }, skill: string): Decision {
  if (HUMAN_ONLY.some((g) => globMatch(g, skill))) return { mode: 'deny', source: 'human-only' }
  const scopes: [Decision['source'], string][] = [['agent', `agent:${who.agentId}`]]
  if (who.swarmId) scopes.push(['swarm', `swarm:${who.swarmId}`])
  scopes.push(['hive', 'hive'])
  for (const [source, scope] of scopes) {
    const hits = rules.filter((r) => r.scope === scope && globMatch(r.skill, skill))
    if (hits.length) {
      hits.sort((a, b) => specificity(b.skill) - specificity(a.skill) || b.created_at.localeCompare(a.created_at))
      return { mode: hits[0].mode, source, rule: hits[0] }
    }
  }
  for (const d of DEFAULT_POLICY.slice(0, 2)) if (d.skills.some((g) => globMatch(g, skill))) return { mode: d.mode, source: 'default' }
  // API.md does not say what an unlisted skill does; the UI assumes the cautious answer.
  return { mode: 'ask', source: 'unlisted' }
}

export function scopeKind(scope: PolicyScope): 'hive' | 'swarm' | 'agent' {
  return scope === 'hive' ? 'hive' : scope.startsWith('swarm:') ? 'swarm' : 'agent'
}
export const scopeId = (scope: PolicyScope) => (scope === 'hive' ? null : scope.slice(scope.indexOf(':') + 1))

/** The risk a skill carries, for the approval chip when a server does not say. */
export function skillRisk(skill: string): Risk {
  if (/^(shell|metta|codex-)/.test(skill)) return 'high'
  if (/^(write-file|append-file|send-file|space-transform|remove-atom)|-commit$/.test(skill)) return 'medium'
  return 'low'
}

/** First symbol of a MeTTa command: `(shell-confirm "ls /")` → `shell-confirm`. */
export function commandSkill(command: string): string {
  const m = /^\s*\(\s*([^\s()]+)/.exec(command)
  return m ? m[1] : command.trim().split(/\s+/)[0] ?? ''
}
