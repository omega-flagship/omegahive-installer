import type { Catalog } from '../../api/types'
import { cx } from '../../lib/cx'
import { ago } from '../../lib/format'
import { Icon } from '../../ui/Icon'

/**
 * The OpenRouter catalogue line under the model picker: how many models, how fresh their prices are (only when the
 * hive tells this person, keyview R12), and Refresh only when the hive says they may refresh it (can_refresh).
 */
export function CatalogFooter({ catalog, loading, onRefresh }: { catalog: Catalog; loading: boolean; onRefresh: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2 px-1 text-[11px] text-ink-4">
      <span>
        {catalog.models.length} OpenRouter models
        {catalog.fetched_at != null && ` · prices ${ago(new Date(catalog.fetched_at * 1000).toISOString())}`}
      </span>
      {catalog.can_refresh === true && (
        <button onClick={onRefresh} disabled={loading} className="inline-flex items-center gap-1 text-ink-3 hover:text-ink disabled:opacity-50">
          <Icon name="reset" size={12} className={cx(loading && 'animate-spin-slow')} /> Refresh
        </button>
      )}
    </div>
  )
}
