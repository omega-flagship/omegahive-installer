import { hsl } from '../../lib/color'
import { navigate } from '../../lib/router'
import { Icon, type IconName } from '../../ui/Icon'
import { Button, Orb } from '../../ui/primitives'
import type { Target } from './CodePage'
import { closedReason, targetOpenable } from './editSessionRules'

export const KIND: Record<Target['kind'], { label: string; icon: IconName; hue: number }> = {
  hive: { label: 'The hive', icon: 'hive', hue: 252 },
  program: { label: 'Programs and apps', icon: 'apps', hue: 200 },
  mind: { label: 'Minds', icon: 'mind', hue: 300 },
  service: { label: 'Services', icon: 'cpu', hue: 150 },
  repository: { label: 'Coding repositories', icon: 'doc', hue: 40 },
}

/**
 * One edit target. Surface request L: a target the host closed (next10 `closed_reason`) stays on the page and says why
 * in the host's words, with no Edit button at all. Without closed_reason (live 0aa6330) the card is as before.
 */
export function TargetCard({ t }: { t: Target }) {
  const hue = t.mind?.hue ?? KIND[t.kind].hue
  const reason = closedReason(t)
  const canOpen = targetOpenable(t)
  return (
    <div className="flex flex-col rounded-2xl border border-line bg-white/[0.03] p-4 transition-colors hover:border-line-2" style={{ boxShadow: `0 20px 50px -34px ${hsl(hue, 100, 60, 0.6)}` }} aria-label={`Edit target ${t.label}`}>
      <div className="flex items-start gap-3">
        {t.mind ? (
          <Orb hue={t.mind.hue} status={t.mind.status} size={34} />
        ) : (
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-line bg-black/25" style={{ color: hsl(hue, 100, 78) }}>
            <Icon name={KIND[t.kind].icon} size={17} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-display text-[15px] font-semibold">{t.label}</span>
            {t.private && <span className="rounded-full border border-warn/30 bg-warn/10 px-1.5 text-[10px] font-semibold text-warn">private</span>}
            {t.built_in && <span className="rounded-full border border-line px-1.5 text-[10px] text-ink-3">built in</span>}
          </div>
          <p className="mt-0.5 line-clamp-2 text-[12px] text-ink-3">{t.detail}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-ink-4">
        <span>Owner: {t.owner}</span>
        {t.repo?.commit && (
          <span className="font-mono">
            {t.repo.branch ?? 'detached'} @ {t.repo.commit.slice(0, 7)}
            {t.repo.dirty ? ' · uncommitted changes' : ''}
          </span>
        )}
      </div>
      {reason ? (
        <div className="mt-3 border-t border-line pt-3">
          <p className="flex items-start gap-1.5 text-[12px] text-ink-2 [overflow-wrap:anywhere]" aria-label="Why it cannot be edited">
            <Icon name={t.private ? 'shield' : 'ban'} size={13} className="mt-0.5 shrink-0 text-ink-3" />
            <span>Can’t be edited here: {reason}.</span>
          </p>
        </div>
      ) : (
        <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-3">
          <span className="min-w-0 truncate text-[11.5px] text-ink-3" title={t.apply.note}>
            Apply: {t.apply.ready ? t.apply.how : `${t.apply.how} (coming)`}
          </span>
          <Button variant="subtle" icon={canOpen ? 'edit' : t.private ? 'shield' : 'ban'} disabled={!canOpen} title={canOpen ? undefined : t.private ? `Private: ${t.owner} has to agree first` : 'Not under source control yet'} onClick={() => navigate({ name: 'code', target: t.id })} className="min-h-9 px-3 text-[12.5px]">
            {canOpen ? 'Edit code' : t.private ? 'Owner must agree' : 'No source control'}
          </Button>
        </div>
      )}
    </div>
  )
}
