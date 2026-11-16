/**
 * Small 5-field cron toolkit for wakeups: parse, validate, describe in plain words and find
 * the next run in a given IANA time zone. Supports `*`, lists, ranges, steps and month / weekday
 * names. Day-of-month and day-of-week follow Vixie semantics (either matches when both are set).
 */

export interface CronSpec {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  domAny: boolean
  dowAny: boolean
  fields: string[]
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const BOUNDS: [number, number, string[] | null][] = [
  [0, 59, null],
  [0, 23, null],
  [1, 31, null],
  [1, 12, MONTHS],
  [0, 7, DAYS],
]
const LABELS = ['minute', 'hour', 'day of month', 'month', 'day of week']

function num(tok: string, names: string[] | null, offset: number): number {
  const lower = tok.toLowerCase()
  if (names) {
    const i = names.indexOf(lower)
    if (i >= 0) return i + offset
  }
  if (!/^\d+$/.test(tok)) return NaN
  return Number(tok)
}

function parseField(src: string, idx: number): Set<number> {
  const [lo, hi, names] = BOUNDS[idx]
  const offset = idx === 3 ? 1 : 0
  const out = new Set<number>()
  for (const part of src.split(',')) {
    if (!part) throw new Error(`Empty ${LABELS[idx]} entry`)
    const [range, stepStr] = part.split('/')
    const step = stepStr === undefined ? 1 : Number(stepStr)
    if (!Number.isInteger(step) || step < 1) throw new Error(`Bad step in ${LABELS[idx]}`)
    let a: number
    let b: number
    if (range === '*') {
      a = lo
      b = idx === 4 ? 6 : hi
    } else if (range.includes('-')) {
      const [x, y] = range.split('-')
      a = num(x, names, offset)
      b = num(y, names, offset)
    } else {
      a = num(range, names, offset)
      b = stepStr === undefined ? a : idx === 4 ? 6 : hi
    }
    if (Number.isNaN(a) || Number.isNaN(b)) throw new Error(`Unknown ${LABELS[idx]} “${range}”`)
    if (a < lo || b > hi || a > b) throw new Error(`${LABELS[idx][0].toUpperCase()}${LABELS[idx].slice(1)} must be ${lo}–${hi}`)
    for (let v = a; v <= b; v += step) out.add(idx === 4 && v === 7 ? 0 : v)
  }
  return out
}

export function parseCron(src: string): CronSpec {
  const fields = src.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error('A cron needs 5 fields: minute hour day month weekday')
  const sets = fields.map((f, i) => parseField(f, i))
  return {
    minute: sets[0],
    hour: sets[1],
    dom: sets[2],
    month: sets[3],
    dow: sets[4],
    domAny: fields[2] === '*',
    dowAny: fields[4] === '*',
    fields,
  }
}

/** null when valid, otherwise a short human message. */
export function cronError(src: string): string | null {
  try {
    parseCron(src)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : 'Invalid cron'
  }
}

// ---------------------------------------------------------------- time zones

const fmtCache = new Map<string, Intl.DateTimeFormat>()
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    })
    fmtCache.set(tz, f)
  }
  return f
}

export function isValidTz(tz: string): boolean {
  try {
    formatter(tz)
    return true
  } catch {
    return false
  }
}

export interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  dow: number
}

/** The wall-clock fields of an instant in a time zone. */
export function wallClock(ms: number, tz: string): WallClock {
  const parts = formatter(tz).formatToParts(new Date(ms))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    dow: DAYS.indexOf(get('weekday').toLowerCase().slice(0, 3)),
  }
}

function dayMatches(s: CronSpec, w: WallClock): boolean {
  const d = s.dom.has(w.day)
  const k = s.dow.has(w.dow)
  if (s.domAny && s.dowAny) return true
  if (s.domAny) return k
  if (s.dowAny) return d
  return d || k
}

/** The next instant strictly after `from` that matches the cron in `tz`, or null within ~2 years. */
export function nextRun(cron: string | CronSpec, tz = 'UTC', from: number = Date.now()): Date | null {
  const s = typeof cron === 'string' ? parseCron(cron) : cron
  let t = Math.floor(from / 60_000) * 60_000 + 60_000
  const limit = from + 2 * 366 * 86_400_000
  for (let i = 0; i < 200_000 && t < limit; i++) {
    const w = wallClock(t, tz)
    if (!s.month.has(w.month) || !dayMatches(s, w)) {
      t += ((23 - w.hour) * 60 + (60 - w.minute)) * 60_000
      continue
    }
    if (!s.hour.has(w.hour)) {
      t += (60 - w.minute) * 60_000
      continue
    }
    if (!s.minute.has(w.minute)) {
      t += 60_000
      continue
    }
    return new Date(t)
  }
  return null
}

// ---------------------------------------------------------------- words

const pad = (n: number) => String(n).padStart(2, '0')
const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`
}
const joinList = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)
const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b)
const stepOf = (field: string) => {
  const m = /^\*\/(\d+)$/.exec(field)
  return m ? Number(m[1]) : null
}
const isNum = (field: string) => /^\d+$/.test(field)

function dayPhrase(s: CronSpec): { kind: 'daily' | 'weekdays' | 'weekends' | 'dow' | 'dom' | 'year' | 'other'; text: string } {
  const monthAny = s.fields[3] === '*'
  if (s.domAny && s.dowAny && monthAny) return { kind: 'daily', text: '' }
  if (s.domAny && monthAny && !s.dowAny) {
    const days = sorted(s.dow)
    if (days.join() === '1,2,3,4,5') return { kind: 'weekdays', text: 'weekdays' }
    if (days.join() === '0,6') return { kind: 'weekends', text: 'weekends' }
    if (days.length === 1) return { kind: 'dow', text: `${DAY_NAMES[days[0]]}s` }
    const order = days.filter((d) => d !== 0).concat(days.includes(0) ? [0] : [])
    return { kind: 'dow', text: joinList(order.map((d) => DAY_NAMES[d].slice(0, 3))) }
  }
  if (!s.domAny && s.dowAny && isNum(s.fields[2])) {
    const d = Number(s.fields[2])
    if (monthAny) return { kind: 'dom', text: `the ${ordinal(d)} of every month` }
    if (isNum(s.fields[3])) return { kind: 'year', text: `${d} ${MONTH_NAMES[Number(s.fields[3]) - 1]}` }
  }
  return { kind: 'other', text: '' }
}

/**
 * Plain-English description, e.g. "Weekdays at 09:00", "Every 15 minutes", "Mondays at 18:30".
 * Returns null when the expression is valid but too irregular to say briefly.
 */
export function describeCron(src: string): string | null {
  let s: CronSpec
  try {
    s = parseCron(src)
  } catch {
    return null
  }
  const [mi, ho] = s.fields
  const day = dayPhrase(s)
  if (day.kind === 'other') return null

  // fixed times of day
  if (isNum(mi) && /^\d+(,\d+)*$/.test(ho) && s.hour.size <= 4) {
    const times = joinList(sorted(s.hour).map((h) => `${pad(h)}:${pad(Number(mi))}`))
    switch (day.kind) {
      case 'daily':
        return `Every day at ${times}`
      case 'weekdays':
        return `Weekdays at ${times}`
      case 'weekends':
        return `Weekends at ${times}`
      case 'dow':
        return `${day.text} at ${times}`
      case 'dom':
        return `On ${day.text} at ${times}`
      case 'year':
        return `Every year on ${day.text} at ${times}`
    }
  }

  // intervals
  let interval: string | null = null
  const mStep = stepOf(mi)
  const hStep = stepOf(ho)
  if (mi === '*' && ho === '*') interval = 'Every minute'
  else if (mStep && ho === '*') interval = mStep === 1 ? 'Every minute' : `Every ${mStep} minutes`
  else if (isNum(mi) && ho === '*') interval = Number(mi) === 0 ? 'Every hour' : `Every hour at :${pad(Number(mi))}`
  else if (isNum(mi) && hStep) interval = `Every ${hStep === 1 ? 'hour' : `${hStep} hours`}${Number(mi) ? ` at :${pad(Number(mi))}` : ''}`
  if (!interval) return null
  if (day.kind === 'daily') return interval
  if (day.kind === 'weekdays' || day.kind === 'weekends') return `${interval} on ${day.text}`
  if (day.kind === 'dow') return `${interval} on ${day.text}`
  return `${interval}, on ${day.text}`
}

export const localTz = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** Common presets offered by the wakeup composer. */
export const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: 'Every morning', cron: '0 9 * * *' },
  { label: 'Weekdays 09:00', cron: '0 9 * * 1-5' },
  { label: 'Hourly', cron: '0 * * * *' },
  { label: 'Every 15 min', cron: '*/15 * * * *' },
  { label: 'Fridays 17:00', cron: '0 17 * * 5' },
]

/** `datetime-local` value (wall clock in `tz`) → UTC ISO. */
export function zonedToUtc(local: string, tz: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local)
  if (!m) return null
  const [y, mo, d, h, mi] = m.slice(1).map(Number)
  const guess = Date.UTC(y, mo - 1, d, h, mi)
  // correct by the zone's offset at that instant (twice, to settle across DST edges)
  let t = guess
  for (let i = 0; i < 2; i++) {
    const w = wallClock(t, tz)
    const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute)
    t += guess - asUtc
  }
  return new Date(t).toISOString()
}
