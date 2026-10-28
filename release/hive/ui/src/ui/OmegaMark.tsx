/** Omega's identity mark. The living orb is a separate state indicator. */
export function OmegaMark({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={className} fill="none" aria-hidden="true" focusable="false">
      <path d="M6 32h10v-4.5C10.8 25.8 8 21.7 8 17a12 12 0 0 1 24 0c0 4.7-2.8 8.8-8 10.5V32h10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
