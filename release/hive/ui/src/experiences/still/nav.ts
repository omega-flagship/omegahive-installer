import { FEATURES } from '../../features/registry'

/**
 * Every hive feature Still's own navigation reaches: the intent field understands each by its name and plain words
 * (still/features.ts), and the "Everything the hive can do" passage lists them all. Features Still does natively open
 * on its paper (STILL_PLACE); the rest open their classic page over Still. still/nav.test.ts proves each one.
 */
export const NAV_FEATURES: string[] = FEATURES.map((f) => f.id)
