/** A quiet row for the person's review setting (./reviewPolicy): hidden where the hive does not offer it. */
import { Switch } from '../../../../ui/primitives'
import { useReviewSetting } from './reviewPolicy'

export const REVIEW_SETTING_LABEL = 'Ask for a second opinion before changes go in'

export function ReviewSettingRow({ client }: { client: unknown }) {
  const { setting, toggle } = useReviewSetting(client)
  if (setting.kind !== 'ready') return null
  return (
    <div className="mt-3 flex items-start justify-between gap-3 border-t border-line pt-3" data-review-setting>
      <div className="min-w-0">
        <p className="text-[13px] text-ink-2">{REVIEW_SETTING_LABEL}</p>
        <p className="text-[12px] text-ink-4">Applies to new requests.</p>
        {setting.note && <p className="mt-1 text-[12px] text-ink-3" role="alert">{setting.note}</p>}
      </div>
      <Switch checked={setting.required} onChange={toggle} label={REVIEW_SETTING_LABEL} disabled={setting.saving} />
    </div>
  )
}
