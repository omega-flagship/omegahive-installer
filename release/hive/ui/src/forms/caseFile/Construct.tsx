import { plural } from '../../lib/plural'
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import type { ProgramDescription, WorkItem } from '../../api/types'
import { bar, HELP, parseCommand, verbsFor } from './commands'
import { COVERAGE_CAVEAT, kindLabel, roleOf, type Balance, type Piece } from './model'
import { ActionSheet, CustodyChain, ExhibitMarks, ItemPanel, OriginNote, Outcomes, Proposal, StatusMarks, U } from './parts'
import type { CaseState } from './useCase'

/** Construct: the case as a terminal docket. Four panes, a cursor, single-key verbs and a command line. */

type PaneId = 'claims' | 'evidence' | 'exhibits' | 'errata'
const PANES: PaneId[] = ['claims', 'evidence', 'exhibits', 'errata']

interface Row {
  key: string
  item: string | null
  node: ReactNode
  tone?: string
}

interface Line {
  at: number
  text: string
  tone?: 'ok' | 'warn' | 'bad' | 'dim' | 'echo'
}

const TAG: Record<string, string> = { claim: 'CLM', hypothesis: 'HYP', explanation: 'EXP', assessment: 'ASM', gap: 'GAP', question: 'QST', evidence: 'EVD', source: 'SRC' }
const tag = (item: WorkItem, d: ProgramDescription | null) => TAG[roleOf(item.kind, d)] ?? item.kind.slice(0, 3).toUpperCase()
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

let lineSeq = 0
const line = (text: string, tone?: Line['tone']): Line => ({ at: ++lineSeq, text, tone })

function Gauge({ b }: { b: Balance }) {
  const max = Math.max(b.pro.weight, b.con.weight, 0.0001)
  const lean = b.empty === 'both' ? 'EMPTY' : Math.abs(b.tilt) < 0.08 ? 'LEVEL' : b.tilt > 0 ? 'FOR' : 'AGAINST'
  const sign = b.tilt > 0 ? '+' : ''
  return (
    <div className="cfx-gauge" role="img" aria-label={`Balance ${lean.toLowerCase()}: for ${plural(b.pro.count, 'piece')}, ${b.pro.independent} independent origins, weight ${b.pro.weight.toFixed(2)}; against ${plural(b.con.count, 'piece')}, ${b.con.independent} independent origins, weight ${b.con.weight.toFixed(2)}.`}>
      <div className="cfx-g-row" data-side="for">
        <span className="cfx-g-k">FOR</span>
        <span className="cfx-g-bar">{bar(b.pro.weight, max)}</span>
        <span className="cfx-g-w">{b.pro.weight.toFixed(2)}</span>
        <span className="cfx-g-n">
          {b.pro.count}pc/{b.pro.independent}orig{b.pro.unassessed ? ` ${b.pro.unassessed}unassessed` : ''}
        </span>
      </div>
      <div className="cfx-g-row" data-side="against">
        <span className="cfx-g-k">AGN</span>
        <span className="cfx-g-bar">{bar(b.con.weight, max)}</span>
        <span className="cfx-g-w">{b.con.weight.toFixed(2)}</span>
        <span className="cfx-g-n">
          {b.con.count}pc/{b.con.independent}orig{b.con.unassessed ? ` ${b.con.unassessed}unassessed` : ''}
        </span>
      </div>
      <div className="cfx-g-lean" data-lean={lean.toLowerCase()}>
        lean={lean}
        {b.empty !== 'both' && ` (${sign}${b.tilt.toFixed(2)})`}
        {b.empty === 'for' && ' · nothing FOR recorded: search gap, not refutation'}
        {b.empty === 'against' && ' · nothing AGAINST recorded: search gap, not support'}
      </div>
    </div>
  )
}

export function Construct({ cs, describe, brand = 'This app' }: { cs: CaseState; describe: ProgramDescription | null; brand?: string }) {
  const { model } = cs
  const b = cs.target ? model.balances.get(cs.target) : undefined
  const q = model.question
  const sel = cs.selected ? cs.byId.get(cs.selected) : undefined
  const [pane, setPane] = useState<PaneId>('claims')
  const [cursor, setCursor] = useState<Record<PaneId, number>>({ claims: 0, evidence: 0, exhibits: 0, errata: 0 })
  const [log, setLog] = useState<Line[]>(() => [line(`mount ${brand.toLowerCase().replace(/\s+/g, '-')}://case/${q?.id ?? '-'} rev=${model.revision}`, 'dim')])
  const [booted, setBooted] = useState(reduced)
  const [cmd, setCmd] = useState('')
  const paneRefs = useRef<Partial<Record<PaneId, HTMLDivElement | null>>>({})
  const cmdRef = useRef<HTMLInputElement>(null)
  const say = (...ls: Line[]) => setLog((l) => [...l, ...ls].slice(-40))

  useEffect(() => {
    if (booted) return
    const t = window.setTimeout(() => setBooted(true), 620)
    return () => window.clearTimeout(t)
  }, [booted])

  // ---------------------------------------------------------------- rows per pane
  const rows = useMemo<Record<PaneId, Row[]>>(() => {
    const claimRows: Row[] = [...model.weighable, ...model.explanations, ...model.assessments, ...model.gaps].map((it) => {
      const wb = model.balances.get(it.id)
      return {
        key: it.id,
        item: it.id,
        tone: it.status && it.status !== 'current' ? 'struck' : undefined,
        node: (
          <>
            <span className="cfx-tag" data-role={roleOf(it.kind, describe)}>
              {tag(it, describe)}
            </span>
            <span className="cfx-id">{it.id}</span>
            {it.id === cs.target && (
              <span className="cfx-on" title="On the balance">
                ⚖
              </span>
            )}
            <span className="cfx-label">{it.label}</span>
            <span className="cfx-meta">
              <U u={it.uncertainty} m="mono" />
              {wb && (
                <span className="cfx-pm">
                  <b data-side="for">+{wb.pro.count}</b> <b data-side="against">−{wb.con.count}</b>
                </span>
              )}
              <StatusMarks item={it} m="mono" />
              <Proposal item={it} m="mono" />
            </span>
          </>
        ),
      }
    })
    const piece = (p: Piece, sign: string): Row => ({
      key: `${p.side}-${p.item.id}`,
      item: p.item.id,
      tone: p.counted ? p.side : 'struck',
      node: (
        <>
          <span className="cfx-sign" data-side={p.side}>
            {sign}
          </span>
          <span className="cfx-id">{p.item.id}</span>
          <span className="cfx-label">{p.item.label}</span>
          <span className="cfx-meta">
            <span className="cfx-w">{p.counted ? `w=${p.weight.toFixed(2)}` : 'w=0 (not counted)'}</span>
            <U u={p.item.uncertainty} m="mono" />
            <ExhibitMarks marks={p.exhibits} exhibits={model.exhibits} m="mono" onOpen={(mk) => jumpExhibit(mk)} />
            <StatusMarks item={p.item} m="mono" />
          </span>
        </>
      ),
    })
    const evRows: Row[] = b
      ? [
          ...b.pro.pieces.map((p) => piece(p, '+')),
          ...(b.pro.pieces.length ? [] : [{ key: 'for-empty', item: null, tone: 'dim', node: <span className="cfx-label">+ (none recorded: a search gap, not evidence)</span> }]),
          ...b.con.pieces.map((p) => piece(p, '−')),
          ...(b.con.pieces.length ? [] : [{ key: 'against-empty', item: null, tone: 'dim', node: <span className="cfx-label">− (none recorded: a search gap, not evidence)</span> }]),
          ...b.qualify.map((p) => piece(p, '~')),
        ]
      : []
    const exRows: Row[] = model.exhibits.map((ex) => ({
      key: ex.key,
      item: ex.citedBy[0]?.id ?? null,
      tone: ex.sameOrigin.length ? 'shared' : undefined,
      node: (
        <>
          <span className="cfx-mark" data-custody={ex.custody}>
            Ex.{ex.mark}
          </span>
          <CustodyChain status={ex.source.status} m="mono" />
          <span className="cfx-label">{ex.source.label}</span>
          <span className="cfx-meta">
            <OriginNote ex={ex} m="mono" />
            <span className="cfx-dim">← {ex.citedBy.map((c) => c.id).join(',')}</span>
          </span>
        </>
      ),
    }))
    const erRows: Row[] = model.errata.map((e) => ({
      key: e.item.id,
      item: e.item.id,
      node: (
        <>
          <span className="cfx-er-h">
            <span className="cfx-id">{e.revision ?? '--'}</span> <span className="cfx-er-k" data-kind={e.kind}>{e.kind.toUpperCase()}</span> <span className="cfx-id">{e.item.id}</span>
          </span>
          {e.kind === 'corrected' && e.was ? (
            <>
              <span className="cfx-diff" data-d="-">- {e.was}</span>
              <span className="cfx-diff" data-d="+">+ {e.now}</span>
            </>
          ) : (
            <span className="cfx-diff" data-d="x">x {e.now}</span>
          )}
          {e.note && <span className="cfx-diff" data-d="#"># {e.note}</span>}
        </>
      ),
    }))
    return { claims: claimRows, evidence: evRows, exhibits: exRows, errata: erRows }
    // jumpExhibit only reads state setters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, b, cs.target, describe])

  const at = (p: PaneId) => Math.min(cursor[p], Math.max(0, rows[p].length - 1))
  const current = rows[pane][at(pane)]
  const currentItem = current?.item ? cs.byId.get(current.item) : undefined
  const verbs = currentItem ? verbsFor(describe, currentItem) : []

  const focusPane = (p: PaneId) => {
    setPane(p)
    paneRefs.current[p]?.focus()
  }
  function jumpExhibit(mark: string) {
    const i = model.exhibits.findIndex((e) => e.mark === mark)
    if (i < 0) return say(line(`no exhibit ${mark}`, 'bad'))
    setCursor((c) => ({ ...c, exhibits: i }))
    focusPane('exhibits')
  }
  const weigh = (id: string) => {
    if (!model.balances.has(id)) return say(line(`${id} is not a claim or hypothesis; nothing to weigh`, 'warn'))
    cs.setTarget(id)
    setCursor((c) => ({ ...c, evidence: 0 }))
    say(line(`weigh ${id}`, 'dim'))
  }
  const open = (id: string) => cs.select(id)

  // ---------------------------------------------------------------- keys
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (cs.sheet || e.metaKey || e.ctrlKey || e.altKey) return
    const t = e.target as HTMLElement
    if (t.closest('input, textarea, select, .cf-sheet')) return
    const onControl = !!t.closest('button, a')
    if (e.key === 'Escape') {
      if (sel) {
        e.preventDefault()
        cs.select(null)
        paneRefs.current[pane]?.focus()
      }
      return
    }
    if (e.key === ':' || e.key === '/') {
      e.preventDefault()
      cmdRef.current?.focus()
      return
    }
    if (e.key === '?') {
      say(...HELP.map((h) => line(h, 'dim')))
      return
    }
    if (/^[1-4]$/.test(e.key)) {
      e.preventDefault()
      focusPane(PANES[Number(e.key) - 1])
      return
    }
    const n = rows[pane].length
    if (e.key === 'j' || e.key === 'ArrowDown' || e.key === 'k' || e.key === 'ArrowUp') {
      if (onControl && e.key.startsWith('Arrow')) return
      e.preventDefault()
      const d = e.key === 'j' || e.key === 'ArrowDown' ? 1 : -1
      if (n) setCursor((c) => ({ ...c, [pane]: (Math.min(c[pane], n - 1) + d + n) % n }))
      return
    }
    if (onControl) return
    if (e.key === 'Enter' && current?.item) {
      e.preventDefault()
      if (pane === 'claims' && model.balances.has(current.item)) weigh(current.item)
      open(current.item)
      return
    }
    if (e.key === 'w' && current?.item) {
      weigh(current.item)
      return
    }
    if (e.repeat || !currentItem) return
    const v = verbs.find((x) => x.key === e.key)
    if (v) {
      e.preventDefault()
      say(line(`${v.word} ${currentItem.id}${v.gated ? '  (confirm required)' : ''}`, 'echo'))
      cs.request(v.action, [currentItem.id], true)
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const text = cmd
    setCmd('')
    if (!text.trim()) return
    const c = parseCommand(text, describe, cs.byId, currentItem?.id ?? cs.target, q?.id ?? null)
    const echo = line(`› ${text}`, 'echo')
    if (c.kind === 'error') return say(echo, line(c.message, 'bad'))
    if (c.kind === 'help') return say(echo, ...HELP.map((h) => line(h, 'dim')))
    if (c.kind === 'clear') return setLog([])
    if (c.kind === 'weigh') return (say(echo), weigh(c.id))
    if (c.kind === 'open') return (say(echo), open(c.id))
    if (c.kind === 'exhibit') return (say(echo), jumpExhibit(c.mark))
    say(echo)
    if (c.ignored.length) say(line(`ignored ${c.ignored.join(' ')}: cost and deadline are set by the program and shown in the confirm`, 'warn'))
    // a command line submit is a key press: the Enter must be released before the confirm can take a key
    cs.request(c.action, c.items, true)
  }

  // ---------------------------------------------------------------- render
  const pane$ = (p: PaneId, i: number, title: ReactNode, extra?: ReactNode) => {
    const list = rows[p]
    const cur = at(p)
    return (
      <section className="cfx-pane" data-pane={p} data-active={pane === p || undefined} style={{ ['--i' as string]: i }}>
        <h2 className="cfx-pane-t">
          <span className="cfx-pane-n">{i + 1}</span>
          {title}
          <span className="cfx-pane-c">{list.length}</span>
        </h2>
        {extra}
        <div
          ref={(el) => {
            paneRefs.current[p] = el
          }}
          className="cfx-rows"
          role="listbox"
          tabIndex={0}
          aria-label={typeof title === 'string' ? title : p}
          aria-activedescendant={list[cur] ? `cfx-${p}-${cur}` : undefined}
          onFocus={() => setPane(p)}
        >
          {list.map((r, j) => (
            <div
              key={r.key}
              id={`cfx-${p}-${j}`}
              role="option"
              aria-selected={j === cur}
              className="cfx-row"
              data-cursor={(j === cur && pane === p) || undefined}
              data-open={(r.item && r.item === cs.selected) || undefined}
              data-tone={r.tone}
              onClick={() => {
                setPane(p)
                setCursor((c) => ({ ...c, [p]: j }))
                if (r.item) {
                  if (p === 'claims' && model.balances.has(r.item)) weigh(r.item)
                  open(r.item)
                }
              }}
            >
              <span className="cfx-caret" aria-hidden="true">
                {j === cur ? '▸' : ' '}
              </span>
              {r.node}
            </div>
          ))}
          {!list.length && <div className="cfx-row" data-tone="dim">(empty)</div>}
        </div>
      </section>
    )
  }

  return (
    <div className="cfx" data-booted={booted || undefined} onKeyDown={onKey}>
      <div className="cfx-scan" aria-hidden="true" />
      <header className="cfx-bar">
        <span className="cfx-brand">
          <span className="cfx-glyph" aria-hidden="true">
            ⚖
          </span>{' '}
          {brand.toUpperCase()}
        </span>
        <span className="cfx-path">
          case/{q?.id ?? '-'} <span className="cfx-dim">rev</span> {model.revision}
        </span>
        <span className="cfx-keys" aria-hidden="true">
          1-4 pane · j/k · ⏎ open · w weigh · : cmd · ? help
        </span>
      </header>
      <div className="cfx-boot" aria-hidden="true">
        <span>mount {brand.toLowerCase().replace(/\s+/g, '-')}://case/{q?.id ?? '-'}</span> <span className="cfx-dim">…</span> <span className="cfx-ok">ok</span>
      </div>
      <div className="cfx-q">
        <span className="cfx-q-k">QUESTION {q?.id}</span>
        <h1 className="cfx-q-t">{q?.label ?? model.title}</h1>
      </div>

      <div className="cfx-grid">
        {pane$('claims', 0, 'CLAIMS')}
        {pane$(
          'evidence',
          1,
          <>
            EVIDENCE ± <span className="cfx-dim">{b ? `${tag(b.target, describe)} ${b.target.id}` : ''}</span>
          </>,
          b && (
            <div className="cfx-target">
              <div className="cfx-target-t">
                <span className="cfx-tag" data-role={roleOf(b.target.kind, describe)}>
                  {kindLabel(b.target.kind, describe).toUpperCase()}
                </span>{' '}
                {b.target.label} <U u={b.target.uncertainty} m="mono" />
              </div>
              <Gauge b={b} />
              <p className="cfx-caveat"># {COVERAGE_CAVEAT}</p>
            </div>
          ),
        )}
        {pane$('exhibits', 2, 'EXHIBITS · CUSTODY LOG')}
        {pane$('errata', 3, 'ERRATA')}
      </div>

      {sel && (
        <aside className="cfx-inspect" aria-label="Inspector">
          <ItemPanel item={sel} cs={cs} describe={describe} m="mono" onClose={() => (cs.select(null), paneRefs.current[pane]?.focus())} />
        </aside>
      )}

      <div className="cfx-foot">
        <div className="cfx-verbs" aria-live="polite">
          {currentItem ? (
            <>
              <span className="cfx-dim">{currentItem.id} ›</span>
              {model.balances.has(currentItem.id) && (
                <span>
                  <kbd>w</kbd>eigh
                </span>
              )}
              {verbs.map((v) => (
                <span key={v.key} data-gated={v.gated || undefined}>
                  <kbd>{v.key}</kbd> {v.word}
                  {v.gated && <span className="cfx-star">*</span>}
                </span>
              ))}
              {verbs.some((v) => v.gated) && <span className="cfx-dim">* confirm with full context</span>}
            </>
          ) : (
            <span className="cfx-dim">no row under the cursor</span>
          )}
        </div>
        <div className="cfx-log" role="log" aria-label="Docket log">
          {log.slice(-6).map((l) => (
            <div key={l.at} className="cfx-line" data-tone={l.tone}>
              {l.text}
            </div>
          ))}
        </div>
        <form className="cfx-cmd" onSubmit={submit}>
          <label htmlFor="cfx-cmd-in" className="cfx-prompt">
            case/{q?.id ?? '-'}›
          </label>
          <input
            id="cfx-cmd-in"
            ref={cmdRef}
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                setCmd('')
                paneRefs.current[pane]?.focus()
              }
            }}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="support c1 · dispatch scientist · weigh h2 · help"
            aria-describedby="cfx-cmd-hint"
          />
          <span id="cfx-cmd-hint" className="sr-only">
            Commands: weigh, open, ex, support, counter, qualify, challenge, dispatch scientist, ask challenger, verify, investigate, correct, help.
          </span>
        </form>
      </div>
      <Outcomes cs={cs} m="mono" />
      {cs.sheet && <ActionSheet key={cs.sheet.seq} sheet={cs.sheet} cs={cs} revision={model.revision} m="mono" className="cfx-scrim" />}
    </div>
  )
}
