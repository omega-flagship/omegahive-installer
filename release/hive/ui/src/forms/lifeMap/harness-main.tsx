import '@fontsource-variable/inter'
import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ActionResult, Program, WorkGraph } from '../../api/types'
import type { ActContext } from '../contract'
import type { Grammar } from '../contract'
import LifeMap from './LifeMap'
import { ATLAS_DESCRIBE, EMPTY_GRAPH, sampleGraph } from './sample'
import { simulateAct } from './useAtlas'

/**
 * Harness for the Atlas form, a separate Vite entry: lifemap-harness.html?grammar=classic|still|cosmos&mode=owner|empty|sample
 *  - owner:  an invented, messier stress dataset ("Subject Z", harness only) drawn as if it were the owner's;
 *  - empty:  a viewer who is not the owner (nothing of anyone's is drawn);
 *  - sample: a newcomer who pressed "Explore a sample" (the official SAMPLE, Subject A).
 * Extra: &view=today|map|timeline|plan, &level=0..3, &select=<id>, &reveal=1, &consent=1 for screenshots.
 * &probe=1 (mounted review checks): window.__lifemap.setGraph(fn) changes the invented graph as a host refresh would,
 * and window.__lifemap.acts records every act() call with its inspected base revision.
 * Never loads real data.
 */

const q = new URLSearchParams(location.search)
const grammar = (q.get('grammar') ?? 'classic') as Grammar
const mode = q.get('mode') ?? 'sample'

const probe: { acts: { action: string; items: string[]; baseRevision: string | null; graphRevision: string }[]; setGraph?: (f: (g: WorkGraph) => WorkGraph) => void } = { acts: [] }
if (q.get('probe')) (window as unknown as { __lifemap: typeof probe }).__lifemap = probe

const program: Program = { id: 'atlas', name: 'Atlas', version: '0.3.0', description: 'Local provisional subject model with ledger provenance.', icon: 'flask', capabilities: [], source: 'harness', enabled: true, error: null }

// a Vite entry, not a module others import
// eslint-disable-next-line react-refresh/only-export-components
function Harness() {
  const initial = useMemo(() => (mode === 'owner' ? sampleGraph({ messy: true, subject: 'Subject Z (harness)' }) : mode === 'sample' ? sampleGraph() : EMPTY_GRAPH), [])
  const [graph, setGraph] = useState<WorkGraph>(initial)
  useEffect(() => {
    if (q.get('probe')) probe.setGraph = setGraph
  }, [])
  const act = async (action: string, items: string[], params?: Record<string, unknown>, ctx?: ActContext): Promise<ActionResult> => {
    if (q.get('probe')) probe.acts.push({ action, items, baseRevision: ctx?.baseRevision ?? null, graphRevision: graph.revision })
    await new Promise((r) => setTimeout(r, 300))
    return simulateAct(graph, action, items, params)
  }
  return (
    <div style={{ height: '100dvh' }}>
      <LifeMap program={program} describe={ATLAS_DESCRIBE} graph={mode === 'sample' ? EMPTY_GRAPH : graph} grammar={grammar} act={act} focus={() => {}} viewer={{ isOwner: mode === 'owner' }} />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
)

/* screenshot helpers: drive the form through its own buttons once mounted */
const steps = async () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const click = (sel: string, text?: string) => {
    const els = [...document.querySelectorAll<HTMLElement>(sel)]
    const el = text ? els.find((e) => e.textContent?.trim().startsWith(text)) : els[0]
    el?.click()
    return !!el
  }
  for (let i = 0; i < 100 && !document.querySelector('.lm-header, .lm-still-head'); i++) await wait(100)
  await wait(300)
  if (mode === 'sample') click('.lm-btn-primary', 'Explore a sample')
  await wait(200)
  const view = q.get('view')
  if (view) click('.lm-viewbar button, .lm-contents button', { today: grammar === 'still' ? 'Preface' : 'Today', map: grammar === 'still' ? 'Chapters' : 'Map', timeline: grammar === 'still' ? 'Chronology' : 'Timeline', plan: grammar === 'still' ? 'Open questions' : 'Plan' }[view])
  await wait(200)
  const level = q.get('level')
  if (level) document.querySelectorAll<HTMLElement>('.lm-rail-step')[+level]?.click()
  await wait(200)
  const t = q.get('territory')
  if (t) click('.lm-chip, .lm-band', t)
  await wait(200)
  const sel = q.get('select')
  if (sel) {
    const el = [...document.querySelectorAll<HTMLElement>('[role="button"][aria-label], .lm-ref, .lm-listrow, .lm-index button')].find((e) => (e.getAttribute('aria-label') ?? e.textContent ?? '').includes(sel))
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
  }
  await wait(250)
  if (q.get('reveal')) click('.lm-btn-reveal')
  if (q.get('consent')) {
    await wait(200)
    click('.lm-reading-actions .lm-btn', 'Ask a Scientist')
  }
  document.body.dataset.ready = '1'
}
void steps()
