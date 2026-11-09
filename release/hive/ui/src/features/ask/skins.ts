/**
 * The Ask's skins (UNIVERSAL_ASK_DESIGN §1.2): one headless hook, one store, one thread; each experience draws it in its
 * own grammar. A skin is only words and a look: behaviour (turns, steering, held words, reverts, confirm, keyboard,
 * screen reader) is the shared hook and store, never a fork. Pure data, tested in experiences/ask.test.ts.
 *
 *  - capsule       Classic's lavender glass capsule.
 *  - still-line    Still's ruled line (its question box on the paper is the heart).
 *  - transmission  Cosmos: a transmission console in the flight HUD; answers arrive as incoming transmissions.
 *  - liquid        Flux: a liquid capsule the fluid pours into (registered as glass with the shader).
 *  - command-line  Construct: the prompt IS the Ask; commands still parse first. When a page covers the prompt, a
 *                  floating terminal line takes over (the `terminal` look), as Still's ruled line does for its box.
 *  - note          Canvas: a note card pinned to the bottom of the view, taped to the page; answers arrive as notes.
 *
 * Every floating look is dressed from the experience's chrome tokens (experiences/chrome.ts, `--xc-*`), so each
 * experience has one material: its windows, its pages and its Ask.
 */
import type { ThreadVariant } from './Thread'

export type SkinId = 'capsule' | 'still-line' | 'transmission' | 'liquid' | 'command-line' | 'note'
/** The floating skins AskHost draws itself (Construct's own prompt is drawn by Construct). */
export type FloatingLook = 'capsule' | 'transmission' | 'liquid' | 'terminal' | 'note'

export interface SkinWords {
  /** the field's accessible name, in the same words as its placeholder (a screen reader hears what is shown) */
  label: string
  /** the resting placeholder, in the place's own voice (it must fit beside the chips on a desktop) */
  placeholder: string
  /** the same, short enough for a phone or a landscape phone (the field there is about 15 characters wide) */
  placeholderShort: string
  /** while the orchestrator works: the field stays live (steering) */
  answeringPlaceholder: string
  /** "Vega is thinking · reading Tasks" */
  step: (who: string, step: string | undefined, sending: boolean) => string
  /** the thread's grammar (Thread.tsx introduces answers in it) */
  thread: ThreadVariant
}

/** No receipt/reading claim while the native wake is still before dispatch. */
const wakeStep = (who: string, step: string | undefined, look: FloatingLook): string | null => {
  if (step === 'preparing') return ''
  if (step !== 'waking') return null
  return look === 'transmission' ? `Uplink · waking ${who}…`
    : look === 'terminal' ? `${who.toLowerCase()}@hive waking…` : `Waking ${who}…`
}
const plain = (who: string, step: string | undefined, sending: boolean) => wakeStep(who, step, 'capsule') ?? `${who} is ${sending ? 'reading your request' : `thinking · ${step ?? 'working'}`}`

export const SKIN_WORDS: Record<FloatingLook, SkinWords> = {
  capsule: {
    label: 'Ask the hive',
    placeholder: 'Ask the hive…',
    placeholderShort: 'Ask the hive…',
    answeringPlaceholder: 'Ask while it answers: pages and looks still work',
    step: plain,
    thread: 'glass',
  },
  transmission: {
    label: 'Transmit to the hive',
    placeholder: 'Transmit…',
    placeholderShort: 'Transmit…',
    answeringPlaceholder: 'Transmit to steer it…',
    step: (who, step, sending) => wakeStep(who, step, 'transmission') ?? (sending ? `Uplink · ${who} receiving` : `Receiving · ${who} · ${step ?? 'working'}`),
    thread: 'transmission',
  },
  liquid: {
    label: 'Pour in a request',
    placeholder: 'Pour in a request…',
    placeholderShort: 'Pour a request…',
    answeringPlaceholder: 'Keep pouring: it listens…',
    step: (who, step, sending) => wakeStep(who, step, 'liquid') ?? (sending ? `${who} is taking it in` : `${who} is stirring · ${step ?? 'working'}`),
    thread: 'liquid',
  },
  terminal: {
    label: 'Type a command, or just ask',
    placeholder: 'type a command, or just ask',
    placeholderShort: 'ask…',
    answeringPlaceholder: 'type to steer it…',
    step: (who, step, sending) => wakeStep(who, step, 'terminal') ?? `${who.toLowerCase()}@hive ${sending ? 'connecting' : step ?? 'working'}…`,
    thread: 'terminal',
  },
  note: {
    label: 'Write a note to the hive',
    placeholder: 'Write a note to the hive…',
    placeholderShort: 'Write a note…',
    answeringPlaceholder: 'Add a note to steer it…',
    step: (who, step, sending) => wakeStep(who, step, 'note') ?? (sending ? `${who} is reading your note` : `${who} is writing · ${step ?? 'working'}`),
    thread: 'note',
  },
}

/** The floating look AskHost draws for a skin (Still's line and Construct's own prompt are drawn elsewhere). */
export function floatingLook(skin: SkinId): FloatingLook | null {
  if (skin === 'capsule' || skin === 'transmission' || skin === 'liquid' || skin === 'note') return skin
  if (skin === 'command-line') return 'terminal'
  return null
}
