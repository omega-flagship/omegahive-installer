import { MARK_PATHS, MARK_VIEWBOX, MARK_WELD } from './markOutline'

/** The Omega mark, flat: one welded shape in the current text colour. For the corner button, bars and line art. */
export function OmegaGlyph({ className = '', title }: { className?: string; title?: string }) {
  return (
    <svg viewBox={MARK_VIEWBOX} className={className} role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} focusable="false">
      {title && <title>{title}</title>}
      <g fill="currentColor" stroke="currentColor" strokeWidth={MARK_WELD} strokeLinejoin="round">
        <path d={MARK_PATHS.left} />
        <path d={MARK_PATHS.right} />
        <path d={MARK_PATHS.base} />
      </g>
    </svg>
  )
}
