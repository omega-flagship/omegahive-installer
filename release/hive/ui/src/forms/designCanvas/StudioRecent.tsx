// Purpose: supply Studio's recent creations and open the selected design, picture, or app.

import { useState } from 'react'
import { experienceById } from '../../experiences/registry'
import { readContext, taggedFor, type Tagged } from '../../lib/readContext'
import { href, navigate, openInDesign } from '../../lib/router'
import { svgImageSource } from '../../lib/svgImage'
import { need, useAuthContext, useResource } from '../../lib/useResource'
import { withResource } from '../../screens/resourceFacts'
import { Screen } from '../../screens/Screen'
import { useCompose } from '../../screens/useCompose'
import { useLook } from '../../shell/uiVariant'
import { useHive } from '../../store/store'

type PictureRef = { id: string; revision: number }

const KIND_LABEL = { design: 'Design', image: 'Picture', app: 'App' }

export function StudioRecent() {
  const client = useHive((state) => state.client)
  useAuthContext(client)
  const identity = readContext(client)
  const [selected, select] = useState<Tagged<PictureRef> | null>(null)
  const opened = taggedFor(selected, identity)
  const [failedImage, setFailedImage] = useState<PictureRef | null>(null)
  const compose = useCompose(experienceById(useLook().current?.experience).id)
  const recent = useResource(() => need(client, 'studioRecent', 'Recent creations')(), { poll: 30_000 })
  const revision = useResource(() => opened ? need(client, 'creationText', 'Opening a picture')(opened.id, opened.revision)
    : Promise.resolve(null), { context: opened ? `${opened.id}@${opened.revision}` : null })
  const rows = recent.data?.map((row) => ({ ...row, label: KIND_LABEL[row.kind] })) ?? []
  const body = revision.data
  const pictureFailed = !!opened && failedImage === opened
  const { data, facts } = withResource(opened ? revision : recent, {
    data: {
      'creations.rows': rows, 'creations.artifacts': href({ name: 'artifacts' }), 'picture.title': body?.title ?? '',
      'picture.src': body && opened && !pictureFailed ? svgImageSource(body.body) : '',
    },
    facts: {
      flags: { 'picture.failed': pictureFailed },
      counts: { 'creations.rows': rows.length, 'picture.saved': body && opened ? 1 : 0 },
    },
  })
  return (
    <Screen plan={compose(opened ? 'studio-picture' : 'studio-recent', facts)} className="dc-recent w-full max-w-lg shrink-0 text-start" host={{
      data,
      onOpen: (target, item) => {
        if (target !== 'creation') return
        const row = rows.find(({ id, kind }) => id === item.id && kind === item.kind)
        if (!row) return
        if (row.kind === 'image') select({ ctx: identity, value: row })
        else if (row.kind === 'app') navigate({ name: 'program', id: row.id, swarm: row.swarm_id ?? undefined })
        else {
          const route = openInDesign({ artifact_id: row.id, revision: row.revision, digest: row.digest }, row.swarm_id)
          if (route) navigate(route)
        }
      },
      onAction: (action) => {
        if (action === 'back') select(null)
        else if (action === 'reload-creations') recent.reload()
        else if (action === 'reload-picture') revision.reload()
        else if (action === 'picture-error') setFailedImage(opened)
      },
    }} />
  )
}
