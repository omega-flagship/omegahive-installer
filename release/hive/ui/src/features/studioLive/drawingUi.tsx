/** Create UI projections only. These labels never grant drawing or maker authority. */
import type { AskSettings } from '../../api/ask'
import { studioCapable, type StudioHostClient } from './api'

export type DrawingMode = 'steer' | 'queue'
export interface DrawingAvailability { available: boolean; code: string; reason: string | null }

/**
 * `hasAskTurn`: an Ask turn is already recorded on this page. `hasWords`: the Ask holds unsent words, which Draw live
 * asks first (studioLive/store recordDrawTurn), so the button works from typed words alone (Jon, 4 Nov).
 */
export function drawingAvailability(client: StudioHostClient | null | undefined, settings: AskSettings | null | undefined, space: boolean, ui: boolean, hasAskTurn: boolean, hasWords = false): DrawingAvailability {
  if (!client) return { available: false, code: 'client_unavailable', reason: 'Connect to a hive to check live drawing.' }
  if (!space) return { available: false, code: 'space_unavailable', reason: 'Choose an available Create space before starting live drawing.' }
  if (!ui) return { available: false, code: 'canvas_unavailable', reason: 'This app has not provided a drawing interface.' }
  if (client.mode !== 'sim' && !settings) return { available: false, code: 'checking', reason: 'Live drawing availability has not been read from this hive yet.' }
  if (!studioCapable(client, settings)) {
    const caps = settings?.capabilities as Record<string, unknown> | undefined
    if (client.mode !== 'sim' && caps?.studio_sessions !== true) return { available: false, code: 'host_not_offered', reason: 'This hive is not offering live drawing right now, so nothing can be drawn here yet. It has not said why.' }
    return { available: false, code: 'client_unsupported', reason: 'This page cannot use all the drawing controls this hive requires.' }
  }
  if (!client.studioSetupProposal) return { available: false, code: 'setup_unavailable', reason: 'This page cannot prepare the drawing confirmation on this hive.' }
  if (client.mode !== 'sim' && !hasAskTurn && !hasWords) return { available: false, code: 'ask_turn_required', reason: 'Type what you want drawn in the Ask, then press Draw live.' }
  return { available: true, code: 'available', reason: null }
}

/** Always visible on the listed Create app page; availability only enables its existing entry. */
export function DrawingEntry({ availability, start, ask, note, busy }: { availability: DrawingAvailability; start(): void; ask?(): void; note?: string | null; busy?: boolean }) {
  return <section className="sl-panel" aria-label="Live drawing" data-drawing-entry={availability.code}>
    <button type="button" className="sl-btn" disabled={!availability.available || busy} onClick={start}>{busy ? 'Sending your request…' : 'Draw live in Create'}</button>
    {note ? <p role="status" data-drawing-note="">{note}</p> : availability.reason && <p role="status">{availability.reason}</p>}
    {availability.code === 'ask_turn_required' && ask && <button type="button" className="sl-btn" onClick={ask}>Ask what to draw</button>}
  </section>
}

export function DrawingModeChoice({ mode, available, steerAvailable, steerReason, change }: { mode: DrawingMode; available: boolean; steerAvailable: boolean; steerReason?: string; change(mode: DrawingMode): void }) {
  return <div className="sl-panel" data-drawing-mode={mode}>
    <div role="group" aria-label="Use my next message to">
      <button type="button" className="sl-btn" aria-pressed={mode === 'steer'} disabled={!available || !steerAvailable} onClick={() => change('steer')}>Steer</button>
      <button type="button" className="sl-btn" aria-pressed={mode === 'queue'} disabled={!available} onClick={() => change('queue')}>Queue</button>
    </div>
    <p className="sl-hint">{!available ? 'No message will be sent through this session while it is unavailable.' : mode === 'queue' ? 'Your next message waits as a new Ask turn. It has its own consent and spending checks when it starts.' : steerAvailable ? 'Your next message directs the current drawing.' : 'Steer is unavailable. You can choose Queue for separate new work.'}</p>
    {!available && <p role="status">This session is not accepting directions or queued messages here.</p>}
    {available && !steerAvailable && <p role="status">{steerReason ?? 'This hive has not offered drawing directions. Queue remains separate new work.'}</p>}
  </div>
}

/** Only the same turn's host-recorded acting_as is a named omega here. Unknown association stays unknown. */
export function DrawingIdentity({ omega, maker }: { omega: { mind_id: string; name: string } | null; maker: { id: string; name?: string | null } }) {
  const label = omega ? `${omega.name} · drawing` : 'Drawing organ'
  return <div data-drawing-organ="">
    <p className="sl-title">{label}</p>
    <p className="sl-hint">{omega ? 'The drawing organ uses a separate maker; its identity is in Raw.' : 'This record does not identify the omega for this drawing. The separate maker is identified in Raw.'}</p>
    <details><summary>Raw</summary><dl>
      {omega && <><dt>Omega ID (this Ask turn)</dt><dd>{omega.mind_id}</dd></>}
      <dt>Maker ID (host record)</dt><dd>{maker.id}</dd>
      {maker.name && <><dt>Maker name (host record)</dt><dd>{maker.name}</dd></>}
    </dl></details>
  </div>
}
