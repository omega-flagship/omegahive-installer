import { healthCheck } from '../../lib/healthQuestion'
import { HealthCheckLabel } from '../../ui/HealthCheckLabel'
import { AnimatePresence, m } from 'framer-motion'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useDraft } from '../../experiences/drafts'
import { useStickToBottom } from '../../lib/stickToBottom'
import { NewBelow } from '../../ui/NewBelow'
import type { Agent, Message } from '../../api/types'
import { hsl } from '../../lib/color'
import { clockTime } from '../../lib/format'
import { useReducedMotion } from '../../lib/hooks'
import { navigate } from '../../lib/router'
import { useHive, type PendingMessage } from '../../store/store'
import { Icon } from '../../ui/Icon'
import { Disclosure } from '../../ui/Disclosure'
import { MemberSteps } from '../harness/InviteSteps'
import { plainPieces } from '../../lib/beliefSentence'
import { refPieces, type RefPiece } from '../../lib/artifactRefs'
import { ErrorState, Orb, Skeleton } from '../../ui/primitives'
import { cx } from '../../lib/cx'
import { shown } from '../../lib/displayName'
import { chatPerson, type PeopleNames } from '../../lib/personNames'
import { useMe } from '../../lib/useAdmin'
import { useResource } from '../../lib/useResource'
import { guardComposing } from '../ask/keys'
import { useFocusMessage } from '../messages/CoffeeParts'
import { lastMentions } from '../views/mentions'
import { MessageViews } from '../views/MessageViews'
import { Words } from '../views/Words'
import { useMindInUse } from '../ask/mindInUse'
import { useAbout, withAbout } from './chatAbout'

const SUGGESTIONS = ['What do you believe most?', 'What are you working on?', 'Why did the commons change?']

const EMPTY: Message[] = []
const EMPTY_P: PendingMessage[] = []

/** A mind's chat; `focus`, a message's id (a link from an activity line, #/dot/<mind>?m=<id>), opens it at that message. */
export function Chat({ agent, focus, connectAsked = 0 }: { agent: Agent; focus?: string; /** how often the panel asked for an outside member's connect steps */ connectAsked?: number }) {
  useMindInUse(agent.id)   // an Ask made while this chat is open answers as this mind (Jon, 16 Nov)
  const id = agent.id
  const messages = useHive((s) => s.messages[id] ?? EMPTY)
  const pending = useHive((s) => s.pending[id] ?? EMPTY_P)
  const loaded = useHive((s) => !!s.messagesLoaded[id])
  const thinking = useHive((s) => s.thinking[id])
  const fresh = useHive((s) => s.freshMessages)
  const agents = useHive((s) => s.agents)
  const loadMessages = useHive((s) => s.loadMessages)
  const send = useHive((s) => s.sendMessage)
  const retry = useHive((s) => s.retryMessage)
  const dismiss = useHive((s) => s.dismissPending)
  const [err, setErr] = useState<string | null>(null)
  // unsent words outlive the tab: opening Model (Budget), Memory or any other tab and coming back keeps them
  const [text, setText] = useDraft(`dot:chat:${id}`)
  // an artifact brought here by the Artifacts page's Ask button rides with the next message (chatAbout)
  const [about, dropAbout] = useAbout(id)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    loadMessages(id).catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Could not load messages'))
  }, [id, loadMessages])

  // the views the mind's messages name: each drawn under the last message naming it (features/views)
  const views = useMemo(() => lastMentions(messages), [messages])

  // which conversations are with peers (so replies can be labelled)
  const peers = useMemo(() => {
    const m = new Map<string, string>()
    for (const x of messages) if (x.direction === 'in' && x.sender.startsWith('agent:') && x.sender !== `agent:${id}`) m.set(x.conversation_id, x.sender.slice(6))
    return m
  }, [messages, id])

  // whose words are whose (followups r4): "You" is the viewer's own principal only; another person (an admin's audit, or
  // the loopback operator's whole stream) by name. The people list is read once, and only when someone else is here.
  const { me, admin, failed: meFailed } = useMe()
  const client = useHive((s) => s.client)
  const mine = me?.principal
  const othersHere = useMemo(() => messages.some((x) => x.direction === 'in' && x.sender.startsWith('user:') && x.sender !== mine && x.sender !== 'user:operator'), [messages, mine])
  const wantPeople = admin && othersHere && !!client?.listPeople
  const people = useResource(() => (wantPeople && client?.listPeople ? client.listPeople().then((r) => r.people) : Promise.resolve(null)), { key: String(wantPeople), isEmpty: () => false })
  const names: PeopleNames = { me: me ?? null, people: people.status === 'ready' ? (people.data ?? null) : null }

  const busy = thinking === 'llm' || thinking === 'skills'

  // follows new and streamed words only while the reader is at the end; scrolled up, their place holds (lib/stickToBottom)
  const { box: logBox, content: logContent, handlers: logHandlers, unseen: logUnseen, toEnd: logToEnd } = useStickToBottom([messages.length, pending.length, busy, loaded])
  useFocusMessage(focus, loaded && messages.some((m) => m.id === focus))

  const submit = (value = text) => {
    const v = value.trim()
    if (!v) return
    setText('')
    logToEnd()
    dropAbout()
    send(id, withAbout(v, about))
    requestAnimationFrame(() => taRef.current?.focus())
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !guardComposing(e)) {
      e.preventDefault()
      submit()
    }
  }

  // autosize
  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = '0px'
    ta.style.height = `${Math.min(140, ta.scrollHeight)}px`
  }, [text])

  const sleeping = agent.status !== 'awake' && agent.status !== 'starting'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <MeNotice show={meFailed && messages.some((x) => x.direction === 'in' && x.sender.startsWith('user:'))} />
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={logBox} {...logHandlers} tabIndex={-1} data-mind-chat-log="" className="thin-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3 outline-none" aria-live="polite" aria-label={`Conversation with ${shown(agent.name)}`}>
        <div ref={logContent}>
        {err && !messages.length ? (
          <ErrorState title="Could not load the conversation" body={err} onRetry={() => loadMessages(id).then(() => setErr(null), () => undefined)} />
        ) : !loaded && !messages.length ? (
          <div className="space-y-3 pt-2">
            <Skeleton className="h-12 w-3/4" />
            <Skeleton className="ml-auto h-9 w-1/2" />
            <Skeleton className="h-16 w-4/5" />
          </div>
        ) : !messages.length && !pending.length ? (
          <div className="flex flex-col items-center py-8 text-center">
            <Orb hue={agent.hue} status={agent.status} size={56} />
            <div className="mt-4 font-display text-[17px] font-semibold">Say hello to {shown(agent.name)}</div>
            <p className="mt-1 max-w-[260px] text-sm text-ink-3">Replies stream in live. Try one of these:</p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => submit(s)} className="min-h-10 rounded-full border border-line bg-tint/[0.04] px-3.5 text-[13px] text-ink-2 hover:border-line-2 hover:text-ink">
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ol className="space-y-2.5">
            {messages.map((m, i) => {
              const prev = messages[i - 1]
              const grouped = prev && prev.sender === m.sender && healthCheck(prev) === healthCheck(m) && Date.parse(m.created_at) - Date.parse(prev.created_at) < 120_000
              return (
                <Bubble
                  key={m.id}
                  m={m}
                  views={views.get(m.id)}
                  agent={agent}
                  grouped={!!grouped}
                  fresh={!!fresh[m.id]}
                  peerId={m.direction === 'in' && m.sender.startsWith('agent:') ? m.sender.slice(6) : m.direction === 'out' ? peers.get(m.conversation_id) : undefined}
                  peerName={(pid) => agents[pid]?.name ?? 'a mind'}
                  peerHue={(pid) => agents[pid]?.hue ?? 240}
                  person={m.direction === 'in' && m.sender.startsWith('user:') ? chatPerson(m.sender, names) : undefined}
                />
              )
            })}
            {pending.map((p) => (
              <li key={p.tempId} className="flex flex-col items-end">
                <m.div
                  initial={{ opacity: 0, y: 8, scale: 0.97 }}
                  animate={{ opacity: p.status === 'sending' ? 0.7 : 1, y: 0, scale: 1 }}
                  className={cx('max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-2 text-[14px] leading-relaxed', p.status === 'failed' ? 'border border-bad/40 bg-bad/10' : 'bg-tint/[0.1]')}
                >
                  {p.text}
                </m.div>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-3">
                  {p.status === 'sending' ? (
                    'Sending…'
                  ) : (
                    <>
                      <span className="text-bad">Not delivered{p.error ? `: ${p.error}` : ''}</span>
                      <button onClick={() => retry(id, p.tempId)} className="min-h-8 px-1 font-medium text-ink underline-offset-2 hover:underline">
                        Retry
                      </button>
                      <button onClick={() => dismiss(id, p.tempId)} className="min-h-8 px-1 text-ink-3 hover:text-ink">
                        Discard
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
            <AnimatePresence>
              {busy && (
                <m.li
                  key="typing"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="flex items-center gap-2 text-[12px] text-ink-3"
                  aria-label={`${shown(agent.name)} is ${thinking === 'llm' ? 'thinking' : 'using skills'}`}
                >
                  <Orb hue={agent.hue} size={18} thinking={thinking} />
                  <span className="flex gap-1">
                    {[0, 1, 2].map((i) => (
                      <m.span
                        key={i}
                        className="size-1.5 rounded-full"
                        style={{ background: hsl(agent.hue, 100, 75) }}
                        animate={{ opacity: [0.25, 1, 0.25], y: [0, -2, 0] }}
                        transition={{ duration: 1, repeat: Infinity, delay: i * 0.15 }}
                      />
                    ))}
                  </span>
                  {thinking === 'llm' ? 'thinking' : 'using skills'}
                </m.li>
              )}
            </AnimatePresence>
          </ol>
        )}
        </div>
      </div>
      <NewBelow show={logUnseen} onClick={logToEnd} className="absolute bottom-2 left-1/2 min-h-9 -translate-x-1/2 rounded-full border border-line-2 bg-float/95 px-3.5 text-[12.5px] font-medium text-float-ink shadow-lg backdrop-blur hover:border-ink-3" />
      </div>

      {/* an outside member is run by a program elsewhere: no start or wake reaches it, so say what its messages wait for and
          how it connects; this block shrinks and scrolls when the panel is short, so the composer below always stays */}
      {agent.kind === 'module' && (
        <div className="thin-scroll max-h-[45dvh] min-h-0 shrink overflow-y-auto border-t border-line px-4 pt-2" data-outside-member="">
          {sleeping && (
            <p className="flex items-center gap-1.5 text-[12px] text-ink-3">
              <Icon name="plug" size={14} />
              {`${shown(agent.name)} runs outside this hive; messages wait until the program it runs in connects with its token.`}
            </p>
          )}
          <Disclosure key={connectAsked} defaultOpen={connectAsked > 0 || (sleeping && !messages.some((x) => x.direction === 'out'))} title={<span className="text-[12px] font-medium text-ink-2">How {shown(agent.name)} connects</span>}>
            <div className="pb-2">
              <MemberSteps name={agent.name} />
            </div>
          </Disclosure>
        </div>
      )}
      <form
        data-tour="chat-composer"
        className="shrink-0 border-t border-line px-3 pt-2.5 pb-3"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        {sleeping && agent.kind !== 'module' && (
          <p className="mb-2 flex items-center gap-1.5 px-1 text-[12px] text-ink-3">
            <Icon name="moon" size={14} />
            {agent.status === 'asleep' ? `${shown(agent.name)} is asleep; a message will wake it.` : `${shown(agent.name)} is ${agent.status}; messages wait in the queue.`}
          </p>
        )}
        {about && (
          <div className="mb-2 flex px-1" data-chat-about={about.id}>
            <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-line-2 bg-tint/[0.06] py-0.5 pr-0.5 pl-1.5 text-[12.5px] font-medium text-ink">
              <Icon name="layers" size={13} className="shrink-0 opacity-70" />
              <span className="truncate">{about.title || 'An artifact'}</span>
              <button type="button" onClick={dropAbout} aria-label={`Don't send ${about.title || 'the artifact'} with this message`} className="flex size-6 shrink-0 items-center justify-center rounded text-ink-3 hover:text-ink">
                <Icon name="x" size={12} />
              </button>
            </span>
          </div>
        )}
        <div className="flex items-end gap-2 rounded-2xl border border-line bg-shade/25 p-1.5 pl-3.5 transition-colors focus-within:border-line-2">
          <label htmlFor={`compose-${id}`} className="sr-only">
            Message {shown(agent.name)}
          </label>
          <textarea
            id={`compose-${id}`}
            ref={taRef}
            data-autofocus
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            placeholder={about ? `Ask ${shown(agent.name)} about ${about.title || 'it'}…` : `Message ${shown(agent.name)}…`}
            className="max-h-36 min-h-9 flex-1 resize-none bg-transparent py-2 text-[14px] leading-snug text-ink outline-none placeholder:text-ink-4"
          />
          <m.button
            type="submit"
            whileTap={{ scale: 0.9 }}
            disabled={!text.trim()}
            className="flex size-11 shrink-0 items-center justify-center rounded-xl text-primary-ink transition-opacity disabled:opacity-30"
            style={{ background: `linear-gradient(180deg, ${hsl(agent.hue, 100, 84)}, ${hsl(agent.hue, 90, 68)})`, boxShadow: `0 6px 22px -6px ${hsl(agent.hue, 100, 60, 0.7)}` }}
            aria-label="Send message"
          >
            <Icon name="send" size={18} strokeWidth={2.2} />
          </m.button>
        </div>
      </form>
    </div>
  )
}

export function Bubble({
  m: msg,
  agent,
  grouped,
  fresh,
  peerId,
  peerName,
  peerHue,
  person,
  views,
}: {
  m: Message
  agent: Agent
  grouped: boolean
  fresh: boolean
  peerId?: string
  peerName: (id: string) => string
  peerHue: (id: string) => number
  /** a person's message: who it is from, and whether it is the viewer's own */
  person?: { label: string; mine: boolean }
  /** artifact ids this message is the last to name: their views are drawn under it */
  views?: string[]
}) {
  const reduced = useReducedMotion()
  const fromPeer = msg.direction === 'in' && !!peerId
  // the hive's own note to the mind (sender hive:…, such as First Light asking it to say hello to its person): an
  // instruction to the mind, never its words, so it is drawn as the hive's, folded, and the conversation reads as it
  // went; a health check keeps its own label below
  if (msg.direction === 'in' && msg.sender.startsWith('hive:') && !healthCheck(msg)) {
    return (
      <m.li initial={fresh ? { opacity: 0, y: 8 } : false} animate={{ opacity: 1, y: 0 }} className="flex justify-center" data-chat-sender="hive">
        <details className="max-w-[85%] text-[12px] text-ink-3">
          <summary className="cursor-pointer text-center select-none hover:text-ink-2">A note from the hive to {shown(agent.name)} · {clockTime(msg.created_at)}</summary>
          <p className="mt-1 rounded-xl border border-line px-3 py-2 whitespace-pre-wrap text-ink-2"><Words text={msg.text} /></p>
        </details>
      </m.li>
    )
  }
  if (person) {
    return (
      <m.li id={`msg-${msg.id}`} tabIndex={-1} initial={fresh ? { opacity: 0, y: 8 } : false} animate={{ opacity: 1, y: 0 }} className={cx('flex flex-col rounded-2xl outline-none', person.mine ? 'items-end' : 'items-start')} data-chat-sender={person.label}>
        {!grouped && !person.mine && <span className="mb-1 text-[11px] font-medium text-ink-2">{person.label}</span>}
        <div className={cx('max-w-[85%] rounded-2xl px-3.5 py-2 text-[14px] leading-relaxed text-ink', person.mine ? 'rounded-br-md bg-tint/[0.1]' : 'rounded-bl-md border border-line bg-tint/[0.04]')}><Words text={msg.text} /></div>
        {!grouped && <time className="mt-1 text-[10px] text-ink-4">{person.mine ? `${person.label} · ` : ''}{clockTime(msg.created_at)}</time>}
      </m.li>
    )
  }
  const hue = fromPeer && peerId ? peerHue(peerId) : agent.hue
  return (
    <m.li id={`msg-${msg.id}`} tabIndex={-1} initial={fresh ? { opacity: 0, y: 8 } : false} animate={{ opacity: 1, y: 0 }} className="flex gap-2.5 rounded-2xl outline-none">
      <div className="w-6 shrink-0 pt-1">{!grouped && <Orb hue={hue} size={22} status="awake" />}</div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="mb-1 flex items-baseline gap-2 text-[11px]">
            {fromPeer && peerId ? (
              <button onClick={() => navigate({ name: 'dot', id: peerId })} className="font-medium text-ink-2 hover:text-ink">
                {peerName(peerId)} <span className="text-ink-4">→ {shown(agent.name)}</span>
              </button>
            ) : healthCheck(msg) ? (
              <HealthCheckLabel />
            ) : (
              <span className="font-medium text-ink-2">
                {shown(agent.name)}
                {peerId && <span className="text-ink-4"> → {peerName(peerId)}</span>}
              </span>
            )}
            <time className="text-ink-4">{clockTime(msg.created_at)}</time>
          </div>
        )}
        <div
          className={cx('inline-block max-w-full rounded-2xl rounded-tl-md px-3.5 py-2 text-[14px] leading-relaxed', fromPeer || peerId ? 'text-ink-2' : 'text-ink')}
          style={{
            background: `linear-gradient(180deg, ${hsl(hue, 70, 50, fromPeer || peerId ? 0.08 : 0.14)}, ${hsl(hue, 70, 40, 0.06)})`,
            border: `1px solid ${hsl(hue, 80, 70, 0.16)}`,
          }}
        >
          {fresh && !reduced && msg.direction === 'out' ? <Streamed text={msg.text} /> : <Words text={msg.text} />}
        </div>
        {views && views.length > 0 && <MessageViews ids={views} />}
      </div>
    </m.li>
  )
}

/** Progressive reveal for replies that arrive while you watch. */
function Streamed({ text }: { text: string }) {
  // the words that stream in are already plain (uifix-r3): notation never flashes up mid-reply, and an artifact id
  // streams in as its chip, never as the id
  const words = useMemo(() => streamWords(text), [text])
  const [n, setN] = useState(0)
  const done = n >= words.length
  // two words a step, and no timer left once the whole reply is in
  useEffect(() => {
    if (done) return
    const t = setTimeout(() => setN(n + 2), Math.max(12, Math.min(45, 1400 / words.length)))
    return () => clearTimeout(t)
  }, [n, done, words.length])
  // the words so far, each artifact id whole, drawn as every look draws words (no "as written" until the reply is in),
  // then the reply as it was said, by the same Words, so a chip drawn while it streamed stays as it is
  return (
    <span>
      <Words text={done ? text : words.slice(0, n).map((w) => (typeof w === 'string' ? w : w.ref)).join('')} written={done ? undefined : false} />
      {!done && <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse rounded-sm bg-ink/70" />}
    </span>
  )
}

/** A reply's words to stream: each piece said plainly (plainPieces) and cut at its spaces, an artifact id one step. */
function streamWords(text: string): (string | { ref: string })[] {
  return plainPieces(text).flatMap((p): RefPiece[] => (p.raw === undefined ? refPieces(p.t) : [{ text: p.t }]))
    .flatMap((r): (string | { ref: string })[] => (r.ref === undefined ? r.text.split(/(\s+)/) : [{ ref: r.ref }]))
}

/**
 * followups-r5 (Kimi r4): when /me failed, no person message can be told apart as the viewer's own, so every one is
 * labelled by name or principal. A quiet line says the labels are degraded, rather than letting them pass as correct.
 */
export function MeNotice({ show }: { show: boolean }) {
  if (!show) return null
  return (
    <p data-me-failed="" role="status" className="border-b border-line px-4 py-1.5 text-[12px] text-ink-3">
      Couldn’t load who you are, so your own messages aren’t marked as yours.
    </p>
  )
}
