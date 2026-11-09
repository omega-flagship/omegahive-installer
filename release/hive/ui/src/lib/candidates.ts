/**
 * THE build-mode gate for unreviewed candidates (Kimi cosmos-rest r2, sharpest): one constant, one expression, imported
 * by every site that compiles candidate code in or out (registry UNREVIEWED_ALLOWED, ExperienceHost's PhaseLayer, the
 * Ask runner's parts space, the intent candidates; src/candidateOut.test.ts checks each site imports this and none
 * re-states the expression). A production build (`import.meta.env.PROD`) allows candidates only in the surface-preview
 * mode; the dev server and tests allow them. Vite replaces the env reads with literals, so this folds to `false` in a
 * release, and scripts/candidate-out.mjs (postbuild) checks the built files that the candidate code really is gone.
 */
export const CANDIDATES_ON: boolean = import.meta.env.PROD ? import.meta.env.MODE === 'surface-preview' : true
