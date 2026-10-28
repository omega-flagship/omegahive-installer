/**
 * The MeTTa this space runs, in load order: the hive's own lib_nal, lib_pln and lib_hive (vendored byte-for-byte,
 * pinned in metta/PIN.json), then lib_mind (this package's schema and laws, written on top of them).
 */
import libNal from './metta/lib_nal.metta?raw'
import libPln from './metta/lib_pln.metta?raw'
import libHive from './metta/lib_hive.metta?raw'
import libMind from './metta/lib_mind.metta?raw'

export const MIND_SOURCES: readonly (readonly [string, string])[] = [
  ['lib_nal', libNal],
  ['lib_pln', libPln],
  ['lib_hive', libHive],
  ['lib_mind', libMind],
]
