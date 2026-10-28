import { useId, useRef } from 'react'
import { useEscape } from '../../lib/hooks'
import { useModalContainment } from '../../ui/useModalContainment'
import { REST_CHOICES } from './rest'
import { restChoiceLabel, useRestPrefs } from './menu'

/** Quiet's one setting (this person, this browser): how long without input before the experience rests. */
export function RestSettingDialog({ onClose }: { onClose: () => void }) {
  const minutes = useRestPrefs((s) => s.minutes)
  const box = useRef<HTMLDivElement>(null)
  const first = useRef<HTMLInputElement>(null)
  const id = useId()
  useEscape(onClose)
  useModalContainment(box, { initialFocus: first })
  return (
    <div className="xc-dress xc-backdrop fixed inset-0 z-[60] flex items-end justify-center bg-[#03030c]/70 p-3 backdrop-blur-[3px] md:items-center" onClick={onClose}>
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-t`}
        onClick={(e) => e.stopPropagation()}
        className="xc-frame glass-strong w-full max-w-[380px] rounded-[24px] p-5"
        data-rest-setting=""
      >
        <h2 id={`${id}-t`} className="text-[16px] font-semibold text-ink">
          Rest when idle
        </h2>
        <p className="mt-1 text-[13px] text-ink-3">
          With no input for a while, the view settles into a quiet clock with calm alerts: decisions waiting, people asking, tasks finished. The hive keeps working; budget refusals still come straight through. Any key or touch wakes it, and typing goes straight into the Ask. This browser only.
        </p>
        <fieldset className="mt-3 flex flex-col gap-1">
          <legend className="sr-only">Rest after</legend>
          {REST_CHOICES.map((n) => (
            <label key={n} className="flex min-h-10 cursor-pointer items-center gap-2.5 rounded-xl px-2.5 text-[13.5px] text-ink-2 hover:bg-white/[0.05]">
              <input
                ref={n === minutes ? first : undefined}
                type="radio"
                name={`${id}-rest`}
                checked={n === minutes}
                onChange={() => useRestPrefs.getState().setMinutes(n)}
                className="accent-[var(--accent,#7aa2ff)]"
              />
              {restChoiceLabel(n)}
            </label>
          ))}
        </fieldset>
        <div className="mt-4 flex justify-end">
          <button type="button" onClick={onClose} className="rounded-full bg-white/[0.08] px-4 py-2 text-[13px] font-semibold text-ink hover:bg-white/[0.12]">
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
