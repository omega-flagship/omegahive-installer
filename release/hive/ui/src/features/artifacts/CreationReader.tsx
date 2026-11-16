import { useState } from 'react'
import { ago } from '../../lib/format'
import { copyText } from '../../lib/hooks'
import { need, useResource } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { Button, EmptyState, ErrorState, Skeleton } from '../../ui/primitives'
import { isHtmlDocument } from '../views/htmlDocument'
import { ViewFrame } from '../views/ViewFrame'

/**
 * A saved creation opened in place on the Artifacts page, for a hive where Design can't open it: its title, which
 * revision and when it was saved, and the text exactly as saved. The text is shown as text, never rendered, so a plan
 * that is an HTML page shows its source, which the person can copy and save; View it beside the text draws that page as
 * a sandboxed view (features/views) only when the person asks. A creation made as a view (`view`) opens as the view,
 * with Read the source beside it; a view written in MeTTa takes up its mind's changes while it is open, and the
 * revision line and the source follow the revision it shows. Back returns to the list as it was.
 */
export function CreationReader({ artifactId, revision, title, view = false, onBack }: { artifactId: string; revision: number; title: string; view?: boolean; onBack: () => void }) {
  const client = useHive((s) => s.client)
  // the revision drawn now: the one opened, until a live view takes up a newer one (the frame keeps the one it opened)
  const [shown, setShown] = useState(revision)
  const res = useResource(() => need(client, 'creationText', 'Reading an artifact')(artifactId, shown), { context: `${artifactId}@${shown}` })
  const [copied, setCopied] = useState(false)
  const [showing, setShowing] = useState<'view' | 'text'>(view ? 'view' : 'text')
  const text = res.data?.body ?? ''
  const viewable = view || (res.status === 'ready' && isHtmlDocument(text))
  return (
    <section aria-label={`${title}, revision ${shown}`} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" className="min-h-9 px-2.5 text-[12px]" onClick={onBack}>Back to artifacts</Button>
        <span className="flex-1" />
        {viewable && (
          <Button variant="ghost" className="min-h-9 px-2.5 text-[12px]" icon={showing === 'view' ? 'doc' : 'apps'} onClick={() => setShowing(showing === 'view' ? 'text' : 'view')}>
            {showing === 'view' ? 'Read the source' : 'View it'}
          </Button>
        )}
        {showing === 'text' && res.status === 'ready' && (
          <Button variant="ghost" className="min-h-9 px-2.5 text-[12px]" onClick={async () => setCopied(await copyText(text))}>
            {copied ? 'Copied' : 'Copy the text'}
          </Button>
        )}
      </div>
      <div>
        <h2 className="text-[16px] font-medium text-ink [overflow-wrap:anywhere]">{title}</h2>
        {res.data && <p className="mt-0.5 text-meta text-ink-4">Revision {shown}, saved {ago(res.data.created_at)}</p>}
      </div>
      {showing === 'view' ? (
        // a creation made as a view opens at its latest revision and follows its mind's changes; a page's HTML is
        // viewed at the revision read
        <ViewFrame artifactId={artifactId} revision={view ? undefined : revision} place="page" onRevision={setShown} />
      ) : res.status === 'error' ? (
        <ErrorState title="Could not read it" body={res.error instanceof Error ? res.error.message : undefined} onRetry={res.reload} />
      ) : res.status === 'unsupported' ? (
        <EmptyState icon="doc" title="This hive can't show it here" body="Ask the mind that made it to send you the text." />
      ) : res.status === 'ready' ? (
        <pre className="max-h-[70dvh] overflow-auto rounded-2xl border border-line bg-tint/[0.02] p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]">{text}</pre>
      ) : (
        <Skeleton className="h-48" />
      )}
    </section>
  )
}
