/**
 * The layers of "how", all the way down (Screen › Code › Hive › Mind › AtomSpace › Reasoning › Memory › Files): a
 * generic viewer of one `Trace`. It knows nothing of where the trace came from; a synthetic one (demo mode) says so on
 * every layer, and a layer the trace does not carry says "not available yet", never inventing anything.
 */
import { layerBody } from './layerBody'
import { LAYER_NAMES, LAYERS, type LayerKind, type Trace } from './types'

export interface LayerStackProps {
  trace: Trace
  title: string
  at: LayerKind
  /** how deep it has been opened (index into LAYERS): later crumbs are still there to jump to */
  deepest: number
  onAt(k: LayerKind): void
  onDeeper(): void
  /** back up out of the layers (the demo carries on) */
  onBackUp(): void
  onClose(): void
}

export function LayerStack({ trace, title, at, deepest, onAt, onDeeper, onBackUp, onClose }: LayerStackProps) {
  const i = LAYERS.indexOf(at)
  return (
    <section className="guide-ui sr-layers" role="region" aria-label={`How it works: ${title}`} data-xc-keep-clear="">
      <header className="sr-layers-head">
        <p className="guide-eyebrow">
          <span>How it works · {title}</span>
          {trace.source === 'synthetic' && <span className="guide-badge sr-synthetic">Synthetic trace</span>}
        </p>
        <nav aria-label="Layers of how">
          <ol className="sr-crumbs">
            {LAYERS.map((k, n) => (
              <li key={k} data-seen={n <= deepest || undefined}>
                <button type="button" className="sr-crumb" aria-current={k === at ? 'step' : undefined} onClick={() => onAt(k)}>
                  {LAYER_NAMES[k]}
                </button>
              </li>
            ))}
          </ol>
        </nav>
      </header>
      <div className="sr-layer-body" data-layer={at}>
        <h3 className="sr-layer-title">
          {LAYER_NAMES[at]}
          {trace.source === 'synthetic' && <span className="sr-synthetic-inline"> · synthetic trace</span>}
        </h3>
        {layerBody(at, trace)}
      </div>
      <footer className="guide-controls">
        <button type="button" className="guide-btn" data-tone="primary" onClick={onDeeper} disabled={i >= LAYERS.length - 1}>
          {i >= LAYERS.length - 1 ? 'All the way down' : `Deeper: ${LAYER_NAMES[LAYERS[i + 1]]}`}
        </button>
        <button type="button" className="guide-btn" onClick={onBackUp}>
          Back up and carry on
        </button>
        <button type="button" className="guide-btn" data-tone="quiet" onClick={onClose}>
          Close
        </button>
      </footer>
    </section>
  )
}
