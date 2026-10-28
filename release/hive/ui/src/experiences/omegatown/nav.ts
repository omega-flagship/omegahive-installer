import { targetFor, type Feature } from '../sdk'
import { directoryFeatureIds } from '../directory'
export { publicBlurb, publicLabel } from '../publicWords'

/** IDs of the same directory groups rendered by Town, before native scope/search narrow them. */
export const NAV_FEATURES = directoryFeatureIds()
export const toolTarget = (f: Feature) => targetFor(f)
