import { createContext, useContext, type RefCallback } from 'react'

/** A look publishes an empty native slot. Its phase renderer draws around the retained Ask through this ref,
 * never by finding, copying or reparenting the field. */
export const PhaseAnchor = createContext<RefCallback<HTMLElement> | undefined>(undefined)
export const usePhaseAnchor = () => useContext(PhaseAnchor)
