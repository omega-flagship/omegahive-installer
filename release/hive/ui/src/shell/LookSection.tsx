import { useHive } from '../store/store'
import { Button, Segmented } from '../ui/primitives'
import { setHourCycle, useHourCycle, type HourCycle } from './clockModel'
import { DEFAULT_VARIANT, effectiveLayout, LAYOUTS, lookName, openGallery, resetLook, useLook } from './uiVariant'

/** The OS clock's hour cycle (shell/OsClock): the locale's own, or 12- or 24-hour time. Kept on this device. */
export function ClockPref() {
  const cycle = useHourCycle()
  return (
    <section aria-labelledby="clock-h" className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-tint/[0.03] p-4">
      <div className="min-w-0 flex-1">
        <h2 id="clock-h" className="eyebrow">
          Clock
        </h2>
        <p className="mt-1 text-[13px] text-ink-2">The time in the bottom-right corner. Kept on this device.</p>
      </div>
      <Segmented<HourCycle>
        label="Clock hours"
        value={cycle}
        onChange={setHourCycle}
        options={[
          { value: 'auto', label: 'As this device' },
          { value: '12', label: '12-hour' },
          { value: '24', label: '24-hour' },
        ]}
        dense
      />
    </section>
  )
}

/** "Look and layout" on You & your keys: what you are using, Change experience, and the reset that always works. */
export function LookSection() {
  const look = useLook()
  const client = useHive((s) => s.client)
  if (!look.available) return null
  const name = lookName(look.saved) // the experience while one is chosen, never its companion look (F1)
  const layout = LAYOUTS.find((l) => l.id === effectiveLayout(look.saved))?.label ?? 'Side rail'
  return (
    <section aria-labelledby="look-h" className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-tint/[0.03] p-4">
      <div className="min-w-0 flex-1">
        <h2 id="look-h" className="eyebrow">
          Look and layout
        </h2>
        <p className="mt-1 text-[13px] text-ink-2">
          {name} · {layout}
        </p>
      </div>
      <Button variant="primary" icon="sparkles" onClick={() => openGallery(true)} data-tour="me-change-ui">
        Change experience
      </Button>
      {look.saved && (
        <Button variant="subtle" icon="reset" onClick={() => void resetLook(client)}>
          Reset to {DEFAULT_VARIANT.name}
        </Button>
      )}
    </section>
  )
}
