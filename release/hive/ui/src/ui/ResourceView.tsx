import type { ReactNode } from 'react'
import { errorMessage, isForbidden, type ResourceHandle, type ResourceState } from '../lib/useResource'
import type { IconName } from './Icon'
import { Button, EmptyState, ErrorState, Skeleton } from './primitives'

type Blurb = { icon?: IconName; title: string; body?: string; action?: ReactNode }

/** Shown when this hive (or the demo) does not offer something. */
export function Unavailable({ title = 'Not available here', body = 'This hive or the demo does not offer this yet.' }: { title?: string; body?: string }) {
  return <EmptyState icon="ban" title={title} body={body} />
}

/**
 * Renders a resource truthfully: a skeleton while loading, an error with retry (or `forbidden` only on a
 * 403), "not available here" when unsupported, `empty` when there is nothing, else `children(data)`.
 * A failed refresh keeps the data on screen with a slim notice and a retry.
 */
export function ResourceView<T>({
  res,
  children,
  loading,
  empty,
  errorTitle = 'Could not load this',
  forbidden,
  unsupported,
}: {
  res: ResourceState<T> & Partial<Pick<ResourceHandle<T>, 'reload'>>
  children: (data: T) => ReactNode
  loading?: ReactNode
  /** Without it, empty data goes to `children`. */
  empty?: Blurb
  errorTitle?: string
  /** What a 403 means here (e.g. "Admins only"). Without it a 403 is shown as an error like any other. */
  forbidden?: Blurb
  unsupported?: { title?: string; body?: string }
}) {
  switch (res.status) {
    case 'unsupported':
      return <Unavailable {...unsupported} />
    case 'loading':
      return <>{loading ?? <Skeleton className="h-40" />}</>
    case 'error':
      if (forbidden && isForbidden(res.error)) return <EmptyState icon={forbidden.icon ?? 'shield'} title={forbidden.title} body={forbidden.body} action={forbidden.action} />
      return <ErrorState title={errorTitle} body={errorMessage(res.error)} onRetry={res.reload} />
    case 'empty':
      if (empty)
        return (
          <>
            <StaleNotice res={res} />
            <EmptyState icon={empty.icon} title={empty.title} body={empty.body} action={empty.action} />
          </>
        )
      return (
        <>
          <StaleNotice res={res} />
          {children(res.data as T)}
        </>
      )
    case 'ready':
      return (
        <>
          <StaleNotice res={res} />
          {children(res.data as T)}
        </>
      )
  }
}

function StaleNotice<T>({ res }: { res: ResourceState<T> & Partial<Pick<ResourceHandle<T>, 'reload'>> }) {
  if (res.error === undefined) return null
  return (
    <div role="status" className="mb-3 flex items-center gap-2 rounded-xl border border-warn/30 bg-warn/[0.06] px-3 py-2 text-[12.5px] text-warn">
      <span className="min-w-0 flex-1">Could not refresh: {errorMessage(res.error)} Showing the last loaded data.</span>
      {res.reload && (
        <Button variant="ghost" className="min-h-8 px-2.5 text-[12px]" onClick={res.reload}>
          Retry
        </Button>
      )}
    </div>
  )
}
