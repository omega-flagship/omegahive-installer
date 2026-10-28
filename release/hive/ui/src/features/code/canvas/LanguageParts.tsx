/**
 * The language features' small pieces on the Code canvas (phase 2): each appears in context, beside the code, and
 * recedes. Rename and completion apply only through the host confirm (DecisionDialog); everything else only reads.
 */
import { plural } from '../../../lib/plural'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { bindTo } from '../../../lib/decisionGate'
import { cx } from '../../../lib/cx'
import { DecisionDialog } from '../../../ui/DecisionDialog'
import { Icon } from '../../../ui/Icon'
import type { Location } from './language'
import type { useLanguage } from './useLanguage'

type Lang = ReturnType<typeof useLanguage>
const base = (p: string) => p.split('/').pop() ?? p
const changes = (n: number) => `${n} change${n === 1 ? '' : 's'}`

/** "What should it be called?" beside the name. */
export function RenamePrompt({ name, style, phone, busy, onSend, onClose }: { name: string; style?: CSSProperties; phone: boolean; busy: boolean; onSend: (to: string) => void; onClose: () => void }) {
  const [to, setTo] = useState(name)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => ref.current?.select(), [])
  const ok = /^[A-Za-z_]\w*$/.test(to) && to !== name
  return (
    <form
      className={cx('cc-prompt', !style && 'cc-prompt-top', phone && 'cc-prompt-phone')}
      style={style}
      aria-label={`Rename ${name}`}
      onSubmit={(e) => {
        e.preventDefault()
        if (ok && !busy) onSend(to)
      }}
    >
      <label className="cc-prompt-label" htmlFor="cc-rename-to">
        <Icon name="edit" size={14} /> Rename <code className="cc-code">{name}</code> everywhere it is used, to:
      </label>
      <input
        id="cc-rename-to"
        ref={ref}
        className="cc-input"
        value={to}
        spellCheck={false}
        autoCapitalize="off"
        onChange={(e) => setTo(e.target.value.trim())}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      />
      {to && !/^[A-Za-z_]\w*$/.test(to) && <p className="cc-prompt-note">A name is letters, digits and _, and does not start with a digit.</p>}
      <div className="cc-prompt-row">
        <span className="cc-prompt-hint">You see every change before anything is renamed.</span>
        <button type="button" className="cc-btn" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="cc-btn cc-btn-primary" disabled={!ok || busy}>
          {busy ? 'Looking…' : 'Preview'}
        </button>
      </div>
    </form>
  )
}

/** Every change a rename would make, file by file, then Rename behind the confirm. */
export function RenameCard({ lang, phone, bottom, open }: { lang: Lang; phone: boolean; bottom: number; open: (path: string) => void }) {
  const [confirming, setConfirming] = useState(false)
  const head = useRef<HTMLHeadingElement>(null)
  const r = lang.rename
  useEffect(() => head.current?.focus({ preventScroll: true }), [r?.preview.preview_id])
  if (!r) return null
  const total = r.files.reduce((n, f) => n + f.changes.length, 0)
  return (
    <aside className={cx('cc-card', phone && 'cc-card-phone')} style={phone ? { bottom: bottom + 8 } : { top: 62 }} aria-label="Rename preview">
      <h2 ref={head} tabIndex={-1} className="cc-card-head">
        <Icon name="edit" size={15} /> Rename {r.from} to {r.to}: {changes(total)} in {r.files.length} file{r.files.length === 1 ? '' : 's'}
      </h2>
      {/* every edit, exactly: each changed line before (−) and after (+), whitespace kept; nothing summarised away */}
      <ol className="cc-rename-files" aria-label="Every change">
        {r.files.map((f) => (
          <li key={f.path}>
            <details open className="cc-rename-details">
              <summary>
                <span className="cc-rename-file">{f.path}</span> · {changes(f.changes.length)}
              </summary>
              <button type="button" className="cc-rename-open" onClick={() => open(f.path)} title={`Open ${f.path}`}>
                Open {base(f.path)}
              </button>
              <ul>
                {f.changes.map((c) => (
                  <li key={`${c.line}:${c.from}`} className="cc-rename-line" data-rename-change="">
                    <span className="cc-rename-n">line {c.line}</span>
                    <pre className="cc-rename-diff">
                      <span className="cc-rename-before">− {c.before}</span>
                      {'\n'}
                      <span className="cc-rename-after">+ {c.after}</span>
                    </pre>
                  </li>
                ))}
              </ul>
            </details>
          </li>
        ))}
      </ol>
      <p className="cc-card-fine">
        <Icon name="shield" size={12} /> The language server's preview of the saved code. Nothing changes until you confirm.
      </p>
      <div className="cc-card-row">
        <button type="button" className="cc-btn" onClick={() => lang.setRename(null)}>
          Cancel
        </button>
        <button type="button" className="cc-btn cc-btn-primary" onClick={() => setConfirming(true)} disabled={lang.busy === 'apply' || !!lang.renameBlocked}>
          Rename
        </button>
      </div>
      {lang.renameBlocked && (
        <p className="cc-card-bad" role="alert">
          {lang.renameBlocked}
        </p>
      )}
      {confirming && (
        <DecisionDialog
          icon="edit"
          eyebrow="Rename"
          title={`Rename ${r.from} to ${r.to}`}
          thing="This rename"
          bound={bindTo({ preview: r.preview.preview_id }, lang.rename ? { preview: lang.rename.preview.preview_id } : undefined, ['preview'])}
          facts={[
            ['What', `${changes(total)} in ${r.files.map((f) => f.path).join(', ')} (every one is listed in the preview)`],
            ['Effect', 'One change to your copy (not the running code). Nothing is deployed.'],
            ['Preview', <span key="p" className="font-mono">{r.preview.preview_id}</span>],
            ['Bound to', `generation ${r.generation} · tree ${r.tree_digest.slice(0, 16)}…`],
          ]}
          actions={[{ label: 'Rename', busyLabel: 'Renaming', tone: 'primary', run: lang.applyRename }]}
          onClose={() => setConfirming(false)}
        />
      )}
    </aside>
  )
}

/** Completions at the caret: a list beside it; the highlighted one is previewed in the code; Enter → confirm. */
export function CompletionList({ lang, style, onDone }: { lang: Lang; style: CSSProperties; onDone: () => void }) {
  const c = lang.completion
  const list = useRef<HTMLUListElement>(null)
  const [confirming, setConfirming] = useState(false)
  const qid = c?.query.query_id
  const { choose } = lang
  useEffect(() => {
    if (!qid) return
    list.current?.focus()
    void choose(0)
  }, [qid]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!c) return null
  const close = () => {
    lang.setCompletion(null)
    onDone()
  }
  const id = (i: number) => `cc-cmp-${i}`
  return (
    <div className="cc-complete" style={style}>
      <ul
        ref={list}
        role="listbox"
        tabIndex={0}
        aria-label="Completions"
        aria-activedescendant={id(c.active)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const n = Math.max(0, Math.min(c.query.items.length - 1, c.active + (e.key === 'ArrowDown' ? 1 : -1)))
            if (n !== c.active) void lang.choose(n)
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault()
            if (c.preview && !lang.completionBlocked) setConfirming(true)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            close()
          }
        }}
      >
        {c.query.items.map((it, i) => (
          <li key={`${it.label}-${i}`} id={id(i)} role="option" aria-selected={i === c.active} onPointerDown={(e) => e.preventDefault()} onClick={() => (i === c.active && c.preview && !lang.completionBlocked ? setConfirming(true) : void lang.choose(i))}>
            <span className="cc-cmp-label">{it.label}</span>
            {it.detail && <span className="cc-cmp-detail">{it.detail}</span>}
          </li>
        ))}
      </ul>
      <p className="cc-cmp-hint">{lang.completionBlocked ?? (c.preview ? '↵ to use it (you confirm first) · Esc to close' : 'Previewing…')}</p>
      {confirming && c.preview && (
        <DecisionDialog
          icon="check"
          eyebrow="Completion"
          title={`Use “${c.preview.label}”`}
          thing="This completion"
          bound={bindTo({ preview: c.preview.id }, lang.completion?.preview ? { preview: lang.completion.preview.id } : undefined, ['preview'])}
          facts={[
            ['Where', `${c.preview.path}${c.preview.change ? `, writes “${c.preview.change.insert}”` : ''}`],
            ['Effect', 'One change to your copy (not the running code). Nothing is deployed.'],
            ['Preview', <span key="p" className="font-mono">{c.preview.id}</span>],
            ['Bound to', `generation ${c.generation} · tree ${c.tree_digest.slice(0, 16)}…`],
          ]}
          actions={[{ label: 'Use it', busyLabel: 'Writing', tone: 'primary', run: async () => (await lang.applyCompletion(), onDone(), true as const) }]}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  )
}

/** More than one definition: choose where to go. */
export function DefinitionChooser({ locations, style, onGo, onClose }: { locations: Location[]; style?: CSSProperties; onGo: (l: Location) => void; onClose: () => void }) {
  const first = useRef<HTMLButtonElement>(null)
  useEffect(() => first.current?.focus(), [])
  return (
    <div className="cc-complete" style={style} role="dialog" aria-label="Defined in more than one place" onKeyDown={(e) => e.key === 'Escape' && (e.preventDefault(), e.stopPropagation(), onClose())}>
      <p className="cc-cmp-hint">Defined in {plural(locations.length, 'place')}</p>
      <ul>
        {locations.map((l, i) => (
          <li key={`${l.path}:${l.range.start.line}`}>
            <button ref={i === 0 ? first : undefined} type="button" className="cc-def" onClick={() => onGo(l)}>
              <span className="cc-cmp-label">{base(l.path)}</span>
              <span className="cc-cmp-detail">
                {l.path} · line {l.range.start.line + 1}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
