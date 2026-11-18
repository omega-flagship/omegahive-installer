// Purpose: words said in the hive as MeTTa composes them for the look being worn (features/views/words.metta): states the screen's two flags, looks up each artifact the words name for this person, draws the parts MeTTa placed with screens/Screen.tsx's InlineParts, and opens an artifact when its chip is pressed. Loaded lazily by Words.tsx, so the screen engine stays out of the first paint.
import { useEffect, useMemo, useState } from 'react'
import type { HiveClient } from '../../api/client'
import type { CreationRow } from '../artifacts/artifacts'
import { experienceById } from '../../experiences/registry'
import { namedArtifacts } from '../../lib/artifactRefs'
import { hasNotation } from '../../lib/beliefSentence'
import { readContext } from '../../lib/readContext'
import { navigate } from '../../lib/router'
import { isForbidden, isNotFound, need } from '../../lib/useResource'
import { InlineParts, type NamedArtifact, type ScreenHost } from '../../screens/Screen'
import { rememberedCompose, type Compose } from '../../screens/screenSpace'
import { useLook } from '../../shell/uiVariant'
import { useHive } from '../../store/store'
import type { WordsProps } from './Words'

// one answer per artifact per identity (readContext): every place naming it, and the words drawn again as a reply
// streams in, read it once. A 404 or a 403 is an answer too; any other failure is read again next time.
const answers = new Map<string, Promise<CreationRow>>()
function lookup(client: HiveClient | null, id: string): Promise<CreationRow> {
  const key = readContext(client, 'artifact', id)
  const known = answers.get(key)
  if (known) return known
  const asked = Promise.resolve().then(() => need(client, 'artifact', 'Artifacts')(id))
  answers.set(key, asked)
  asked.catch((e: unknown) => { if (!isNotFound(e) && !isForbidden(e) && answers.get(key) === asked) answers.delete(key) })
  return asked
}

/** A view drawn under a message on this page is brought into sight; anything else opens on Artifacts. */
function openArtifact(id: string, kind: string | undefined) {
  // the id is "ar_" and hex digits (lib/artifactRefs), safe inside the selector as it is
  const slot = kind === 'view' ? document.querySelector<HTMLElement>(`[data-view-slot="${id}"]`) : null
  if (slot) slot.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  else navigate({ name: 'artifacts', open: id })
}

// one composer per look, shared by every word drawn in it: MeTTa answers once per look and set of flags
const composers = new Map<string, Compose>()
function composerFor(look: string): Compose {
  let compose = composers.get(look)
  if (!compose) composers.set(look, (compose = rememberedCompose(look)))
  return compose
}

const NONE: Record<string, NamedArtifact> = {}
const host = ({ text, className, mark }: WordsProps, found: Record<string, NamedArtifact>): ScreenHost => ({
  data: { text, class: className ?? '', 'words.named': found, 'words.mark': mark },
  onOpen: (target, item) => {
    if (target === 'artifact') openArtifact(String(item.id), typeof item.kind === 'string' ? item.kind : undefined)
  },
})

export default function ComposedWords(props: WordsProps) {
  const ids = useMemo(() => namedArtifacts(props.text), [props.text])
  // keyed by the ids, so words that name other artifacts start their answers afresh
  return ids.length ? <WithNames key={ids.join(' ')} {...props} ids={ids} /> : <Drawn {...props} found={NONE} />
}

/** Words that name artifacts: each is looked up for this person on its own, so one slow answer holds no other chip, and
 *  a chip says "Artifact" until its answer comes (a 404 or 403 is an answer: missing; any other failure leaves it). */
function WithNames({ ids, ...props }: WordsProps & { ids: string[] }) {
  const client = useHive((s) => s.client)
  const [found, setFound] = useState<Record<string, NamedArtifact>>(NONE)
  useEffect(() => {
    let live = true
    for (const id of ids) {
      lookup(client, id).then(
        (row) => { if (live) setFound((f) => ({ ...f, [id]: { title: row.title, kind: row.kind } })) },
        (e: unknown) => { if (live && (isNotFound(e) || isForbidden(e))) setFound((f) => ({ ...f, [id]: { missing: true } })) },
      )
    }
    return () => { live = false }
  }, [client, ids])
  return <Drawn {...props} found={found} />
}

function Drawn({ found, ...props }: WordsProps & { found: Record<string, NamedArtifact> }) {
  const { text, said = true, written } = props
  const look = experienceById(useLook().current?.experience).id
  // notation said in English is offered as written unless the place says otherwise; a place showing only "as written"
  // asks for it (said false, written true)
  const offer = written ?? (said && hasNotation(text))
  const plan = composerFor(look)('words', { flags: { 'words.said': said, 'words.written': offer } })
  return <InlineParts plan={plan} host={host(props, found)} />
}
