/**
 * The universal Ask, from the Code canvas: send the person's words as their request (a steer when a turn is open), and
 * read the Ask's bottom band so the canvas never sits under it. The same two hooks Design's living canvas uses
 * (forms/designCanvas/DesignCanvas.tsx), kept here so Design's file is not touched.
 */
import { useCallback, useSyncExternalStore } from 'react'
import { AskRefusal, type AskContext } from '../../../api/ask'
import { bindEpoch } from '../../../lib/identityEpoch'
import type { AskAdmission } from '../../../store/ask'
import { experienceById } from '../../../experiences/registry'
import { askContext, whereOf } from '../../ask/context'
import { readAskRoom } from '../../ask/askRoom'
import { useRoute } from '../../../lib/router'
import { useLook } from '../../../shell/uiVariant'
import { useAskStore } from '../../../store/ask'

export function useAskSend() {
  const route = useRoute()
  const experience = experienceById(useLook().current?.experience).id
  return useCallback(
    (text: string) => {
      const where = whereOf(route, experience)
      const ctx = askContext(route, experience, where)
      const st = useAskStore.getState()
      st.setThreadOpen(true)
      void (st.open ? st.steer(text, ctx, { where }) : st.send(text, ctx, { where }))
    },
    [route, experience],
  )
}

/**
 * The person's words as an Ask turn, for a linkage intent to ride on (spec r3.6 §(a): an intent is recorded on the
 * person's own Ask turn). The words go through the Ask itself, so they are in the person's thread like anything else
 * they ask (a new turn, or a steer to the open one). Resolves to EXACTLY the operation the hive admitted these words
 * under, for the person who asked (store/ask `admit`); a failed, unsupported, capped or held steer, a refusal, an
 * unknown admission or a change of person rejects, and no intent is recorded. Never "whatever turn is open".
 */
export async function admittedTurn(text: string, context: AskContext, where?: string): Promise<string> {
  const binding = bindEpoch()
  const st = useAskStore.getState()
  st.setThreadOpen(true)
  const a = await st.admit(text, context, { where })
  if (!binding.current()) throw new AskRefusal(409, 'not_admitted', 'The person changed while these words were being sent; nothing was handed over.')
  if (!a.admitted) throw new AskRefusal(409, a.reason, ADMISSION_WORDS[a.reason])
  return a.op
}
const ADMISSION_WORDS: Record<Exclude<AskAdmission, { admitted: true }>['reason'], string> = {
  not_available: 'The Ask is not connected here, so your words have no turn to travel on.',
  refused: 'The Ask could not take your words just now.',
  unknown: 'It is not known yet whether the Ask received your words, so nothing was handed over.',
  held: 'The Ask is still checking that it received your last request; your words are held, and nothing was handed over.',
  unsupported: 'This hive can’t take words while the Ask is answering. Let it finish, then ask again.',
  capped: 'The Ask’s current answer has had too many changes. Let it finish, then ask again.',
  failed: 'Your words did not reach the Ask’s current answer, so nothing was handed over.',
  not_admitted: 'Your words were not taken by the Ask, so nothing was handed over.',
}

export function useAskTurn() {
  const route = useRoute()
  const experience = experienceById(useLook().current?.experience).id
  return useCallback(
    (text: string): Promise<string> => {
      const where = whereOf(route, experience)
      return admittedTurn(text, askContext(route, experience, where), where)
    },
    [route, experience],
  )
}

/** The Ask's bottom band (`--ask-room`) and whether an Ask is on screen at all. */
export function useAskRoom(): { room: number; present: boolean } {
  const read = () => {
    const root = document.documentElement
    const room = readAskRoom(root)
    return `${room}|${root.dataset.ask ? 1 : 0}`
  }
  const sig = useSyncExternalStore(
    (cb) => {
      const mo = new MutationObserver(cb)
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-ask'] })
      return () => mo.disconnect()
    },
    read,
    () => '0|0',
  )
  const [room, present] = sig.split('|')
  return { room: Number(room), present: present === '1' }
}
