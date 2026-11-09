import type { ProgramDescription, Uncertainty, WorkGraph, WorkItem, WorkLink } from '../../api/types'

/**
 * The official SAMPLE Atlas: "Subject A", a fictional person. Every record is invented; nothing is derived from
 * anyone's data. It is deliberately realistic and deliberately messy, so the form is designed against what a
 * real Atlas looks like after years: a lost device (four silent months), values with no reference range, general
 * ranges that are not the laboratory's, a transcription corrected two days later, a test superseded by a repeat,
 * an unassessed idea, an idea weakened by a correction, and one very long name.
 *
 * Shapes follow the Atlas OmegaDot projection (programs/atlas/program.py): meta carries the exporter node
 * (value, units, ref, system, type, status as domain_status), uncertainty is labelled by method.
 */

export const SAMPLE_SUBJECT = 'Subject A'

/** The Atlas describe() vocabulary (contract 0.2), interface metadata only. Agent-only actions are flagged. */
export const ATLAS_DESCRIBE: ProgramDescription = {
  contract: '0.2',
  kinds: [
    { id: 'question', label: 'Question', role: 'question' },
    { id: 'subject', label: 'Subject', role: 'other' },
    { id: 'event', label: 'Event', role: 'source' },
    { id: 'observation', label: 'Observation', role: 'evidence' },
    { id: 'hypothesis', label: 'Hypothesis', role: 'hypothesis' },
    { id: 'literature', label: 'Literature', role: 'source' },
    { id: 'prediction', label: 'Prediction', role: 'claim' },
    { id: 'experiment', label: 'Experiment', role: 'other' },
  ],
  relations: [
    { id: 'recorded-about', label: 'recorded-about', polarity: 'neutral' },
    { id: 'extracted-from', label: 'extracted-from', polarity: 'neutral' },
    { id: 'corrects', label: 'corrects', polarity: 'qualify' },
    { id: 'supersedes', label: 'supersedes', polarity: 'qualify' },
    { id: 'supports', label: 'supports', polarity: 'support' },
    { id: 'contradicts', label: 'contradicts', polarity: 'oppose' },
    { id: 'qualifies', label: 'qualifies', polarity: 'qualify' },
    { id: 'predicts', label: 'predicts', polarity: 'neutral' },
    { id: 'tests', label: 'tests', polarity: 'neutral' },
  ],
  actions: [
    { id: 'worker-resolve', label: 'Resolve scoped Scientist request', applies_to: [], agents: true } as ProgramDescription['actions'][number],
    { id: 'worker-stage', label: 'Stage Scientist proposal', applies_to: [], agents: true } as ProgramDescription['actions'][number],
    { id: 'inspect-source', label: 'Inspect provenance', applies_to: ['question', 'subject', 'event', 'observation', 'hypothesis', 'literature', 'prediction', 'experiment'], stage: 'detail' },
    { id: 'compare', label: 'Compare provisional models', applies_to: ['hypothesis', 'prediction'], stage: 'compare' },
    {
      id: 'investigate',
      label: 'Request Scientist review',
      applies_to: ['hypothesis', 'prediction'],
      params: { worker_id: 'Provisioned local worker', question: 'Research question', idempotency_key: 'Stable retry identity', expires_at: 'UTC Unix expiry', budget_seconds: 'Worker time budget' },
    },
    { id: 'inspect-request', label: 'Inspect Scientist request', applies_to: ['hypothesis', 'prediction'], params: { request_digest: 'Local request digest' } },
    { id: 'revoke-request', label: 'Revoke snapshot access', applies_to: ['hypothesis', 'prediction'], params: { request_digest: 'Local request digest', reason: 'Why revoke' } },
    { id: 'cancel-request', label: 'Cancel Scientist goal', applies_to: ['hypothesis', 'prediction'], params: { request_digest: 'Local request digest', reason: 'Why cancel' } },
  ],
}

/* ---------------------------------------------------------------- builder */

interface Builder {
  items: WorkItem[]
  links: WorkLink[]
}
const at = (d: string) => `${d}T08:00:00Z`
const P = 'sample:'
let linkN = 0

function link(b: Builder, from: string, rel: string, to: string, weight?: number) {
  b.links.push({ id: `${P}l${++linkN}`, from, to, rel, ...(weight != null ? { weight } : {}) })
}

function event(b: Builder, id: string, label: string, date: string, source: string, status = 'current') {
  b.items.push({
    id: P + id,
    kind: 'event',
    label,
    at: at(date),
    status,
    meta: { source, schema_version: 'sample' },
    sources: [{ id: P + id, label: 'Immutable recorded event', local_ref: P + id, origin: P + id, date: at(date), status: 'cited', locator: 'Sample ledger (fictional)' }],
  })
  link(b, P + id, 'recorded-about', P + 'subject-a')
}

interface ObsSpec {
  id: string
  ev: string
  date: string
  marker?: string
  label: string
  value: number | string
  units?: string
  ref?: { low?: number; high?: number; source?: string; generic?: boolean }
  structure?: string
  system?: string
  type?: string
  status?: string
}

function obs(b: Builder, o: ObsSpec) {
  const meta: Record<string, unknown> = { value: o.value }
  if (o.units) meta.units = o.units
  if (o.ref) meta.ref = o.ref
  if (o.marker) meta.marker = o.marker
  if (o.structure) meta.structure = o.structure
  if (o.system) meta.system = o.system
  if (o.type) meta.type = o.type
  meta.extractor_version = 'sample-1'
  b.items.push({ id: P + o.id, kind: 'observation', label: o.label, at: at(o.date), status: o.status ?? 'current', meta, sources: [{ id: P + o.ev, label: 'Immutable recorded event', origin: P + o.ev, status: 'cited' }] })
  link(b, P + o.id, 'extracted-from', P + o.ev)
}

/** Deterministic noise: the same sample every time. */
function noise(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const LAB = 'Sample laboratory (fictional)'
const GENERIC = 'A general adult range'

export interface SampleOptions {
  /** Owner-harness stress variant: drops marker names, more missing ranges, history from 2021. Still invented. */
  messy?: boolean
  subject?: string
}

export function sampleGraph(opts: SampleOptions = {}): WorkGraph {
  linkN = 0
  const b: Builder = { items: [], links: [] }
  const rnd = noise(opts.messy ? 77 : 7)
  const messy = !!opts.messy
  const mk = (m: string) => (messy ? undefined : m)
  const name = opts.subject ?? SAMPLE_SUBJECT

  b.items.push({ id: P + 'subject-a', kind: 'subject', label: name, text: 'A fictional person. Every record in this Atlas is invented for demonstration.', meta: { display_name: name, sample: true } })
  b.items.push({ id: P + 'question', kind: 'question', label: 'Why are weekday mornings so hard?', meta: { projection_only: true } })

  /* ---- laboratory panels */
  const panels = ['2023-03-14', '2023-09-20', '2024-03-05', '2024-11-12', '2025-05-21', '2025-11-18', '2026-06-02']
  panels.forEach((d, i) => event(b, `lab-${i + 1}`, `Laboratory panel, ${+d.slice(8)} ${MON[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`, d, 'lab-report'))
  const series: { key: string; marker: string; units: string; structure?: string; system?: string; ref?: ObsSpec['ref']; vals: (number | null)[] }[] = [
    { key: 'ferritin', marker: 'Ferritin', units: 'ng/mL', structure: 'liver', ref: { low: 30, high: 400, source: LAB }, vals: [62, 48, null, 21, 27, 38, 45] },
    { key: 'ft4', marker: 'Free T4', units: 'pmol/L', structure: 'thyroid', ref: { low: 12, high: 22, source: LAB }, vals: [16.2, 15.8, 15.1, null, 14.6, 14.9, 15.5] },
    { key: 'hba1c', marker: 'HbA1c', units: 'mmol/mol', structure: 'pancreas', ref: { low: 20, high: 42, source: LAB }, vals: [36, 37, null, 38, 39, 37, 36] },
    { key: 'glucose', marker: 'Fasting glucose', units: 'mmol/L', structure: 'pancreas', ref: { low: 3.9, high: 5.5, source: LAB }, vals: [5.1, 5.3, 5.4, 5.6, 5.4, 5.2, 5.0] },
    { key: 'cortisol', marker: 'Morning cortisol', units: 'nmol/L', structure: 'adrenal', ref: { low: 140, high: 690, source: LAB }, vals: [null, 410, null, 520, null, 455, null] },
    { key: 'testosterone', marker: 'Total testosterone', units: 'nmol/L', structure: 'gonads', ref: { low: 8.6, high: 29, source: LAB }, vals: [17.4, null, 15.9, null, 16.8, null, 18.2] },
    { key: 'hb', marker: 'Haemoglobin', units: 'g/L', structure: 'liver', ref: { low: 130, high: 170, source: LAB }, vals: [148, 146, 139, 136, 141, 145, 147] },
    { key: 'ldl', marker: 'LDL cholesterol', units: 'mmol/L', structure: 'gut', vals: [3.1, null, 3.4, null, 3.2, null, 2.9] },
    { key: 'vitd', marker: 'Vitamin D', units: 'nmol/L', system: 'MET_SYS', ref: { low: 50, high: 175, source: LAB }, vals: [48, null, 61, null, 72, null, 80] },
  ]
  for (const s of series)
    s.vals.forEach((v, i) => {
      if (v == null) return
      const ref = messy && rnd() < 0.3 ? undefined : s.ref
      obs(b, { id: `${s.key}-${i + 1}`, ev: `lab-${i + 1}`, date: panels[i], marker: mk(s.marker), label: `${s.marker} ${v} ${s.units}`, value: v, units: s.units, ref, structure: s.structure, system: s.system, type: `lab.${s.marker.split(/\s+/).map((w) => w[0].toUpperCase() + w.slice(1)).join('')}` })
    })

  /* ---- a transcription corrected two days later */
  event(b, 'iron-1', 'Iron studies, 5 Mar 2024', '2024-03-05', 'lab-report', 'corrected')
  event(b, 'iron-1c', 'Corrected iron studies, 7 Mar 2024', '2024-03-07', 'correction')
  link(b, P + 'iron-1c', 'corrects', P + 'iron-1')
  obs(b, { id: 'ferritin-3x', ev: 'iron-1', date: '2024-03-05', marker: mk('Ferritin'), label: 'Ferritin 14 ng/mL', value: 14, units: 'ng/mL', ref: { low: 30, high: 400, source: LAB }, structure: 'liver', status: 'corrected' })
  obs(b, { id: 'ferritin-3', ev: 'iron-1c', date: '2024-03-07', marker: mk('Ferritin'), label: 'Ferritin 24 ng/mL', value: 24, units: 'ng/mL', ref: { low: 30, high: 400, source: LAB }, structure: 'liver' })
  link(b, P + 'ferritin-3', 'corrects', P + 'ferritin-3x')

  /* ---- thyroid: an add-on test superseded by a repeat */
  const tsh = [2.1, 2.6, 3.2, 3.9, null, 3.5, 3.1]
  tsh.forEach((v, i) => v != null && obs(b, { id: `tsh-${i + 1}`, ev: `lab-${i + 1}`, date: panels[i], marker: mk('TSH'), label: `TSH ${v} mIU/L`, value: v, units: 'mIU/L', ref: { low: 0.4, high: 4.0, source: LAB }, structure: 'thyroid' }))
  event(b, 'thy-5', 'Thyroid add-on test, 21 May 2025', '2025-05-21', 'lab-report', 'superseded')
  event(b, 'thy-5r', 'Repeat thyroid test, 10 Jun 2025', '2025-06-10', 'lab-report')
  link(b, P + 'thy-5r', 'supersedes', P + 'thy-5')
  obs(b, { id: 'tsh-5', ev: 'thy-5', date: '2025-05-21', marker: mk('TSH'), label: 'TSH 4.4 mIU/L', value: 4.4, units: 'mIU/L', ref: { low: 0.4, high: 4.0, source: LAB }, structure: 'thyroid', status: 'superseded' })
  obs(b, { id: 'tsh-5r', ev: 'thy-5r', date: '2025-06-10', marker: mk('TSH'), label: 'TSH 3.8 mIU/L', value: 3.8, units: 'mIU/L', ref: { low: 0.4, high: 4.0, source: LAB }, structure: 'thyroid' })
  link(b, P + 'tsh-5r', 'supersedes', P + 'tsh-5')

  /* ---- wearable exports: monthly, with a lost device (June to September 2024) */
  const months: string[] = []
  for (let y = messy ? 2021 : 2023, m = messy ? 1 : 2; y < 2026 || (y === 2026 && m <= 9); m++) {
    if (m > 12) {
      m = 0
      y++
      continue
    }
    const ym = `${y}-${String(m).padStart(2, '0')}`
    if (ym >= '2024-06' && ym <= '2024-09') continue
    if (messy && y < 2023 && m % 3 !== 1) continue
    months.push(ym)
  }
  months.forEach((ym, k) => {
    const d = `${ym}-28`
    const label = `Wearable export, ${MON[+ym.slice(5) - 1]} ${ym.slice(0, 4)}`
    event(b, `wear-${ym}`, label, d, 'device-export')
    const t = (+ym.slice(0, 4) - 2023) * 12 + +ym.slice(5) - 1
    // sleep onset: drifts up as afternoon caffeine creeps in, falls after the 2 pm cutoff (Dec 2025)
    const sol = t < 14 ? 22 + rnd() * 5 : t < 34 ? 28 + (t - 14) * 0.5 + rnd() * 6 : 17 + rnd() * 5
    obs(b, {
      id: `sol-${ym}`,
      ev: `wear-${ym}`,
      date: d,
      label: `Sleep onset latency, weekday nights only, excluding nights after long-haul travel (device estimate): ${Math.round(sol)} min`,
      value: Math.round(sol),
      units: 'min',
      ref: { high: 30, source: GENERIC, generic: true },
      structure: 'sleep-architecture',
    })
    const rhr = 57 + rnd() * 6 + (t > 14 && t < 34 ? 2 : 0)
    obs(b, { id: `rhr-${ym}`, ev: `wear-${ym}`, date: d, marker: mk('Resting heart rate'), label: `Resting heart rate ${Math.round(rhr)} bpm`, value: Math.round(rhr), units: 'bpm', ref: { low: 50, high: 80, source: GENERIC, generic: true }, structure: 'heart' })
    if (k % 2 === 0) {
      const eff = t < 14 ? 88 + rnd() * 3 : t < 34 ? 81 + rnd() * 4 : 88 + rnd() * 3
      obs(b, { id: `eff-${ym}`, ev: `wear-${ym}`, date: d, marker: mk('Sleep efficiency'), label: `Sleep efficiency ${Math.round(eff)}%`, value: Math.round(eff), units: '%', ref: { low: 85, source: GENERIC, generic: true }, structure: 'sleep-architecture' })
      const hrv = Math.round(52 + rnd() * 12)
      obs(b, { id: `hrv-${ym}`, ev: `wear-${ym}`, date: d, marker: mk('Heart rate variability'), label: `HRV ${hrv} ms`, value: hrv, units: 'ms', structure: 'heart' })
    }
    if (k % 3 === 0) {
      const steps = Math.round(7400 + rnd() * 2400)
      const screen = +(1.4 + rnd() * 1.6).toFixed(1)
      obs(b, { id: `steps-${ym}`, ev: `wear-${ym}`, date: d, marker: mk('Daily steps'), label: `Daily steps ${steps}`, value: steps, units: 'steps', structure: 'muscle' })
      obs(b, { id: `screen-${ym}`, ev: `wear-${ym}`, date: d, label: `Evening screen time ${screen} h`, value: screen, units: 'h' })
    }
  })

  /* ---- journal: self-rated mood and focus, roughly quarterly */
  const journal = ['2023-04-09', '2023-07-16', '2023-10-22', '2024-01-14', '2024-04-21', '2024-10-27', '2025-01-19', '2025-04-13', '2025-07-20', '2025-10-12', '2026-01-18', '2026-04-12', '2026-07-19', '2026-09-20']
  journal.forEach((d, i) => {
    event(b, `journal-${i + 1}`, `Journal entry, ${+d.slice(8)} ${MON[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`, d, 'journal')
    const low = d >= '2024-10' && d < '2026-01'
    const mood = low ? 5 + Math.round(rnd()) : 7 + Math.round(rnd())
    const focus = low ? 4 + Math.round(rnd()) : 7
    obs(b, { id: `mood-${i + 1}`, ev: `journal-${i + 1}`, date: d, marker: mk('Mood, self-rated'), label: `Mood ${mood}/10`, value: mood, units: '/10', system: 'mind' })
    obs(b, { id: `focus-${i + 1}`, ev: `journal-${i + 1}`, date: d, marker: mk('Afternoon focus, self-rated'), label: `Afternoon focus ${focus}/10`, value: focus, units: '/10', structure: 'cortex' })
  })

  /* ---- context: caffeine log and travel */
  const caffeine = ['2023-03', '2023-06', '2023-09', '2023-12', '2024-03', '2024-11', '2025-02', '2025-05', '2025-08', '2025-11', '2025-12', '2026-02', '2026-05', '2026-08']
  caffeine.forEach((ym, i) => {
    const d = `${ym}-15`
    event(b, `caff-${i + 1}`, `Caffeine log, ${MON[+ym.slice(5) - 1]} ${ym.slice(0, 4)}`, d, 'self-report')
    const cups = ym < '2024-03' ? 0.5 : ym < '2025-12' ? 1.5 + (ym >= '2025-01' ? 0.5 : 0) : 0.2
    obs(b, { id: `cups-${i + 1}`, ev: `caff-${i + 1}`, date: d, marker: mk('Caffeine after 2 pm'), label: `Caffeine after 2 pm, ${cups} cups a day`, value: cups, units: 'cups/day', structure: 'intake' })
  })
  const trips = ['2023-05-02', '2023-11-08', '2024-02-19', '2025-03-10', '2025-09-01', '2026-03-23']
  trips.forEach((d, i) => {
    event(b, `trip-${i + 1}`, `Long-haul trip, ${+d.slice(8)} ${MON[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`, d, 'calendar')
    obs(b, { id: `tz-${i + 1}`, ev: `trip-${i + 1}`, date: d, marker: mk('Time zones crossed'), label: `Time zones crossed: ${[8, 5, 8, 9, 6, 8][i]}`, value: [8, 5, 8, 9, 6, 8][i], units: 'zones', structure: 'travel' })
  })

  /* ---- a home sleep study */
  event(b, 'study-1', 'Home sleep study, 14 Aug 2025', '2025-08-14', 'clinic-report')
  obs(b, { id: 'ahi-1', ev: 'study-1', date: '2025-08-14', marker: mk('Apnoea–hypopnoea index'), label: 'AHI 3.2 events/h', value: 3.2, units: 'events/h', ref: { high: 5, source: 'Sample clinic (fictional)' }, structure: 'airway' })
  obs(b, { id: 'spo2-1', ev: 'study-1', date: '2025-08-14', marker: mk('Lowest oxygen saturation'), label: 'Lowest SpO2 91%', value: 91, units: '%', ref: { low: 90, source: 'Sample clinic (fictional)' }, structure: 'airway' })

  /* ---- reasoning */
  const hyp = (id: string, label: string, territory: string, u: Uncertainty | null, flags?: string[]) =>
    b.items.push({ id: P + id, kind: 'hypothesis', label, status: 'current', at: at('2025-02-01'), uncertainty: u, flags, meta: { territory, domain_status: 'open' } })
  hyp('h-caffeine', 'Late caffeine delays sleep onset', 'sleep', { method: 'atlas-recorded-confidence', label: 'Recorded confidence; not a calibrated probability', value: 0.64 })
  hyp('h-iron', 'Low iron stores contribute to morning fatigue', 'metabolic', { method: 'nal', f: 0.72, c: 0.41 }, ['affected-by-correction'])
  hyp('h-thyroid', 'A slow thyroid shift explains the low energy', 'endocrine', null)
  hyp('h-travel', 'Jet lag, not caffeine, drives the worst nights', 'context', { method: 'qualitative', status: 'contested' })
  hyp('h-mood', 'Mood dips follow weeks of short sleep', 'mind', { method: 'pln', strength: 0.55, confidence: 0.3 })

  const ev = (o: string, rel: string, h: string, w?: number) => link(b, P + o, rel, P + h, w)
  ;['sol-2025-02', 'sol-2025-05', 'sol-2025-08', 'sol-2025-10', 'cups-8', 'cups-9', 'sol-2026-02', 'sol-2026-05'].forEach((o) => ev(o, 'supports', 'h-caffeine', 0.6))
  ev('sol-2024-11', 'contradicts', 'h-caffeine', 0.3)
  ev('tz-4', 'qualifies', 'h-caffeine', 0.4)
  ;['ferritin-3x', 'ferritin-4', 'ferritin-5', 'hb-4'].forEach((o) => ev(o, 'supports', 'h-iron', 0.5))
  ev('ferritin-3', 'supports', 'h-iron', 0.5)
  ev('focus-8', 'qualifies', 'h-iron', 0.2)
  ev('tsh-4', 'supports', 'h-thyroid', 0.4)
  ev('tsh-5', 'supports', 'h-thyroid', 0.5)
  ev('ft4-5', 'contradicts', 'h-thyroid', 0.5)
  ev('tsh-5r', 'contradicts', 'h-thyroid', 0.4)
  ;['tz-4', 'tz-5'].forEach((o) => ev(o, 'supports', 'h-travel', 0.4))
  ;['sol-2025-08', 'sol-2025-10'].forEach((o) => ev(o, 'contradicts', 'h-travel', 0.5))
  ;['mood-7', 'mood-8', 'eff-2025-02'].forEach((o) => ev(o, 'supports', 'h-mood', 0.4))

  const pred = (id: string, label: string, h: string, due: string, status: string, u: Uncertainty | null) => {
    b.items.push({ id: P + id, kind: 'prediction', label, status: 'current', at: at('2025-11-20'), uncertainty: u, meta: { due, domain_status: status } })
    link(b, P + h, 'predicts', P + id)
  }
  pred('p-cutoff', 'If caffeine stops by 2 pm, sleep onset falls under 25 minutes within six weeks', 'h-caffeine', '2026-01-31', 'met', { method: 'qualitative', status: 'met' })
  pred('p-ferritin', 'Ferritin rises above 40 ng/mL after three months of iron', 'h-iron', '2026-06-30', 'open', null)
  pred('p-tsh', 'A repeat TSH stays under 4.0 mIU/L', 'h-thyroid', '2025-07-01', 'met', { method: 'qualitative', status: 'met' })
  pred('p-mood', 'Mood scores rise when sleep efficiency stays above 88%', 'h-mood', '2026-10-31', 'open', null)

  const exp = (id: string, label: string, h: string, status: string, from: string) => {
    b.items.push({ id: P + id, kind: 'experiment', label, status: 'current', at: at(from), meta: { domain_status: status, started: from } })
    link(b, P + id, 'tests', P + h)
  }
  exp('e-cutoff', 'Caffeine cutoff at 2 pm for six weeks', 'h-caffeine', 'completed', '2025-12-01')
  exp('e-iron', 'Iron with vitamin C at breakfast, three months', 'h-iron', 'active', '2026-06-10')
  exp('e-wake', 'Fixed wake time, weekends included', 'h-mood', 'planned', '2026-10-15')

  const lit = (id: string, label: string, rel: string, h: string) => {
    b.items.push({ id: P + id, kind: 'literature', label, status: 'current', meta: { sample: true }, sources: [{ id: P + id, label, local_ref: P + id, origin: P + id, status: 'cited' }] })
    link(b, P + id, rel, P + h)
  }
  lit('l-caffeine', 'Sample citation: evening caffeine and sleep latency (fictional review)', 'supports', 'h-caffeine')
  lit('l-clearance', 'Sample citation: individual differences in caffeine clearance (fictional)', 'qualifies', 'h-caffeine')
  lit('l-iron', 'Sample citation: iron stores and fatigue without anaemia (fictional)', 'supports', 'h-iron')
  lit('l-tsh', 'Sample citation: TSH variation between repeated tests (fictional)', 'qualifies', 'h-thyroid')
  lit('l-travel', 'Sample citation: circadian misalignment after eastward travel (fictional)', 'supports', 'h-travel')
  lit('l-mood', 'Sample citation: sleep restriction and next-day affect (fictional)', 'supports', 'h-mood')

  // a hypothesis weakened by a correction is flagged by Atlas itself; the projection's question is the focus
  return {
    contract: '0.2',
    program: 'atlas',
    revision: messy ? 'sample-messy-r1' : 'sample-r1',
    focus: P + 'question',
    title: `${name}: sample Atlas`,
    items: b.items,
    links: b.links,
    groups: [],
    notes: ['SAMPLE: every record here is invented. Subject A is fictional.', 'Observations are recorded claims. Truth lives nowhere in Atlas.'],
  }
}

/** The empty Atlas a non-owner or a newcomer receives. */
export const EMPTY_GRAPH: WorkGraph = { revision: 'empty', items: [], links: [], groups: [], notes: [] }
