import { navigate } from '../../lib/router'
import { Page } from '../../ui/Page'
import { SetupChecklist, SetupStatus } from './SetupChecklist'

/** #/setup: the first-run checklist as a page, reachable from the palette, Settings and every experience's directory. */
export default function SetupPage() {
  return (
    <Page title="Getting started" eyebrow="This hive" label="Getting started" onClose={() => navigate({ name: 'hive' })}>
      <div className="mx-auto max-w-xl px-4 pt-2 pb-12 md:px-6">
        <p className="mb-4 text-[13px] text-ink-3">Five things that make a hive work. Each is ticked from what the hive reports, never from a guess; a question mark means this hive or your role cannot tell.</p>
        <SetupChecklist />
        <SetupStatus />
      </div>
    </Page>
  )
}
