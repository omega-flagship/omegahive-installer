import { useEffect } from 'react'
import { navigate } from '../../lib/router'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { shown } from '../../lib/displayName'

/** Pick a role from the library (or none). Used on a mind, in the create flow and when starting a swarm. */
export function RoleSelect({ value, onChange, label = 'Role', compact }: { value: string | null | undefined; onChange: (roleId: string | null) => void; label?: string; compact?: boolean }) {
  const roles = useHive((s) => s.roles)
  const loadRoles = useHive((s) => s.loadRoles)
  useEffect(() => {
    if (!roles) void loadRoles().catch(() => undefined)
  }, [roles, loadRoles])
  return (
    <div className="flex items-center gap-2">
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        aria-label={label}
        className={`min-w-0 flex-1 rounded-xl border border-line bg-shade/25 px-2.5 text-ink outline-none focus:border-line-2 ${compact ? 'min-h-10 text-[13px]' : 'min-h-11 text-[14px]'}`}
      >
        <option value="">No role (own instructions only)</option>
        {(roles ?? []).map((r) => (
          <option key={r.id} value={r.id}>
            {shown(r.name)}
            {r.summary ? ` · ${r.summary}` : ''}
          </option>
        ))}
      </select>
      <button onClick={() => navigate({ name: 'roles', id: value ?? undefined })} title="Edit roles" aria-label="Edit roles" className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-line text-ink-3 hover:border-line-2 hover:text-ink">
        <Icon name="edit" size={15} />
      </button>
    </div>
  )
}
