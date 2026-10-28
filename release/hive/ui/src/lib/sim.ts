import { useHive } from '../store/store'

export const SIM_COST_NOTE = 'Costs here are simulated: made-up token counts × list prices. No model was called and nothing was charged.'

/** True in sim and demo mode, where every dollar figure is made up. */
export const useSim = () => useHive((s) => s.client?.mode === 'sim')
