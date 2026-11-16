/**
 * "What the Ask knows about you": the Ask's own memory of this person, kept only in this browser (lib/askMemory).
 * Beliefs by kind with their truth in plain words, a recent journal, edit and forget, forget everything (behind a
 * confirm). It follows the experience's chrome through the classic tokens (no palette of its own).
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ago } from '../../lib/format'
import { askMemory, KIND_TITLES, MEMORY_KINDS, useAskMemory, type Belief } from '../../lib/askMemory'
import { truthWords } from '../../lib/beliefSentence'
import { ConfirmHost } from '../../ui/confirm'
import { memoryStatus } from '../ask/words'
import { Button } from '../../ui/primitives'
import { MemoryDurability } from '../mind/MemoryDurability'
import { confirmForgetAll, editProblemWords, MEMORY_SECTION_ID, onMemoryFocus, takeMemoryFocus, traceWords } from '../ask/memoryNav'

const iso = (ms: number) => new Date(ms).toISOString()

export function BeliefRow({ b }: { b: Belief }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(b.statement)
  const [problem, setProblem] = useState<string | null>(null)
  const editBtn = useRef<HTMLButtonElement>(null)
  const wasEditing = useRef(false)
  const msgId = useId()
  // after Save or Cancel, focus goes back to this row's Edit (never lost to the page)
  useEffect(() => {
    if (wasEditing.current && !editing) editBtn.current?.focus()
    wasEditing.current = editing
  }, [editing])
  const close = () => {
    setProblem(null)
    setEditing(false)
  }
  const save = () => {
    // a refused edit keeps the editor open and says why (stand-in r1 P2)
    const why = askMemory.checkEdit(b.id, text)
    if (why) return setProblem(editProblemWords(why))
    if (!askMemory.edit(b.id, text)) return setProblem(editProblemWords('gone'))
    close()
  }
  return (
    <li className="flex flex-wrap items-start gap-2 border-t border-line py-2.5 first:border-t-0" data-belief={b.kind}>
      {editing ? (
        <form
          className="flex min-w-0 flex-1 flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          <input
            autoFocus
            value={text}
            maxLength={500}
            onChange={(e) => (setText(e.target.value), setProblem(null))}
            aria-label="What the Ask should know"
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? msgId : undefined}
            className="min-h-9 min-w-0 flex-1 rounded-lg border border-line-2 bg-shade/20 px-2 text-[14px] text-ink outline-none"
          />
          <Button type="submit" variant="primary" className="min-h-9 px-3 text-[12.5px]" disabled={!text.trim()}>
            Save
          </Button>
          <Button type="button" variant="ghost" className="min-h-9 px-3 text-[12.5px]" onClick={() => (setText(b.statement), close())}>
            Cancel
          </Button>
          {problem && (
            <p id={msgId} role="alert" className="w-full text-[12.5px] text-warn" data-edit-problem="">
              {problem}
            </p>
          )}
        </form>
      ) : (
        <>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] text-ink [overflow-wrap:anywhere]">{b.statement}</p>
            <p className="mt-0.5 text-[11.5px] text-ink-3">
              {/* uifix-r3.4 (Kimi 3): how sure on the one shared NAL scale, never confidence or frequency alone */}
              {truthWords({ f: b.truth.frequency, c: b.truth.confidence })}
              {b.uses ? ` · used ${b.uses} time${b.uses === 1 ? '' : 's'}` : ' · not used yet'} · learned {ago(iso(b.created_at))}
            </p>
          </div>
          <Button ref={editBtn} variant="ghost" className="min-h-9 px-3 text-[12.5px]" onClick={() => (setText(b.statement), setProblem(null), setEditing(true))} aria-label={`Edit: ${b.statement}`}>
            Edit
          </Button>
          <Button variant="ghost" className="min-h-9 px-3 text-[12.5px] text-ink-3" onClick={() => askMemory.forget(b.id)} aria-label={`Forget: ${b.statement}`}>
            Forget
          </Button>
        </>
      )}
    </li>
  )
}

export function MemorySection() {
  const mem = useAskMemory()
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    const take = () => {
      if (takeMemoryFocus() && ref.current) {
        ref.current.scrollIntoView({ block: 'start' })
        ref.current.focus({ preventScroll: true })
      }
    }
    take()
    // Memory pressed while this screen is already open: no new mount, so it is told
    return onMemoryFocus(take)
  }, [])
  const groups = useMemo(() => MEMORY_KINDS.map((k) => [k, mem.beliefs.filter((b) => b.kind === k).sort((a, b) => b.updated_at - a.updated_at)] as const).filter(([, list]) => list.length), [mem.beliefs])
  const recent = useMemo(() => [...mem.trace].reverse().slice(0, 8), [mem.trace])
  const learned = mem.beliefs.length
  const status = memoryStatus(mem.owner !== null, mem.hive, mem.capabilities, learned)
  return (
    <section ref={ref} id={MEMORY_SECTION_ID} tabIndex={-1} aria-labelledby="ask-memory-h" className="rounded-2xl border border-line bg-tint/[0.03] p-4 outline-none" data-hive-memory={mem.hive} data-hive-switches={mem.capabilities ? (!mem.capabilities.conductor ? 'conductor-off' : mem.capabilities.memory ? 'on' : 'off') : 'unknown'}>
      <ConfirmHost />
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 id="ask-memory-h" className="eyebrow">
            What the Ask knows about you
          </h2>
          <p className="mt-1 text-[13px] text-ink-2" data-memory-status="">
            {status}
          </p>
        </div>
        {learned > 0 && (
          <Button
            variant="danger"
            className="min-h-9 px-3 text-[12.5px]"
            onClick={() => void confirmForgetAll(learned)}
          >
            Forget everything
          </Button>
        )}
      </div>

      {!mem.ready ? (
        <p className="mt-3 text-[12.5px] text-ink-3" role="status">
          Reading this browser’s memory…
        </p>
      ) : (
        groups.map(([kind, list]) => (
          <div key={kind} className="mt-4">
            <h3 className="px-1 text-[12px] font-semibold text-ink-3">{KIND_TITLES[kind]}</h3>
            <ul className="mt-1 rounded-xl border border-line px-3">
              {list.map((b) => (
                <BeliefRow key={b.id} b={b} />
              ))}
            </ul>
          </div>
        ))
      )}

      {mem.writeFailed && <p className="mt-3 text-[12.5px] text-warn">This browser would not save the latest change; it may be gone after a reload.</p>}

      {recent.length > 0 && (
        <div className="mt-4">
          <h3 className="px-1 text-[12px] font-semibold text-ink-3">Recently</h3>
          <ol className="mt-1 space-y-1 px-1" aria-label="What changed recently">
            {recent.map((t) => (
              <li key={t.id} className="flex gap-2 text-[12.5px] text-ink-2" data-trace={t.kind}>
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{traceWords(t)}</span>
                <span className="shrink-0 text-ink-4">{ago(iso(t.at))}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <MemoryDurability />

      <div className="mt-4 flex items-center gap-2 rounded-xl border border-dashed border-line px-3 py-2.5 text-[12.5px] text-ink-3">
        <span className="min-w-0 flex-1">Cloud memory, so the Ask knows you on every device</span>
        <span className="rounded-full border border-line px-2 py-0.5 text-[11px]">Coming soon</span>
      </div>
    </section>
  )
}
