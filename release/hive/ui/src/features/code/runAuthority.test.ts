import { describe, expect, it } from 'vitest'
import { permits, runOffer, runRefusal, type RunAuthority } from './runAuthority'

const PY = '/opt/omegahive/venv/bin/python'
const granted = (argv_prefixes: string[][]): RunAuthority => ({ available: true, why_not: null, argv_prefixes })

describe('permits: the Code service rule, argv[:len(p)] == p for one granted p (OmegaCode auth.py)', () => {
  const prefixes = [[PY, 'check_app.py'], ['python3', '-m', 'pytest']]
  it.each([
    [[PY, 'check_app.py'], true],
    [[PY, 'check_app.py', '--fast'], true],
    [['python3', '-m', 'pytest', '-q'], true],
    [['python3', '-m'], false],                  // shorter than every prefix
    [[PY, 'other.py'], false],
    [['python3', '-m', 'pytest-x'], false],      // words compare whole, never as text prefixes
    [['sh', '-c', 'python3 -m pytest'], false],
    [[], false],
  ])('%j is %s', (argv, ok) => expect(permits(prefixes, argv)).toBe(ok))
  it('permits nothing when nothing is granted, and never by an empty prefix', () => {
    expect(permits([], ['python3'])).toBe(false)
    expect(permits([[]], ['python3'])).toBe(false)
  })
})

describe('runOffer: what the page may offer from a target’s run', () => {
  it('offers nothing, with the hive’s own reason, when no command may run', () => {
    expect(runOffer({ available: false, why_not: 'the hive’s operator has allowed no commands for this repository', argv_prefixes: [] }))
      .toEqual({ ok: false, why: 'the hive’s operator has allowed no commands for this repository' })
  })
  it('fails closed on an absent or malformed report', () => {
    for (const run of [undefined, null, 7, {}, { available: 'yes', argv_prefixes: [] }, { available: true, argv_prefixes: [['']] },
      { available: true, argv_prefixes: [[]] }, { available: true, argv_prefixes: [[1]] }, { available: true, argv_prefixes: 'python3' }])
      expect(runOffer(run as unknown as RunAuthority)).toEqual({ ok: false, why: 'this hive does not say which commands may run' })
    expect(runOffer({ available: true, why_not: null, argv_prefixes: [] })).toEqual({ ok: false, why: 'no command is allowed for it' })
  })
  it('runs the one granted prefix on Test, whatever command it is', () => {
    expect(runOffer(granted([[PY, 'check_app.py']]))).toEqual({ ok: true, prefixes: [[PY, 'check_app.py']], test: [PY, 'check_app.py'] })
    expect(runOffer(granted([['make', 'check']]))).toMatchObject({ ok: true, test: ['make', 'check'] })
  })
  it('among several, picks the one plain python file command, as the host picks a mind’s default', () => {
    expect(runOffer(granted([[PY, '-m', 'unittest'], [PY, 'check_app.py']]))).toMatchObject({ ok: true, test: [PY, 'check_app.py'] })
    expect(runOffer(granted([['python3', 'a.py'], ['make', 'check']]))).toMatchObject({ ok: true, test: ['python3', 'a.py'] })
  })
  it('guesses nothing when several commands could be the tests', () => {
    expect(runOffer(granted([[PY, 'a.py'], [PY, 'b.py']]))).toMatchObject({ ok: true, test: null })
    expect(runOffer(granted([['make', 'check'], ['npm', 'test']]))).toMatchObject({ ok: true, test: null })
    expect(runOffer(granted([[PY, '-a.py'], ['make']]))).toMatchObject({ ok: true, test: null })
  })
})

describe('runRefusal: one wording for every run starter', () => {
  const none = runOffer({ available: false, why_not: 'the Code service here takes proposals only, so it runs no commands', argv_prefixes: [] })
  it('says why nothing may run, whatever the argv', () => {
    expect(runRefusal(none)).toBe('No command can run here: the Code service here takes proposals only, so it runs no commands.')
    expect(runRefusal(none, [PY, 'check_app.py'])).toBe(runRefusal(none))
  })
  it('refuses an argv outside the grant and passes one inside it', () => {
    const one = runOffer(granted([[PY, 'check_app.py']]))
    expect(runRefusal(one)).toBeNull()
    expect(runRefusal(one, [PY, 'check_app.py', '-v'])).toBeNull()
    expect(runRefusal(one, ['python3', '-m', 'pytest', '-q'])).toBe('This command does not begin with an allowed command, so it would be refused.')
  })
})
