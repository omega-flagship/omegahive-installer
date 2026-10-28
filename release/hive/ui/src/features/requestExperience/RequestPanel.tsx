/**
 * The "Request an experience" tile and its describe panel, in the gallery of every experience (shell/ChangeUi). Drawn
 * only in the experience's own tokens (the gallery sheet wears its chrome: .xc-dress), with no motion of its own.
 */
import { useRef } from 'react'
import { useHive } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { Button } from '../../ui/primitives'
import { useAskVoice } from '../ask/useAskVoice'
import { MicIcon, VoiceListening, VoiceNoticeView } from '../ask/VoiceParts'
import { keepRequested, keptLine, openRequest, setWords, tryWords, undoPreview, useLookStatus, useRequest } from './store'

export const MIND_WORDS = 'That needs a new experience built by a mind; that’s coming next.'
export const EXAMPLES = 'calmer, warmer, bigger text, more contrast, a teal accent, navigation at the top'

/** The tile after the built-in experiences. */
export function RequestTile({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-tour="experience-request"
      className="flex min-h-[92px] items-center gap-3 rounded-2xl border border-dashed border-line-2 bg-glass p-4 text-left text-ink transition-colors hover:border-accent motion-reduce:transition-none"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-line text-accent" aria-hidden>
        <Icon name="sparkles" size={20} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-title-sm font-semibold tracking-tight">Request an experience</span>
        <span className="mt-0.5 text-small text-ink-2">Describe the look you’d like, and see it straight away.</span>
      </span>
    </button>
  )
}

/** The tile, or the describe panel once it is opened. */
export function RequestExperience() {
  const r = useRequest()
  if (!r.open) return <RequestTile onOpen={() => openRequest(true)} />
  return <DescribePanel />
}

function DescribePanel() {
  const r = useRequest()
  // where the kept look is NOW (saved, held, absent), redrawn on every change of the looks (stand-in r1p P2)
  const keptStatus = useLookStatus(r.keptId)
  const client = useHive((s) => s.client)
  const inputRef = useRef<HTMLInputElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const submit = () => {
    if (r.words.trim()) tryWords(r.words)
  }
  const v = useAskVoice({ voiceText: setWords, valueNow: () => inputRef.current?.value ?? '', submit }, inputRef, root)
  const d = r.result
  const nothing = d && !d.looks.length
  return (
    <div ref={root} className="flex flex-col gap-3 rounded-2xl border border-accent bg-glass p-4 text-ink" role="group" aria-labelledby="request-exp-h" data-tour="experience-request-panel">
      <div className="flex items-center gap-2">
        <Icon name="sparkles" size={18} className="text-accent" />
        <h4 id="request-exp-h" className="flex-1 text-lead font-semibold">
          Request an experience
        </h4>
        <button type="button" onClick={() => openRequest(false)} className="flex size-11 items-center justify-center rounded-xl text-ink-3 hover:text-ink" aria-label="Close the request">
          <Icon name="x" size={16} />
        </button>
      </div>
      <p className="text-small text-ink-2">Describe how you’d like the hive to look and feel. For example: {EXAMPLES}.</p>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <input
          ref={inputRef}
          value={r.words}
          onChange={(e) => setWords(e.target.value)}
          onKeyDown={(e) => void v.onFieldKey(e)}
          placeholder={v.listening ? 'Speak; the words appear here' : 'Calmer and warmer, bigger text…'}
          aria-label="Describe the experience you’d like"
          className="min-h-11 min-w-0 flex-1 rounded-xl border border-control bg-glass-2 px-3 text-ink placeholder:text-ink-4"
          autoComplete="off"
          enterKeyHint="go"
          data-autofocus=""
          data-tour="experience-request-words"
        />
        <button type="button" {...v.button} aria-label={v.label} title={v.label} data-voice={v.state} className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-line text-ink-2 hover:text-ink aria-pressed:text-accent">
          <MicIcon />
        </button>
        <Button type="submit" variant="primary" disabled={!r.words.trim()} data-tour="experience-request-try">
          Show me
        </Button>
      </form>
      <VoiceListening v={v} className="flex items-center gap-2 text-meta text-ink-3" toggleClass="min-h-11 rounded-lg border border-line px-3 text-meta text-ink-2" />
      {v.notice && <VoiceNoticeView v={v} className="flex flex-col gap-2 text-small text-ink-2" buttonClass="min-h-11 rounded-lg border border-line px-3 text-ink" />}

      {d && (
        <div className="flex flex-col gap-2 text-small" role="status" data-tour="experience-request-result">
          {d.looks.length > 0 && r.previewing && (
            <div>
              <p className="text-ink">
                Previewing <b className="font-semibold">{r.previewing.prefs.variant?.name}</b>
              </p>
              <ul className="mt-1 flex flex-wrap gap-1.5" aria-label="What changed">
                {d.looks.map((l) => (
                  <li key={l.label} className="rounded-full border border-line px-2.5 py-0.5 text-meta text-ink-2">
                    {l.label}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {d.beyond.length > 0 && (
            <p className="text-ink-2" data-tour="experience-request-mind">
              “{d.beyond.join('”, “')}”: {MIND_WORDS}
              {d.looks.length > 0 ? ' The look part is on screen now, and you can keep it.' : ''}
            </p>
          )}
          {d.cannot.map((c) => (
            <p key={c.phrase} className="text-ink-2">
              {c.text}
            </p>
          ))}
          {d.unclear.length > 0 && (
            <p className="text-ink-3">
              Nothing in “{d.unclear.join('”, “')}” changes the look. Try words like {EXAMPLES}.
            </p>
          )}
          {nothing && !d.beyond.length && !d.cannot.length && !d.unclear.length && <p className="text-ink-3">Try words like {EXAMPLES}.</p>}
        </div>
      )}
      {r.error && (
        <p className="text-small text-bad" role="alert">
          Could not keep this look: {r.error}
        </p>
      )}
      {r.kept && (
        <p className="text-small text-good" role="status" data-tour="experience-request-kept">
          {keptLine(r.kept, r.keptShown, keptStatus)}
        </p>
      )}
      {r.previewing && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" icon="check" disabled={r.busy} onClick={() => void keepRequested(client)} data-tour="experience-request-keep">
            {d?.beyond.length ? 'Keep the look part' : 'Keep it'}
          </Button>
          <Button variant="ghost" icon="reset" disabled={r.busy} onClick={undoPreview} data-tour="experience-request-undo">
            Undo
          </Button>
        </div>
      )}
    </div>
  )
}
