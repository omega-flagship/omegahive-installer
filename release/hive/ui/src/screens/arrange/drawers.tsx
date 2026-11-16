// Purpose: draw one item on the stage by the kind MeTTa drew it as (screens/arrange/lib_arrange.metta): a view through
// the hive's view frame, still waiting for its person's Run it; an image or a text from its saved revision; a mind, a
// task, a decision or a message from the hive's own data; and the compact card an item beside the shown one takes.
import type { ReactNode } from 'react'
import { shown } from '../../lib/displayName'
import { useHive } from '../../store/store'
import { ErrorState, Orb, Skeleton } from '../../ui/primitives'
import { ViewFrame } from '../../features/views/ViewFrame'
import { Words } from '../../features/views/Words'
import { PartAlone } from '../Screen'
import { shaped } from './arrange'
import type { ArrangeItem, Placed } from './arrangeSpace'
import { imageSource, useArtifact, useMessage, usePagePart, useTitle, why } from './drawerData'

function ArtifactBody({ id, kind }: { id: string; kind: string }) {
  const res = useArtifact(id, true)
  if (res.status === 'unsupported') return <ErrorState title="This hive can't show creations here" />
  if (res.status === 'error') return <ErrorState title="Could not open it" body={why(res.error)} onRetry={res.reload} />
  if (res.status !== 'ready' || !res.data) return <Skeleton className="h-full" />
  const { row, text } = res.data
  if (!text) return <p className="p-4 text-[13px] text-ink-3">{row.title} has nothing saved yet.</p>
  if (kind === 'image') {
    const src = imageSource(text.body)
    // an image whose saved text is not one is said so, with the text it holds
    if (!src) return <div className="overflow-auto p-4"><p className="mb-2 text-[13px] text-ink-3">This was saved as an image, but its text is not one.</p><pre className="whitespace-pre-wrap text-[13px]">{text.body}</pre></div>
    // once loaded, the picture's own shape goes to MeTTa, which shows it in that shape
    return <img src={src} alt={row.title} className="h-full w-full object-contain" draggable={false} onLoad={(e) => shaped(id, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} />
  }
  return <div className="h-full overflow-auto p-4 text-[14px] leading-relaxed whitespace-pre-wrap"><Words text={text.body} /></div>
}

function MindBody({ id }: { id: string }) {
  const a = useHive((s) => s.agents[id])
  if (!a) return <p className="p-4 text-[13px] text-ink-3">This mind is not shown to you.</p>
  return (
    <div className="flex items-center gap-3 p-4">
      <Orb hue={a.hue} status={a.status} size={36} />
      <div className="min-w-0">
        <p className="truncate text-[15px] font-medium">{shown(a.name)}</p>
        <p className="text-[12px] text-ink-3">{a.status}</p>
      </div>
    </div>
  )
}

function TaskBody({ id }: { id: string }) {
  const g = useHive((s) => s.goals[id])
  if (!g) return <p className="p-4 text-[13px] text-ink-3">This task is not shown to you.</p>
  return (
    <div className="h-full overflow-auto p-4">
      <p className="text-[15px] font-medium">{g.title}</p>
      <p className="mb-2 text-[12px] text-ink-3">{g.status}</p>
      {g.detail ? <div className="text-[13px] leading-relaxed whitespace-pre-wrap"><Words text={g.detail} /></div> : null}
    </div>
  )
}

function DecisionBody({ id }: { id: string }) {
  const d = useHive((s) => s.approvals[id])
  if (!d) return <p className="p-4 text-[13px] text-ink-3">This decision is not shown to you.</p>
  return (
    <div className="h-full overflow-auto p-4 text-[13px]">
      <p className="text-[15px] font-medium">{d.skill}</p>
      <p className="mb-2 text-ink-3">{d.status}, {d.risk} risk</p>
      <pre className="whitespace-pre-wrap">{d.command}</pre>
      {d.reason ? <p className="mt-2">{d.reason}</p> : null}
    </div>
  )
}

function MessageBody({ id }: { id: string }) {
  const m = useMessage(id)
  if (!m) return <p className="p-4 text-[13px] text-ink-3">This message is not here any more.</p>
  return <div className="h-full overflow-auto p-4 text-[14px] leading-relaxed whitespace-pre-wrap"><Words text={m.text} /></div>
}

/** A part of the open page, drawn by the block that draws it there, acting on the page through the page's own host. */
function PartBody({ id }: { id: string }) {
  const p = usePagePart(id)
  if (!p) return <p className="p-4 text-[13px] text-ink-3">This part of the page is not open any more.</p>
  return <div className="h-full overflow-auto p-4"><PartAlone part={p.part} host={p.screen.host()} /></div>
}

/** What an item draws as, by the kind MeTTa drew it as. */
function Body({ item, kind }: { item: ArrangeItem; kind: string }): ReactNode {
  switch (item.source) {
    case 'artifact': return kind === 'view' ? <div className="h-full overflow-auto"><ViewFrame artifactId={item.key} place="page" /></div> : <ArtifactBody id={item.key} kind={kind} />
    case 'mind': return <MindBody id={item.key} />
    case 'task': return <TaskBody id={item.key} />
    case 'decision': return <DecisionBody id={item.key} />
    case 'message': return <MessageBody id={item.key} />
    case 'part': return <PartBody id={item.key} />
  }
}

export interface TileProps {
  item: ArrangeItem
  placed: Placed
  /** Take it out of view, into the tray. */
  onPutAway: () => void
  /** Bring an item from beside the shown one into the view beside it. */
  onBring: () => void
}

/**
 * One item on the stage. The shown item draws whole, with its name and Put away above it. An item beside it draws as a
 * card with its name that brings it into view beside the shown one when pressed, as a window in Scalable Fabric's
 * periphery returns to the centre on a click. A picture shown fills its tile, which MeTTa gives the picture's own shape,
 * so its name and Put away sit over its top edge.
 */
export function Tile({ item, placed, onPutAway, onBring }: TileProps) {
  const title = useTitle(item)
  if (placed.role === 'beside') {
    return (
      <button type="button" onClick={onBring} aria-label={`Bring ${title} beside`} data-stage-beside={item.key}
        className="xc-frame glass flex h-full w-full flex-col overflow-hidden rounded-2xl border border-line text-left hover:border-accent/60 focus-visible:outline-2">
        <span className="truncate px-3 py-2 text-[12px] font-medium">{title}</span>
        <span className="pointer-events-none min-h-0 flex-1 overflow-hidden opacity-80" inert><Body item={item} kind={placed.kind} /></span>
      </button>
    )
  }
  const over = placed.kind === 'image'
  return (
    <section aria-label={title} className="xc-frame glass-strong relative flex h-full w-full flex-col overflow-hidden rounded-2xl border border-line">
      <header className={over ? 'absolute inset-x-0 top-0 z-[1] flex items-center gap-2 bg-gradient-to-b from-void/80 to-transparent px-3 pt-1.5 pb-4' : 'flex items-center gap-2 border-b border-line px-3 py-1.5'}>
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium">{title}</h2>
        <button type="button" onClick={onPutAway} aria-label={`Put ${title} away`} className="rounded-md px-1.5 py-0.5 text-[16px] leading-none text-ink-3 hover:text-ink">×</button>
      </header>
      <div className="min-h-0 flex-1">
        <Body item={item} kind={placed.kind} />
      </div>
    </section>
  )
}
