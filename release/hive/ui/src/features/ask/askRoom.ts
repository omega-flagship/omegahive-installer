import { useScene } from '../../scene/sceneStore'

/**
 * The room the docked Ask takes above the bottom edge (CSS px): its place above the bottom safe area plus the capsule
 * and its gap (64 minimum). The measured whole floating dock includes its answerer row; Professional keeps its
 * existing 12 px gap, the other floating skins keep 8 px. Pure, and tested.
 */
export function askRoom(place: { bottom: number }, isPro: boolean, measuredHeight: number): number {
  const height = Number.isFinite(measuredHeight) ? Math.max(0, measuredHeight) : 0
  return place.bottom + Math.max(64, height + (isPro ? 12 : 8))
}

/**
 * The ONE writer of `--ask-room` (followups-r6): nothing else sets it (askRoom.r6.test scans every source file), so the
 * CSS value and the map's inset can never disagree.
 * Where that room is reported: `--ask-room` (pages pad their scroll, sheets keep their reserve, phone toasts stack above
 * it) and the hive map's scene inset `ask` (its fits keep the galaxies' names clear of the Ask, followups-r5). `null`
 * clears both: the Ask is not shown, or AskHost went away.
 */
export function setAskRoom(root: { style: Pick<CSSStyleDeclaration, 'setProperty' | 'removeProperty'> }, room: number | null): void {
  if (room === null) {
    root.style.removeProperty('--ask-room')
    useScene.getState().setInset('ask', null)
    return
  }
  root.style.setProperty('--ask-room', `${room}px`)
  useScene.getState().setInset('ask', { bottom: room })
}

/**
 * The ONE reader of `--ask-room` for code (followups-r6): the room setAskRoom last reported on this root, in CSS px; 0
 * when no Ask is shown. CSS reads the variable itself (`var(--ask-room, 0px)`).
 */
export function readAskRoom(root: { style: Pick<CSSStyleDeclaration, 'getPropertyValue'> } = document.documentElement): number {
  return parseFloat(root.style.getPropertyValue('--ask-room')) || 0
}
