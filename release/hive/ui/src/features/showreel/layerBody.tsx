/** What each layer of "how" shows for a trace (LayerStack renders it; a layer the trace lacks says so). */
import type { ReactNode } from 'react'
import { AtomGraph } from './AtomGraph'
import { Reasoning } from './pln/Reasoning'
import type { LayerKind, Trace } from './types'

const NOT_YET = 'Not available yet.'

export function layerBody(kind: LayerKind, trace: Trace): ReactNode {
  switch (kind) {
    case 'screen': {
      const s = trace.screen
      if (!s) return <p>{NOT_YET}</p>
      return (
        <dl className="sr-dl">
          <dt>Component</dt>
          <dd>
            <code>{s.component}</code>
          </dd>
          <dt>Control</dt>
          <dd>{s.control}</dd>
          <dt>What it sent</dt>
          <dd>
            <code>{s.sent}</code>
          </dd>
        </dl>
      )
    }
    case 'code':
      if (!trace.code) return <p>{NOT_YET}</p>
      return (
        <>
          <p className="sr-muted">Opening the Code app at a line is not available in the simulated hive, so here are the files and lines (read-only).</p>
          <ul className="sr-list">
            {trace.code.map((c) => (
              <li key={`${c.file}:${c.line}`}>
                <code className="sr-ref">
                  {c.file}:{c.line}
                </code>{' '}
                <span className="sr-muted">{c.symbol}</span>
                <pre className="sr-pre">
                  <span className="sr-ln">{c.line}</span> {c.excerpt}
                </pre>
              </li>
            ))}
          </ul>
        </>
      )
    case 'hive':
      if (!trace.hive) return <p>{NOT_YET}</p>
      return (
        <ul className="sr-list">
          {trace.hive.map((h) => (
            <li key={`${h.method} ${h.route}`}>
              <code>
                {h.method} {h.route}
              </code>
              <span className="sr-block">Handler: {h.handler}</span>
              <span className="sr-block">Check: {h.check}</span>
            </li>
          ))}
        </ul>
      )
    case 'mind':
      if (!trace.mind) return <p>{NOT_YET}</p>
      return (
        <>
          <dl className="sr-dl">
            <dt>Skill</dt>
            <dd>
              <code>{trace.mind.skill}</code>
            </dd>
            <dt>Loop step</dt>
            <dd>{trace.mind.loop}</dd>
          </dl>
          <pre className="sr-pre" aria-label="The MeTTa expression">
            {trace.mind.metta}
          </pre>
        </>
      )
    case 'atomspace':
      return trace.atomspace ? <AtomGraph {...trace.atomspace} /> : <p>{NOT_YET}</p>
    case 'reasoning':
      if (!trace.reasoning) return <p>{NOT_YET}</p>
      return trace.reasoning.length ? <Reasoning steps={trace.reasoning} /> : <p>No inference at this step.</p>
    case 'memory': {
      const m = trace.memory
      if (!m) return <p>{NOT_YET}</p>
      if (!m.recalled.length && !m.stored.length) return <p>Nothing recalled or stored at this step.</p>
      return (
        <>
          {m.recalled.length > 0 && (
            <>
              <p className="sr-h">Recalled</p>
              <ul className="sr-list">
                {m.recalled.map((r) => (
                  <li key={r.text}>
                    {r.text}
                    <span className="sr-block sr-muted">Why it came up: {r.why}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {m.stored.length > 0 && (
            <>
              <p className="sr-h">Stored</p>
              <ul className="sr-list">
                {m.stored.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </>
          )}
        </>
      )
    }
    case 'files':
      if (!trace.files) return <p>{NOT_YET}</p>
      if (!trace.files.length) return <p>No files changed at this step.</p>
      return (
        <ul className="sr-list">
          {trace.files.map((f) => (
            <li key={f.path}>
              <span className="sr-tag">{f.change}</span> <code>{f.path}</code> <span className="sr-muted">{f.bytes.toLocaleString('en')} bytes</span>
              {f.diff && <pre className="sr-pre">{f.diff}</pre>}
            </li>
          ))}
        </ul>
      )
  }
}

