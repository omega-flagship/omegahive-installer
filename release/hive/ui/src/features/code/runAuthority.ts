// Purpose: what a person's run on a Code target may start, as the hive reports it, and the one rule the Code service applies to a run's argv.

/** A target's `run` (hive/core/code.py `_run_authority`): what a person's run may start, decided as the relay decides. */
export interface RunAuthority {
  available: boolean
  /** Completes "No command can run here: …" when nothing may run. */
  why_not: string | null
  /** The command prefixes the run capability carries; a run's argv must begin with one of them. */
  argv_prefixes: string[][]
}

/** What the page may offer: nothing (and why), or the granted prefixes and the one command a single Test click runs. */
export type RunOffer = { ok: false; why: string } | { ok: true; prefixes: string[][]; test: string[] | null }

/** The Code service's rule (OmegaCode auth.py): an argv may start when it begins with one granted prefix. */
export function permits(prefixes: readonly (readonly string[])[], argv: readonly string[]): boolean {
  return prefixes.some((p) => p.length > 0 && p.length <= argv.length && p.every((word, i) => argv[i] === word))
}

const UNSAID = 'this hive does not say which commands may run'
const isWords = (p: unknown): p is string[] => Array.isArray(p) && p.length > 0 && p.every((a) => typeof a === 'string' && a.length > 0)
const pythonFile = (p: readonly string[]) =>
  p.length === 2 && /^python/.test(p[0].split('/').pop() ?? '') && p[1].endsWith('.py') && !p[1].startsWith('-')

/**
 * The page's offer from a target's `run`. A single Test click never guesses a command: it runs the one granted prefix
 * when exactly one is granted, else the one plain `python <file>.py` prefix among several, as the host picks a mind's
 * default test command (modules/code code_proposal.py simple_run_command); otherwise none, and the person picks one
 * in the drawer's Tests. A hive that does not report `run`, or reports it malformed, offers nothing.
 */
export function runOffer(run: RunAuthority | undefined): RunOffer {
  const r: unknown = run
  if (!r || typeof r !== 'object') return { ok: false, why: UNSAID }
  const { available, why_not, argv_prefixes } = r as Record<string, unknown>
  if (typeof available !== 'boolean' || !Array.isArray(argv_prefixes) || !argv_prefixes.every(isWords)) return { ok: false, why: UNSAID }
  if (!available || !argv_prefixes.length)
    return { ok: false, why: (typeof why_not === 'string' && why_not.trim()) || 'no command is allowed for it' }
  const plain = argv_prefixes.filter(pythonFile)
  const test = argv_prefixes.length === 1 ? argv_prefixes[0] : plain.length === 1 ? plain[0] : null
  return { ok: true, prefixes: argv_prefixes, test }
}

/** Why this argv may not start here, in plain words, or null when the offer permits it (no argv: whether anything may). */
export function runRefusal(offer: RunOffer, argv?: readonly string[]): string | null {
  if (!offer.ok) return `No command can run here: ${offer.why}.`
  if (argv && !permits(offer.prefixes, argv)) return 'This command does not begin with an allowed command, so it would be refused.'
  return null
}
