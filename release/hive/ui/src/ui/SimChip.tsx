import { cx } from '../lib/cx'
import { SIM_COST_NOTE, useSim } from '../lib/sim'

/** Marks a dollar figure as simulated (sim and demo mode only). The tooltip says what that means. */
export function SimChip({ className, label = 'sim' }: { className?: string; label?: string }) {
  const sim = useSim()
  if (!sim) return null
  return (
    <span
      title={SIM_COST_NOTE}
      aria-label="simulated"
      className={cx('inline-flex shrink-0 items-center rounded-[5px] border border-warn/30 bg-warn/[0.09] px-1 py-px text-[9px] leading-none font-semibold tracking-[0.06em] text-warn/90 uppercase', className)}
    >
      {label}
    </span>
  )
}
