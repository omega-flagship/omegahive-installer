import { m } from 'framer-motion'
import type { CSSProperties, ReactNode } from 'react'
import { useEscape, useReducedMotion } from '../lib/hooks'
import { IconButton } from './primitives'
import { cx } from '../lib/cx'
import { closePage, closeToHome } from '../lib/router'
import { ViewInfo } from '../tour/ViewInfo'
import type { ViewKey } from '../tour/views'

/** A full-screen glass view over the dimmed hive (swarms, usage). */
export function Page({
  title,
  eyebrow,
  onClose,
  onBack,
  actions,
  children,
  className,
  label,
  onEscape,
  info,
  style,
  decor,
  app,
  enter = true,
}: {
  title: ReactNode
  eyebrow?: ReactNode
  /**
   * Where Esc goes when the person did not come from elsewhere in the app (a deep link or a fresh tab).
   * Esc first steps back to the previous in-app page; without this it falls back to the route's logical parent.
   * The X never uses it: the X always returns to the home screen (closeToHome).
   */
  onClose?: () => void
  onBack?: () => void
  actions?: ReactNode
  children: ReactNode
  className?: string
  label: string
  /** What Esc does when it should differ from Back/Close (e.g. back one step in a trail). */
  onEscape?: () => void
  /** The view's "What's this?" explainer. */
  info?: ViewKey
  /** Extra variables for this page (an app's identity in the person's look: shell/appLook.ts). */
  style?: CSSProperties
  /** A decorative layer behind the content (an app's motif). */
  decor?: ReactNode
  /** The app this page belongs to, for its type pairing (`data-app-type`). */
  app?: { id: string; type: string }
  /** false: appear in place, without the entrance (the page replaces a loading frame already on screen). */
  enter?: boolean
}) {
  const reduced = useReducedMotion()
  const escape = () => closePage(onClose)
  useEscape(onEscape ?? onBack ?? escape)
  return (
    <m.section
      role="dialog"
      aria-label={label}
      initial={enter ? { opacity: 0, y: reduced ? 0 : 24, scale: reduced ? 1 : 0.985 } : false}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: reduced ? 0 : 16, transition: { duration: 0.18 } }}
      transition={{ type: 'spring', stiffness: 300, damping: 34 }}
      className={cx(
        'xc-dress xc-page fixed inset-0 z-[25] flex flex-col overflow-hidden md:top-[var(--page-top,12px)] md:bottom-[var(--page-bottom,12px)] md:right-3 md:left-[var(--rail-x,84px)] md:rounded-[24px] md:border md:border-line',
        className,
      )}
      data-app={app?.id}
      data-app-type={app?.type}
      data-presence-region="page"
      style={{
        ...style,
        background: 'linear-gradient(180deg, var(--look-page-a, rgb(10 10 32 / 0.9)), var(--look-page-b, rgb(6 6 22 / 0.94)))',
        backdropFilter: 'blur(24px) saturate(140%)',
        WebkitBackdropFilter: 'blur(24px) saturate(140%)',
      }}
    >
      {decor}
      <header className="relative flex shrink-0 flex-wrap items-center gap-2 px-3 pb-2 md:flex-nowrap md:px-6 md:pt-4" style={{ paddingTop: 'calc(var(--sat) + 10px)' }}>
        {onBack && <IconButton icon="back" label="Back" onClick={onBack} />}
        <div className="min-w-0 flex-1 px-1">
          {eyebrow && <div className="eyebrow">{eyebrow}</div>}
          <h1 className="truncate font-display text-[22px] font-semibold tracking-tight md:text-[26px]">{title}</h1>
        </div>
        {/* On phones the actions take their own row under the title, so they never squeeze it out. */}
        {actions && <div className="order-last flex w-full flex-wrap items-center gap-2 px-1 md:order-none md:w-auto md:flex-nowrap md:px-0">{actions}</div>}
        {info && <ViewInfo view={info} />}
        <IconButton icon="x" label="Close" onClick={closeToHome} />
      </header>
      <div className="xc-omega-pad thin-scroll relative min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
    </m.section>
  )
}
