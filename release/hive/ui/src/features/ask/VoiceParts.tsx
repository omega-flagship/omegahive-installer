/**
 * The voice pieces every skin places in its own grammar: the opt-in sentence for the browser's speech service, a
 * voice sentence (an error, or why voice is unavailable here), the listening line with its layer named, and the
 * send-on-pause choice. Plain text only; the skin supplies the class names.
 */
import type { AskVoiceUI } from './useAskVoice'

export function VoiceNoticeView({ v, className, buttonClass }: { v: AskVoiceUI; className: string; buttonClass: string }) {
  const n = v.notice
  if (!n) return null
  if (n.kind === 'info')
    return (
      <div className={className} role="status" data-voice="info">
        <p>{n.text}</p>
      </div>
    )
  if (n.kind === 'say')
    return (
      <div className={className} role="alert" data-voice="say">
        <p>{n.text}</p>
        {n.retry && (
          <div className="ask-chips-row">
            <button type="button" className={buttonClass} data-default="" onClick={v.retry}>
              Try again
            </button>
            <button type="button" className={buttonClass} data-quiet="" onClick={v.dismiss}>
              Type instead
            </button>
          </div>
        )}
      </div>
    )
  return (
    <div className={className} role="group" aria-label="Voice through your browser’s service" data-voice="consent">
      <p>
        This browser can’t turn speech into words on this device. If you continue, your browser sends your voice to {n.vendor} to do it. The hive never receives or keeps audio, only the words you
        choose to send. You’ll be asked once in this browser.
      </p>
      <div className="ask-chips-row">
        <button type="button" className={buttonClass} data-default="" onClick={v.consent}>
          Use {n.vendor}’s service
        </button>
        <button type="button" className={buttonClass} data-quiet="" onClick={v.dismiss}>
          Not now, I’ll type
        </button>
      </div>
    </div>
  )
}

/** "Listening 0:04 · on this device" and the send-on-pause choice (the elapsed time is not read out every second). */
export function VoiceListening({ v, className, toggleClass }: { v: AskVoiceUI; className: string; toggleClass: string }) {
  if (!v.listening) return null
  return (
    <span className={className} data-voice-layer={v.layer ?? undefined}>
      <span className="ask-rec" aria-hidden />
      <span className="ask-voice-words" aria-hidden>
        {/* what matters first (the mic, where the voice goes); the clock is what a narrow line drops */}
        {v.micOn && <span className="ask-voice-mic">Mic on · </span>}
        {v.layerWords}
        <span className="ask-voice-time"> · {v.elapsed}</span>
      </span>
      <button type="button" className={toggleClass} aria-pressed={v.autoSend} onMouseDown={(e) => e.preventDefault()} onClick={() => v.setAutoSend(!v.autoSend)} aria-label="Send on pause">
        <span className="ask-voice-long">Send on pause: </span>
        <span className="ask-voice-short">Auto </span>
        {v.autoSend ? 'on' : 'off'}
      </button>
    </span>
  )
}

/** Start and stop said to screen readers. */
export function VoiceAnnouncer({ v }: { v: AskVoiceUI }) {
  return (
    <span className="sr-only" role="status" aria-live="assertive" aria-atomic="true">
      {v.announced}
    </span>
  )
}

export function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.8" fill="none" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
    </svg>
  )
}
