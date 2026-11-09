/**
 * The small label on Health's question in a conversation (lib/healthQuestion): who is asking, in plain words, never the
 * question's id. Each look passes its own class; with none it is a quiet pill in the look's ink and line tokens.
 */
export const HEALTH_CHECK = 'Health check'

export function HealthCheckLabel({ className, upper }: { className?: string; upper?: boolean }) {
  return (
    <span data-health-check="" className={className ?? 'inline-flex items-center rounded-full border border-line px-1.5 py-px text-[10.5px] font-medium tracking-[0.02em] text-ink-2'}>
      {upper ? HEALTH_CHECK.toUpperCase() : HEALTH_CHECK}
    </span>
  )
}
