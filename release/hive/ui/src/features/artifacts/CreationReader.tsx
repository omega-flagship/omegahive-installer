/**
 * Purpose: a saved creation opened in place on the Artifacts page, for a hive where Design can't open it: its title, which
 * revision and when it was saved, and the text exactly as saved. The text is shown as text, never rendered, so a plan
 * that is an HTML page shows its source, which the person can copy and save; View it beside the text draws that page as
 * a sandboxed view (features/views) only when the person asks. A creation made as a view (`view`) opens as the view,
 * with Read the source beside it; a view written in MeTTa takes up its mind's changes while it is open, and the
 * revision line and the source follow the revision it shows. Back returns to the list as it was. What is on it, and
 * every word, is artifacts.metta's artifact-reader screen; this file states the facts and draws the text and the view.
 */
import { useId, useState } from 'react'
import { experienceById } from '../../experiences/registry'
import { ago } from '../../lib/format'
import { copyText } from '../../lib/hooks'
import { need, useResource } from '../../lib/useResource'
import { withResource } from '../../screens/resourceFacts'
import { Screen } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { useLook } from '../../shell/uiVariant'
import { useHive } from '../../store/store'
import { isHtmlDocument } from '../views/htmlDocument'
import { ViewFrame } from '../views/ViewFrame'

/** The islands artifact-reader places: the creation's text as saved, and its view. */
const ISLAND = { text: 'text', view: 'view' } as const

export function CreationReader({ artifactId, revision, title, view = false, onBack }: { artifactId: string; revision: number; title: string; view?: boolean; onBack: () => void }) {
  const client = useHive((s) => s.client)
  const compose = useCompose(experienceById(useLook().current?.experience).id)
  const titleId = useId()
  // the revision drawn now: the one opened, until a live view takes up a newer one (the frame keeps the one it opened)
  const [shown, setShown] = useState(revision)
  const res = useResource(() => need(client, 'creationText', 'Reading an artifact')(artifactId, shown), { context: `${artifactId}@${shown}` })
  const [copied, setCopied] = useState(false)
  const [showing, setShowing] = useState<'view' | 'text'>(view ? 'view' : 'text')
  const text = res.data?.body ?? ''
  const viewable = view || (res.status === 'ready' && isHtmlDocument(text))
  const { data, facts } = withResource(res, {
    data: {
      'reader.title': title, 'reader.title-id': titleId, 'reader.revision': shown, 'reader.saved': res.data ? ago(res.data.created_at) : '',
      'reader.view': showing === 'view', 'reader.viewable': viewable, 'reader.copied': copied,
    },
    facts: { flags: { 'reader.view': showing === 'view' }, counts: { 'reader.saved': res.data ? 1 : 0 } },
  })
  return (
    <section aria-labelledby={titleId}>
      <Screen plan={compose('artifact-reader', facts)} className="space-y-3" host={{
        data,
        onAction: (action) => {
          if (action === 'back') onBack()
          else if (action === 'view' || action === 'source') setShowing(action === 'view' ? 'view' : 'text')
          else if (action === 'copy') void copyText(text).then(setCopied)
          else if (action === 'retry') res.reload()
        },
        islands: {
          [ISLAND.text]: (
            <pre className="max-h-[70dvh] overflow-auto rounded-2xl border border-line bg-tint/[0.02] p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]">{text}</pre>
          ),
          // a creation made as a view opens at its latest revision and follows its mind's changes; a page's HTML is
          // viewed at the revision read
          [ISLAND.view]: <ViewFrame artifactId={artifactId} revision={view ? undefined : revision} place="page" onRevision={setShown} />,
        },
      }} />
    </section>
  )
}
