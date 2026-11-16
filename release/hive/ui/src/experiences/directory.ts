import { FEATURES, GROUP_LABEL, type Feature } from './sdk'

/** The ordered groups actually rendered by both directories. Scope and search only narrow these rows. */
export const DIRECTORY: [Feature['group'], Feature[]][] = (Object.keys(GROUP_LABEL) as Feature['group'][]).map((group) => [group, FEATURES.filter((f) => f.group === group)])
export const directoryFeatureIds = (): string[] => DIRECTORY.flatMap(([, rows]) => rows.map((f) => f.id))
