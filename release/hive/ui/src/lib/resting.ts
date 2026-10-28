import { create } from 'zustand'

/**
 * Whether this page is resting (the idle rest: features/power/RestScreen.tsx). One source, set only by the rest host;
 * experiences read it to pause their own expensive loops (a WebGL scene, the rain, the liquid) while the rest's own,
 * much lighter scene is on screen.
 */
export const useResting = create<{ resting: boolean }>()(() => ({ resting: false }))
export const setResting = (resting: boolean) => {
  if (useResting.getState().resting !== resting) useResting.setState({ resting })
}
