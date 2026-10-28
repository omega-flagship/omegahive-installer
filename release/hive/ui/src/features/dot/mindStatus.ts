import type { AgentIsolation } from '../../api/types'

/** Codes a mind's own budget fixes (the Model tab); the rest are hive or rule limits (Usage). */
export const OWN_BUDGET_CODES = new Set(['no_budget', 'budget_exhausted'])

/** The tooltip: what the boundary is, in plain words. */
export function isolationText(iso: AgentIsolation): { label: string; title: string } {
  const env = iso.environment && iso.environment !== 'unknown' ? ` Environment: ${iso.environment}.` : ''
  if (iso.os_sandbox) {
    return {
      label: 'Sandboxed',
      title: `This mind's process runs inside an operating-system sandbox${iso.profile ? ` (profile ${iso.profile})` : ''}, which limits the files, network and programs it can reach.${env}`,
    }
  }
  return {
    label: 'Not sandboxed',
    title: `No operating-system sandbox was confirmed around this mind's process: it can reach what the hive's own user can, limited only by its skills and approval rules.${env}${iso.note ? ` ${iso.note}` : ''}`,
  }
}
