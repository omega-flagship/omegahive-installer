import type { AssertionOutcome } from '../../api/types'
import type { IconName } from '../../ui/Icon'

export const OUTCOME: Record<AssertionOutcome, { label: string; icon: IconName; color: string; hint: string }> = {
  adopted: { label: 'Adopted', icon: 'sparkles', color: '#5eead4', hint: 'First evidence for this statement.' },
  revised: { label: 'Revised', icon: 'wave', color: '#7cb6ff', hint: 'Independent evidence, pooled by NAL revision.' },
  chosen: { label: 'Chosen', icon: 'check', color: '#f5c06b', hint: 'Overlapping evidence; won the choice on confidence.' },
  kept: { label: 'Kept prior', icon: 'shield', color: '#c4b5fd', hint: 'Overlapping evidence; the existing belief was kept.' },
  duplicate: { label: 'Duplicate', icon: 'copy', color: '#9ca3af', hint: 'Evidence already counted.' },
  quarantined: { label: 'Quarantined', icon: 'alert', color: '#fbbf24', hint: 'Held back: outside the swarm vocabulary or untrusted.' },
  denied: { label: 'Denied', icon: 'x', color: '#fb7185', hint: 'Not allowed to publish here.' },
}
