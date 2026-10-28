import { createElement, lazy, type ComponentProps, type ComponentType } from 'react'
import { bustUrl, failedStylesheet, onChunkRetry } from './chunkReload'

let attempt = 0

/**
 * Load a failed view again by running its own loader: the module that comes back is always the view's own, resolved
 * through the module system with its dependencies (never a module named by the error, which may be a dependency's). A
 * stylesheet Vite could not preload is added again under a new address first, so the browser fetches it afresh. If the
 * browser keeps the failed script for the life of the page, the loader fails the same way again and the recovery says
 * "Reload to continue" (lib/chunkReload.ts).
 */
export function retryLoad<M>(err: unknown, factory: () => Promise<M>, doc: Pick<Document, 'createElement' | 'head'> | undefined = typeof document === 'undefined' ? undefined : document): Promise<M> {
  const css = failedStylesheet(err)
  if (css && doc) {
    const link = doc.createElement('link')
    link.rel = 'stylesheet'
    link.href = bustUrl(css, ++attempt)
    doc.head.appendChild(link)
  }
  return factory()
}

/**
 * React.lazy, retryable. React keeps a lazy component's rejected import forever, so "Retry" after a failed chunk load
 * could never even try again. This one remembers a failure and, on Retry, runs its own loader again (retryLoad); a view
 * that loaded is never touched (it does not suspend again).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the same bound React.lazy uses
export function lazyRoute<T extends ComponentType<any>>(factory: () => Promise<{ default: T }>): ComponentType<ComponentProps<T>> {
  let failed: { err: unknown } | null = null
  const watch = (load: () => Promise<{ default: T }>) => () =>
    load().catch((err: unknown) => {
      failed = { err }
      throw err
    })
  let current = lazy(watch(factory))
  onChunkRetry(() => {
    if (!failed) return
    const { err } = failed
    failed = null
    current = lazy(watch(() => retryLoad(err, factory)))
  })
  function LazyRoute(props: ComponentProps<T>) {
    return createElement(current, props)
  }
  return LazyRoute
}
