import { describe, expect, it } from 'vitest'
import { asWritten, beliefLine, beliefTopic, expectation, hasNotation, NO_EVIDENCE, NO_EVIDENCE_C, plainPieces, plainText, RAW_NOTATION, sayBelief, sureness, SURENESS_WORD, truthNumbers, truthPhrase, truthWords } from './beliefSentence'

/**
 * uifix-r3 (UI review 2026-10-12 S3, a11y-07): the one belief-to-sentence helper, table-driven over every notation form
 * the simulator and fixtures use, plus forms it must NOT read (they get "A belief about …", never a guessed sentence).
 */

// [statement, sentence]: every form in api/sim and the test fixtures
const KNOWN: [string, string][] = [
  ['(--> vega star)', 'Vega is a star.'],
  ['(--> star vega)', 'Star is a vega.'],
  ['(--> vega luminous)', 'Vega is luminous.'],
  ['(--> vega pole-on)', 'Vega is ‘pole-on’.'],
  ['(--> vega pulsar)', 'Vega is a pulsar.'],
  ['(--> vega dust-disk-host)', 'Vega is ‘dust-disk-host’.'],
  ['(--> vega-star related)', '‘vega-star’ is related.'],
  ['(--> altair fast-rotator)', 'Altair is ‘fast-rotator’.'],
  ['(--> deneb supergiant)', 'Deneb is a supergiant.'],
  ['(--> sheliak binary)', 'Sheliak is binary.'],
  ['(--> rr-lyrae variable)', '‘rr-lyrae’ is variable.'],
  ['(--> ring-nebula planetary)', '‘ring-nebula’ is planetary.'],
  ['(--> m57 ring-observed)', 'M57 is ‘ring-observed’.'],
  ['(--> epsilon-lyrae double-double)', '‘epsilon-lyrae’ is ‘double-double’.'],
  ['(--> kic-8462 dimming-anomaly)', '‘kic-8462’ is ‘dimming-anomaly’.'],
  ['(--> invented-unmapped star)', '‘invented-unmapped’ is a star.'],
  ['(--> budget-burn on-track)', '‘budget-burn’ is ‘on-track’.'],
  ['(--> build-main green)', '‘build-main’ is green.'],
  ['(--> cache-hit-rate high)', '‘cache-hit-rate’ is high.'],
  ['(--> disk-node-3 degraded)', '‘disk-node-3’ is degraded.'],
  ['(--> gateway healthy)', 'Gateway is healthy.'],
  ['(--> llm-latency p95-elevated)', '‘llm-latency’ is ‘p95-elevated’.'],
  ['(--> nightly-deploy safe)', '‘nightly-deploy’ is safe.'],
  ['(--> queue-backlog low)', '‘queue-backlog’ is low.'],
  ['(--> capped glow)', 'Capped is a glow.'],
  ['(--> lumen glow)', 'Lumen is a glow.'],
  ['(--> murmur glow)', 'Murmur is a glow.'],
  ['(--> rumour heard)', 'Rumour is heard.'],
  ['(--> crab urchin-larva-eater)', 'Crab is ‘urchin-larva-eater’.'],
  ['(--> holdfast habitat)', 'Holdfast is a habitat.'],
  ['(--> kelp canopy-former)', 'Kelp is ‘canopy-former’.'],
  ['(--> otter urchin-eater)', 'Otter is ‘urchin-eater’.'],
  ['(--> reef-north barren)', '‘reef-north’ is barren.'],
  ['(--> reef-south canopy)', '‘reef-south’ is canopy.'],
  ['(--> spring-tide reef-exposing)', '‘spring-tide’ is ‘reef-exposing’.'],
  ['(--> sunflower-star urchin-predator)', '‘sunflower-star’ is ‘urchin-predator’.'],
  ['(--> urchin kelp-grazer)', 'Urchin is ‘kelp-grazer’.'],
  ['(--> a b)', 'A is a b.'],
  // uifix-r3.5 (Kimi 4): a verb as an inheritance predicate is a name, never an event the statement does not assert
  ['(--> kelp recovers)', 'Kelp is ‘recovers’.'],
  ['(--> backup fails)', 'Backup is ‘fails’.'],
  ['(&& (-- (--> kelp recovers)) (--> reef barren))', 'Kelp is not ‘recovers’ and reef is barren.'],
  ['(--> (× vega dust) has)', 'Vega has dust.'],
  ['(--> (× vega star) has)', 'Vega has star.'],
  ['(--> (× urchin kelp) grazes)', 'Urchin grazes kelp.'],
  ['(--> (× vega deneb) brighter)', 'Vega and deneb are linked by “brighter”.'],
  ['(--> altair (× rotates fast))', 'Altair rotates fast.'],
  ['(<-> vega altair)', 'Vega is similar to altair.'],
  ['(==> (--> star cepheid) (--> star periodic))', 'If star is a cepheid, then star is periodic.'],
  ['(==> (--> star flare) (--> star variable))', 'If star is a glow, then star is variable.'.replace('a glow', 'a flare')],
  ['(==> (--> build-main red) (--> deploy blocked))', 'If ‘build-main’ is red, then deploy is blocked.'],
  ['(==> (--> otter present) (--> kelp recovers))', 'If otter is present, then kelp is ‘recovers’.'],
  ['(==> (--> reef barren) (--> reef urchin-dominated))', 'If reef is barren, then reef is ‘urchin-dominated’.'],
  ['(==> (--> service degraded) (--> service needs-page))', 'If service is degraded, then service is ‘needs-page’.'],
  ['(==> (--> vega star) (--> star vega))', 'If vega is a star, then star is a vega.'],
  ['(==> warm-water (--> kelp stressed))', 'If ‘warm-water’, then kelp is stressed.'],
  ['(==> (--> $x vega) (--> $x star))', 'If something is a vega, then it is a star.'],
  ['(<=> (--> a b) (--> b a))', 'A is a b exactly when b is an a.'],
  ['(-- (--> vega pulsar))', 'It is not true that vega is a pulsar.'],
  ['(&& (--> vega star) (--> vega luminous))', 'Vega is a star and vega is luminous.'],
  ['(|| (--> vega star) (--> vega pulsar))', 'Either vega is a star or vega is a pulsar.'],
  // uifix-r3.1: compounds keep their grouping in the words
  ['(-- (&& (--> deploy safe) (--> backup ready)))', 'It is not true that both deploy is safe and backup is ready.'],
  ['(&& (-- (--> deploy safe)) (--> backup ready))', 'Deploy is not safe and backup is ready.'],
  ['(&& (--> deploy safe) (-- (--> backup ready)))', 'Deploy is safe and backup is not ready.'],
  ['(-- (|| (--> deploy safe) (--> backup ready)))', 'It is not true that either deploy is safe or backup is ready.'],
  ['(|| (-- (--> deploy safe)) (--> backup ready))', 'Either deploy is not safe or backup is ready.'],
  ['(&& (--> a b) (--> c d) (--> e f))', 'A is a b, c is a d and e is a f.'],
  ['(==> (&& (--> otter present) (--> urchin absent)) (--> kelp recovers))', 'If both otter is present and urchin is absent, then kelp is ‘recovers’.'],
  ['(==> (-- (--> otter present)) (--> reef barren))', 'If otter is not present, then reef is barren.'],
  ['(-- (==> (--> a b) (--> c d)))', 'It is not true that if a is a b, then c is a d.'],
  ['(-- (-- (--> vega pulsar)))', 'It is not true that it is not true that vega is a pulsar.'],
  ['(&& (-- (<-> vega altair)) (--> (× vega deneb) brighter))', 'Vega is not similar to altair and vega and deneb are linked by “brighter”.'],
  ['(&& (-- (--> (× vega deneb) brighter)) (--> vega star))', 'Vega and deneb are not linked by “brighter” and vega is a star.'],
  // uifix-r3.1 (Kimi P2): a word ending in s is not a verb unless it is a known one
  ['(--> vega gas)', 'Vega is a gas.'],
  ['(--> x atlas)', 'X is an atlas.'],
  ['(--> service needs-page)', 'Service is ‘needs-page’.'],
  // uifix-r3.4: plain words only for ONE simple unquoted token; every other atom, quoted or not, is one name shown
  // as written inside ‘…’, no article, no grammar guessed from its words
  ['(--> vega "bright star")', 'Vega is ‘bright star’.'],
  ['(--> vega "star")', 'Vega is ‘star’.'],
  ['(--> "backup is ready and deploy" safe)', '‘backup is ready and deploy’ is safe.'],
  ['(--> (× vega deneb) "brighter than")', 'Vega and deneb are linked by ‘brighter than’.'],
  // Kimi 2 (r3.3): a relation atom that is a function word is one plain token, said inside the template's own quotes
  ['(--> (× vega deneb) and)', 'Vega and deneb are linked by “and”.'],
  ['(--> (× vega deneb) or)', 'Vega and deneb are linked by “or”.'],
  // open-class atoms (Kimi, r3.1): the article / no-article guesses, pinned so they stay deliberate
  ['(--> vega contrary)', 'Vega is contrary.'],
  ['(--> vega sanctuary)', 'Vega is a sanctuary.'],
  ['(--> vega galaxy)', 'Vega is a galaxy.'],
]

// forms the helper must not guess at: [statement, honest fallback]
const UNKNOWN: [string, string][] = [
  ['(=/> (--> door open) (--> cat out))', 'A belief about door, open, cat and out.'],
  ['(--> (& vega deneb) star)', 'A belief about vega, deneb and star.'],
  ['(--> vega (/ brighter _ deneb))', 'A belief about vega, brighter and deneb.'],
  ['(foo vega star)', 'A belief about foo, vega and star.'],
  ['(--> vega)', 'A belief about vega.'],
  ['(--> vega star dust)', 'A belief about vega, star and dust.'],
  ['(==> (--> $x a) (--> $y b))', 'A belief about a and b.'],
  ['(--> (--> a b) c)', 'A belief about a, b and c.'],
  ['(--> vega star', 'A belief about vega and star.'],
  ['vega', 'A belief about vega.'],
  ['(--> (× a b c) rel)', 'A belief about a, b, c and rel.'],
  ['(--> one two (three four five) six)', 'A belief about one, two, three, four and 2 more.'],
  ['()', 'A belief we cannot put into words.'],
  // uifix-r3.1: nested compounds whose grouping the words could not keep are not read
  ['(&& (|| (--> a b) (--> c d)) (--> e f))', 'A belief about a, b, c, d and 2 more.'],
  ['(|| (&& (--> a b) (--> c d)) (--> e f))', 'A belief about a, b, c, d and 2 more.'],
  ['(&& (==> (--> a b) (--> c d)) (--> e f))', 'A belief about a, b, c, d and 2 more.'],
  ['(-- (&& (--> a b) (--> c d) (--> e f)))', 'A belief about a, b, c, d and 2 more.'],
  ['(-- (<=> (--> a b) (--> c d)))', 'A belief about a, b, c and d.'],
  ['(&& (-- (--> (× urchin kelp) grazes)) (--> reef barren))', 'A belief about urchin, kelp, grazes, reef and 1 more.'],
  ['(&& (-- warm-water) (--> kelp stressed))', 'A belief about ‘warm-water’, kelp and stressed.'],
  ['(-- dry-run)', 'A belief about ‘dry-run’.'],
  ['(<-> (--> a b) c)', 'A belief about a, b and c.'],
  // uifix-r3.1: an unclosed quote is malformed, never silently dropped into another belief
  ['(--> vega "star)', 'A belief about vega and star.'],
  ['(--> vega star")', 'A belief about vega and star.'],
]

describe('sayBelief: known forms read as sentences', () => {
  it.each(KNOWN)('%s → %s', (st, want) => {
    const s = sayBelief(st)
    expect(s.text).toBe(want)
    expect(s.recognised).toBe(true)
    expect(s.text).not.toMatch(RAW_NOTATION)
    expect(s.text).not.toMatch(/-->|==>|<->|<=>|[()$]/)
  })
})

describe('sayBelief: quoted atoms (uifix-r3.1)', () => {
  it('a quoted atom keeps its brackets marked as quoted text, never read as structure', () => {
    expect(sayBelief('(--> vega "star) dust")')).toEqual({ text: 'Vega is ‘star) dust’.', clause: 'vega is ‘star) dust’', recognised: true })
    expect(sayBelief('(--> "my (odd) thing" star)').text).toBe('‘my (odd) thing’ is a star.')
  })
})

describe('sayBelief: a quoted atom never becomes a second claim (uifix-r3.2, stand-in P1)', () => {
  it.each([
    ['(--> deploy "safe and backup is ready")', 'Deploy is ‘safe and backup is ready’.'],
    ['(--> vega "star. Backup is ready")', 'Vega is ‘star. Backup is ready’.'],
    ['(--> deploy "safe; backup is ready!")', 'Deploy is ‘safe; backup is ready!’.'],
  ])('%s → %s', (st, want) => {
    const s = sayBelief(st)
    expect(s.text).toBe(want)
    expect(s.recognised).toBe(true)
  })
  it('quote marks inside a quoted atom: not read, so it cannot close early on screen', () => {
    for (const st of ['(--> deploy "safe’ and backup is ready ‘x")', '(--> deploy "safe\\" and backup is ready")', "(--> deploy \"it's safe\")"]) {
      const s = sayBelief(st)
      expect(s.recognised).toBe(false)
      expect(s.text).toBe('A belief about deploy and some quoted text.')
    }
  })
  it('quote marks inside a quoted subject: not read either', () => {
    expect(sayBelief('(--> "rock ‘n’ roll and deploy" safe)')).toEqual({ text: 'A belief about some quoted text and safe.', clause: 'a belief about some quoted text and safe', recognised: false })
  })
  it('a quoted subject: unshown without a truth value and with a doubtful one; a name keeps the adverb outside (Kimi, r3.2)', () => {
    for (const tv of [undefined, { f: 0.1, c: 0.9 }]) expect(sayBelief('(--> "it\'s vega" star)', tv).text).toBe('A belief about some quoted text and star.')
    expect(sayBelief('(--> "my (odd) thing" star)', { f: 0.1, c: 0.9 }).text).toBe('‘my (odd) thing’ is probably not a star.')
  })
  it('the sureness adverb stays outside the quoted name', () => {
    expect(sayBelief('(--> deploy "safe and backup is ready")', { f: 0.1, c: 0.9 }).text).toBe('Deploy is probably not ‘safe and backup is ready’.')
  })
})

describe('atoms never carry grammar of their own (uifix-r3.3, stand-in P1 on r3.2)', () => {
  // the stand-in's exact cases, through both readers
  it.each([
    ['(--> deploy safe-and-backup-is-ready)', 'Deploy is ‘safe-and-backup-is-ready’.'],
    ['(--> deploy safe_and_backup_is_ready)', 'Deploy is ‘safe_and_backup_is_ready’.'],
    ['(--> vega star.-Backup-is-ready)', 'Vega is ‘star.-Backup-is-ready’.'],
    ['(--> vega star.ready)', 'Vega is ‘star.ready’.'],
    ['(--> vega star!)', 'Vega is ‘star!’.'],
    ['(--> deploy-is-safe ready)', '‘deploy-is-safe’ is ready.'],
    ['(--> vega "star and dust")', 'Vega is ‘star and dust’.'],
    ['(--> vega "bright, hot star")', 'Vega is ‘bright, hot star’.'],
    ['(--> vega it\'s-safe)', 'A belief about vega and some quoted text.'],
  ])('%s → %s', (st, want) => {
    expect(sayBelief(st).text).toBe(want)
    expect(plainText(`Held: ${st}.`)).toBe(`Held: “${want.slice(0, -1)}”.`)
  })

  it('plain words only for one simple token', () => {
    expect(sayBelief('(--> vega star)').text).toBe('Vega is a star.')
    expect(sayBelief('(--> m57 variable)').text).toBe('M57 is variable.')
    expect(sayBelief('(--> rr-lyrae variable)').text).toBe('‘rr-lyrae’ is variable.')
    expect(sayBelief('(--> vega-star bright)').text).toBe('‘vega-star’ is bright.')
  })
})

/*
 * uifix-r3.4 (stand-in P1 on r3.3): the class is closed BY CONSTRUCTION, so the tests do not come from any list in the
 * implementation. Each adversarial atom below is written by hand. The property: a multi-piece atom is opaque. The
 * sentence it gives is exactly the sentence a neutral name gives in the same place, with that name swapped for the
 * atom verbatim inside ‘…’; and none of its pieces ever appears outside ‘…’ as separate words.
 */
describe('a multi-piece atom is one opaque name, whatever its words (uifix-r3.4, independent adversarial cases)', () => {
  // the stand-in's r3.3 reproductions, verbatim
  it.each([
    ['(--> deploy safe-although-backup-failed)', undefined, 'Deploy is ‘safe-although-backup-failed’.'],
    ['(--> deploy "safe although backup failed")', undefined, 'Deploy is ‘safe although backup failed’.'],
    ['(--> deploy safe-although-backup-failed)', { f: 0, c: 0 }, 'Deploy is perhaps ‘safe-although-backup-failed’.'],
    ['(--> deploy "safe although backup failed")', { f: 0, c: 0 }, 'Deploy is perhaps ‘safe although backup failed’.'],
    ['(--> deploy safe-despite-backup-failing)', undefined, 'Deploy is ‘safe-despite-backup-failing’.'],
  ] as [string, { f: number; c: number } | undefined, string][])('%s %o → %s', (st, tv, want) => {
    expect(sayBelief(st, tv).text).toBe(want)
    if (!tv) expect(plainText(`Held: ${st}.`)).toBe(`Held: “${want.slice(0, -1)}”.`)
  })

  // hand-written, NOT generated from the implementation: subordinators, connectives, verbs, other languages, digits
  const CLAUSES = [
    'safe-although-backup-failed', 'safe-despite-backup-failing', 'safe-unless-backup-fails', 'ready-whereas-backup-failed',
    'down-since-backup-failed', 'safe-until-backup-fails', 'safe-however-backup-failed', 'safe-thus-ready', 'safe-hence-ready',
    'failed-after-backup', 'ready-before-deploy', 'backup-failed', 'is-ready', 'safe_although_backup_failed', 'safe.although.backup.failed',
    'safe-and-ready', 'not-safe', 'deploy-is-not-safe', 'Backup-failed', 'safe-ALTHOUGH-backup-FAILED',
    // other languages
    'sicher-obwohl-backup-fehlgeschlagen', 'seguro-aunque-falló-copia', 'sûr-bien-que-échoué', 'безопасно-хотя-сбой', 'ασφαλές-αν-και-απέτυχε',
    'آمن-رغم-الفشل', 'सुरक्षित-यद्यपि-विफल', '安全-虽然-备份失败', '安全虽然备份失败', 'バックアップ失敗', 'ปลอดภัยแม้ว่าล้มเหลว',
    // digits mixed in
    'v2-ready-3', '3-failed', 'backup-failed-2x', 'ready2deploy', '2mass', 'node-3', '0.5', '-3', 'p95-elevated',
  ]
  const QUOTED = ['safe although backup failed', 'safe despite backup failing', 'ready unless it fails', 'safe whereas backup is down', 'up since monday', 'safe; however backup failed', 'thus ready', 'hence safe', 'failed after backup', 'ready before deploy', 'is ready', 'obwohl fehlgeschlagen', 'хотя сбой', 'v2 ready 3', 'star', 'safe', 'failed']
  const ATOMS = [...CLAUSES, ...CLAUSES.map((x) => `"${x}"`), ...QUOTED.map((x) => `"${x}"`)]
  const NEUTRAL = 'zz-neutral'
  const SHAPES = [
    '(--> deploy ATOM)', '(--> ATOM safe)', '(<-> ATOM vega)', '(<-> vega ATOM)', '(==> (--> deploy ATOM) (--> backup ready))', '(==> (--> ATOM ready) (--> deploy safe))',
    '(==> ATOM (--> deploy safe))', '(&& (--> deploy ATOM) (--> backup ready))', '(&& (-- (--> ATOM safe)) (--> backup ready))', '(-- (--> ATOM safe))', '(-- (--> deploy ATOM))',
    '(-- (&& (--> deploy ATOM) (--> backup ready)))', '(|| (--> deploy ATOM) (--> backup ready))', '(--> (× vega ATOM) brighter)', '(--> (× vega deneb) ATOM)', '(--> (× vega ATOM) has)',
  ]
  const TV = [undefined, { f: 0.95, c: 0.9 }, { f: 0.1, c: 0.9 }, { f: 0.5, c: 0.5 }, { f: 0, c: 0 }]
  const shown = (atom: string) => (atom.startsWith('"') ? atom.slice(1, -1) : atom)
  const outsideNames = (text: string) => text.replace(/‘[^’]*’/g, ' ')
  // the atom's pieces (split on anything that is not a letter or digit), lowercased
  const pieces = (atom: string) => shown(atom).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  // how often the atom's pieces stand as consecutive separate words outside ‘…’ ("not safe" for `not-safe`)
  const asSeparateWords = (text: string, atom: string) => {
    const ps = pieces(atom)
    if (ps.length < 2) return 0
    const words = ` ${outsideNames(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ')} `
    return words.split(` ${ps.join(' ')} `).length - 1
  }

  it('every hand-written atom, every shape, every truth value, through sayBelief and plainText', () => {
    let checked = 0
    for (const shape of SHAPES) {
      for (const tv of TV) {
        const base = sayBelief(shape.replace('ATOM', NEUTRAL), tv)
        expect(base.recognised, `${shape} reads with a neutral name`).toBe(true)
        const baseProse = plainText(`Held: ${shape.replace('ATOM', NEUTRAL)}.`)
        for (const atom of ATOMS) {
          const st = shape.replace('ATOM', atom)
          const swap = (x: string) => x.split(`‘${NEUTRAL}’`).join(`‘${shown(atom)}’`)
          const text = sayBelief(st, tv).text
          // exactly the neutral sentence with the atom, verbatim, in the name's place: no word of it read as grammar
          expect(text, st).toBe(swap(base.text))
          expect(asSeparateWords(text, atom), `${st} → ${text}`).toBe(asSeparateWords(base.text, atom))
          // and the atom verbatim never stands outside ‘…’ more often than the template's own words put it there
          const verbatim = (x: string) => outsideNames(x).split(shown(atom)).length - 1
          expect(verbatim(text), st).toBe(verbatim(base.text))
          if (!tv) {
            const prose = plainText(`Held: ${st}.`)
            expect(prose, st).toBe(swap(baseProse))
            expect(asSeparateWords(prose, atom), `${st} → ${prose}`).toBe(asSeparateWords(baseProse, atom))
          }
          checked++
        }
      }
    }
    expect(checked).toBe(SHAPES.length * TV.length * ATOMS.length)
  })

  it('an atom holding quote marks is never shown, in any shape', () => {
    for (const atom of ['it\'s-safe', 'safe’and’ready', '"it\'s safe although backup failed"', '"safe“ although ”failed"', '"rock ‘n’ roll"', 'don`t-deploy']) {
      for (const shape of SHAPES) {
        const st = shape.replace('ATOM', atom)
        const s = sayBelief(st)
        expect(s.recognised, st).toBe(false)
        expect(s.text, st).toContain('some quoted text')
        // prose rewrites it to the honest fallback, or (a two-element form it cannot read) leaves it exactly as written
        const prose = plainText(`Held: ${st}.`)
        expect(prose === `Held: ${st}.` || (prose.includes('some quoted text') && !/although|safe’and|rock|don`t/.test(prose)), `${st} → ${prose}`).toBe(true)
      }
    }
  })

  it('a single simple token stays plain words: one token cannot carry a second claim', () => {
    for (const w of ['although', 'despite', 'unless', 'whereas', 'since', 'until', 'however', 'thus', 'hence', 'after', 'before', 'failed', 'obwohl', 'хотя', 'v2']) {
      const s = sayBelief(`(--> deploy ${w})`)
      expect(s.recognised).toBe(true)
      expect(s.text).toMatch(new RegExp(`^Deploy is (an? )?${w}\\.$`, 'u'))
    }
  })
})

describe('sayBelief: unknown forms never get an invented sentence', () => {
  it.each(UNKNOWN)('%s → %s', (st, want) => {
    const s = sayBelief(st)
    expect(s.recognised).toBe(false)
    expect(s.text).toBe(want)
    expect(s.text).not.toMatch(/ is | if |, then /)
  })
})

describe('sureness in the sentence', () => {
  it('places the adverb where English wants it, and never "probably not <verb>"', () => {
    expect(sayBelief('(--> vega star)', { f: 0.95, c: 0.9 }).text).toBe('Vega is almost certainly a star.')
    expect(sayBelief('(--> vega pulsar)', { f: 0.1, c: 0.8 }).text).toBe('Vega is probably not a pulsar.')
    expect(sayBelief('(--> kelp recovers)', { f: 0.1, c: 0.8 }).text).toBe('Kelp is probably not ‘recovers’.')
    expect(sayBelief('(--> (× urchin kelp) grazes)', { f: 0.1, c: 0.8 }).text).toBe('It is probably not true that urchin grazes kelp.')
    expect(sayBelief('(--> (× vega dust) has)', { f: 0.85, c: 0.7 }).text).toBe('Vega very likely has dust.')
    expect(sayBelief('(==> (--> star cepheid) (--> star periodic))', { f: 0.7, c: 0.5 }).text).toBe('Probably, if star is a cepheid, then star is periodic.')
    expect(sayBelief('(==> (--> star cepheid) (--> star periodic))', { f: 0.2, c: 0.9 }).text).toBe('It is probably not true that if star is a cepheid, then star is periodic.')
    expect(sayBelief('(-- (--> vega pulsar))', { f: 0.95, c: 0.9 }).text).toBe('Almost certainly, it is not true that vega is a pulsar.')
    // doubting a conjunction is a negation too: its grouping is said
    expect(sayBelief('(&& (--> deploy safe) (--> backup ready))', { f: 0.1, c: 0.9 }).text).toBe('It is probably not true that both deploy is safe and backup is ready.')
    expect(sayBelief('(&& (--> deploy safe) (--> backup ready))', { f: 0.7, c: 0.5 }).text).toBe('Probably, deploy is safe and backup is ready.')
    // or carries its own scope word ("either"), so doubting it needs no "both" (Kimi, r3.1: pinned on purpose)
    expect(sayBelief('(|| (--> deploy safe) (--> backup ready))', { f: 0.1, c: 0.9 }).text).toBe('It is probably not true that either deploy is safe or backup is ready.')
    expect(sayBelief('(&& (--> a b) (--> c d) (--> e f))', { f: 0.1, c: 0.9 }).recognised).toBe(false)
    // no evidence is never a "no": {f 0, c 0} is tentative, so the adverb is "perhaps", not "probably not"
    expect(sayBelief('(--> deploy safe)', { f: 0, c: 0 }).text).toBe('Deploy is perhaps safe.')
    expect(sayBelief('(--> deploy safe)', { f: 0.1, c: 0.9 }).text).toBe('Deploy is probably not safe.')
    // unknown forms stay unknown with a truth value too
    expect(sayBelief('(=/> a b)', { f: 0.9, c: 0.9 }).text).toBe('A belief about a and b.')
  })
})

describe('truth values in words, numbers one step away', () => {
  // uifix-r3.1 (Platform's NAL rule): c < 0.3 is the no-evidence floor ("tentative" whatever f); otherwise the NAL
  // expectation e = c·(f − 0.5) + 0.5 decides: ≥ 0.85 near certain, ≥ 0.7 confident, ≥ 0.55 fairly sure, > 0.45 tentative
  const T: [number, number, string][] = [
    // the no-evidence floor
    [0, 0, 'tentative'],
    [0.1, 0.1, 'tentative'],
    [1, 0.29, 'tentative'],
    [0, 0.29, 'tentative'],
    [1, 0.3, 'fairly sure'], // e 0.65, just over the floor
    [0, 0.3, 'doubts it'], // e 0.35
    // e at each boundary, and just under it
    [1, 0.7, 'near certain'], // e 0.85
    [1, 0.69, 'confident'], // e 0.845
    [0.9, 0.5, 'confident'], // e 0.70
    [0.9, 0.49, 'fairly sure'], // e 0.696
    [0.6, 0.5, 'fairly sure'], // e 0.55
    [0.59, 0.5, 'tentative'], // e 0.545
    [0.58, 0.625, 'fairly sure'], // e 0.55 exactly, though floating point makes it 0.5499999999999999
    [0.41, 0.5, 'tentative'], // e 0.455
    [0.4, 0.5, 'doubts it'], // e 0.45
    // the simulator's and reviewers' cases
    [0.95, 0.9, 'near certain'],
    [0.85, 0.7, 'confident'],
    [0.9, 0.8, 'confident'], // e 0.82
    [0.58, 0.47, 'tentative'],
    [0.1, 0.9, 'doubts it'],
    [0.2, 0.9, 'doubts it'],
  ]
  it.each(T)('f %d, c %d → %s', (f, c, w) => {
    expect(truthWords({ f, c })).toBe(w)
    expect(truthNumbers({ f, c })).toBe(`likelihood ${f.toFixed(2)}, confidence ${c.toFixed(2)}`)
    expect(truthPhrase({ f, c })).toBe(`${w} (likelihood ${f.toFixed(2)}, confidence ${c.toFixed(2)})`)
  })
  it('the scale is NAL expectation above the floor, and the adverbs follow the same rule', () => {
    expect(NO_EVIDENCE_C).toBe(0.3)
    expect(truthWords({ f: 1, c: 0.29 })).toBe('tentative') // the floor's word, whatever the key behind it
    expect(SURENESS_WORD[NO_EVIDENCE]).toBe('tentative') // Kimi 4 (r3.3): the chain floor → key → word, pinned
    expect(expectation({ f: 1, c: 1 })).toBe(1)
    expect(expectation({ f: 0, c: 0 })).toBe(0.5)
    expect(expectation({ f: 0.1, c: 0.9 })).toBeCloseTo(0.14, 10)
    // "doubts it" only with evidence against; a low f with little evidence never reads as a "no"
    for (let f = 0; f <= 1.0001; f += 0.05) for (let c = 0; c < 0.3; c += 0.02) expect(sureness(f, c)).toBe('unsure')
    const adverbOf = (f: number, c: number) => sayBelief('(--> vega star)', { f, c }).text
    expect(adverbOf(1, 0.7)).toBe('Vega is almost certainly a star.')
    expect(adverbOf(0.9, 0.5)).toBe('Vega is very likely a star.')
    expect(adverbOf(0.6, 0.5)).toBe('Vega is probably a star.')
    expect(adverbOf(0.41, 0.5)).toBe('Vega is perhaps a star.')
    expect(adverbOf(0.4, 0.5)).toBe('Vega is probably not a star.')
    expect(adverbOf(0.1, 0.1)).toBe('Vega is perhaps a star.')
  })
  it('a missing or broken truth value says so, never zero', () => {
    expect(truthWords(null)).toBe('not yet weighed')
    expect(truthWords({ f: NaN, c: 0.4 })).toBe('not yet weighed')
    expect(truthNumbers(undefined)).toBe('no numbers yet')
  })
  it('the screen-reader line carries sentence, words and numbers; the written form carries the notation', () => {
    expect(beliefLine('(--> vega star)', { f: 0.58, c: 0.47 })).toBe('Vega is a star. Tentative (likelihood 0.58, confidence 0.47).')
    expect(beliefLine('(--> vega star)')).toBe('Vega is a star.')
    expect(asWritten('(--> vega star)', { f: 0.58, c: 0.47 })).toBe('(--> vega star) ⟨f 0.58, c 0.47⟩')
    expect(asWritten('(--> vega star)')).toBe('(--> vega star)')
  })
  it('beliefTopic: a belief as the object of a thought', () => {
    expect(beliefTopic('(--> ring-nebula planetary)')).toBe('whether ‘ring-nebula’ is planetary')
    expect(beliefTopic('(==> (--> a b) (--> c d))')).toBe('the rule that if a is a b, then c is a d')
    expect(beliefTopic('(=/> a b)')).toBe('a belief about a and b')
  })
})

// every chat and activity template the simulator writes (api/sim/replies.ts, SimClient), and a mind's own phrasing
const PROSE: [string, string][] = [
  ['Right now I\'m most sure that (--> vega star) ⟨f 0.95, c 0.90⟩.', 'Right now I\'m most sure that “Vega is a star” (near certain).'],
  ['The closest thing I hold is (⟶ crab urchin-larva-eater) ⟨f 0.59, c 0.38⟩.'.replace('⟶', '-->'), 'The closest thing I hold is “Crab is ‘urchin-larva-eater’” (tentative).'],
  ['Strongest: (--> vega star) ⟨f 0.95, c 0.90⟩. Weakest: (--> vega pulsar) ⟨f 0.10, c 0.20⟩; I would not lean on that one yet.', 'Strongest: “Vega is a star” (near certain). Weakest: “Vega is a pulsar” (tentative); I would not lean on that one yet.'],
  ['Because the evidence for (--> rr-lyrae variable) comes from 2 sources with 3 stamps. Revision pooled them to f 0.89, c 0.71.', 'Because the evidence for “‘rr-lyrae’ is variable” comes from 2 sources with 3 stamps. Revision pooled them to “confident”.'],
  ['I revised (--> rr-lyrae variable) to f 0.89, c 0.71', 'I revised “‘rr-lyrae’ is variable” to “confident”'],
  ['The commons has it at f 0.58, c 0.47.', 'The commons has it at “tentative”.'],
  ['Publishing (==> (--> star flare) (--> star variable)) soon, heads up.', 'Publishing “If star is a flare, then star is variable” soon, heads up.'],
  ['Asserted (--> vega star) (stv 0.90 0.80)', 'Asserted “Vega is a star” (confident)'],
  ['Weird one: (=/> (--> a b) (--> c d)) holds.', 'Weird one: “A belief about a, b, c and d” holds.'],
  ['Seeing (--> (& a b) c) and f=0.9 c=0.8', 'Seeing “A belief about a, b and c” and “confident”'],
  ['No notation here (just brackets), a clef, and 0.5 of a cake.', 'No notation here (just brackets), a clef, and 0.5 of a cake.'],
  // uifix-r3.1: compounds in prose keep their grouping
  ['Held: (-- (&& (--> deploy safe) (--> backup ready))).', 'Held: “It is not true that both deploy is safe and backup is ready”.'],
  ['Held: (&& (-- (--> deploy safe)) (--> backup ready)).', 'Held: “Deploy is not safe and backup is ready”.'],
  // a number ends where the number ends
  ['Set f=0.9 c=0.80ms on the timer.', 'Set f=0.9 c=0.80ms on the timer.'],
  ['Pooled to f 0.89, c 0.71.', 'Pooled to “confident”.'],
  // prose that only looks like notation is left alone
  ['Use (-- dry-run) before proceeding.', 'Use (-- dry-run) before proceeding.'],
]

// uifix-r3.1 (stand-in blocker 3): brackets inside quoted atoms, and quotes that never close
const QUOTED: [string, string][] = [
  ['See (--> vega "star) dust") now.', 'See “Vega is ‘star) dust’” now.'],
  ['See (--> vega "a (b) c") now.', 'See “Vega is ‘a (b) c’” now.'],
  ['See (--> vega "say \\"hi)\\" ok") now.', 'See “A belief about vega and some quoted text” now.'],
  // uifix-r3.2 (stand-in P1): the quoted name stays one name in prose too
  ['Held: (--> deploy "safe and backup is ready").', 'Held: “Deploy is ‘safe and backup is ready’”.'],
  ['Held: (--> vega "star. Backup is ready") ⟨f 0.9, c 0.9⟩.', 'Held: “Vega is ‘star. Backup is ready’” (near certain).'],
  ['First (--> vega star), then (--> vega "star) dust', 'First “Vega is a star”, then (--> vega "star) dust'],
  ['Open (--> vega "star) and (--> deneb star) later.', 'Open (--> vega "star) and (--> deneb star) later.'],
  ['Open (--> vega (× a b) and more', 'Open (--> vega (× a b) and more'],
  // a closed statement it will not rewrite is skipped whole: the statement inside it is not read on its own
  ['Try (-- (foo (--> a b))) now.', 'Try (-- (foo (--> a b))) now.'],
]

describe('free text: chat and activity lines said plainly', () => {
  it.each(PROSE)('%s', (raw, want) => {
    expect(plainText(raw)).toBe(want)
  })
  it('each rewritten piece keeps its exact raw text, so "Show as written" can give it back', () => {
    const raw = 'I revised (--> rr-lyrae variable) ⟨f 0.89, c 0.71⟩ and then f 0.5, c 0.4.'
    const pieces = plainPieces(raw)
    expect(pieces.map((p) => p.raw ?? p.t).join('')).toBe(raw)
    expect(pieces.filter((p) => p.raw).map((p) => p.raw)).toEqual(['(--> rr-lyrae variable) ⟨f 0.89, c 0.71⟩', 'f 0.5, c 0.4'])
    expect(hasNotation(raw)).toBe(true)
    expect(hasNotation('Plain words only.')).toBe(false)
  })
  it.each(QUOTED)('quoted atoms and unclosed quotes: %s', (raw, want) => {
    expect(plainText(raw)).toBe(want)
    expect(plainPieces(raw).map((p) => p.raw ?? p.t).join('')).toBe(raw)
  })
  it('no template output keeps raw notation once said plainly, a form it cannot read included', () => {
    for (const [raw] of PROSE) expect(plainText(raw)).not.toMatch(RAW_NOTATION)
  })
})
