import { FEATURES } from '../../features/registry'

/**
 * Every hive feature the construct's own navigation reaches: `page <feature>` (and `open <feature>`) with Tab
 * completion over the whole registry, natively by its command where one exists (construct/features.ts NATIVE_CMD),
 * otherwise by opening the classic page over the construct. construct/nav.test.ts proves each one resolves.
 */
export const NAV_FEATURES: string[] = FEATURES.map((f) => f.id)
