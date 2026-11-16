/** "New messages ↓": there is more below a reader who scrolled up (lib/stickToBottom); it takes them to the end. */
export const NEW_BELOW_LABEL = 'New messages ↓'

export function NewBelow({ show, onClick, className }: { show: boolean; onClick: () => void; className?: string }) {
  if (!show) return null
  return (
    <button type="button" className={className} onClick={onClick} data-new-below="" aria-label="New messages: go to the newest">
      {NEW_BELOW_LABEL}
    </button>
  )
}
