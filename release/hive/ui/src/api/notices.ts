/** G2 notices and G4 daily spend: the person's own, read from the host. Text is plain text, shown as text only. */
import { askInteger, askObject } from './appAsk'

export const NOTICE_CAPS = [0, 1, 3, 5, 8] as const
export interface NoticePrefs { cap: number; quiet_start: string | null; quiet_end: string | null; tz: string; caps?: number[]; urgent_kinds?: string[] }
export interface NoticeItem {
  id: string; seq: number; kind: 'notice' | 'reminder' | 'digest'; text: string; from: string | null; at: string
  state: string; urgent: string | null; items?: NoticeItem[]
}
export interface NoticeList { notices: NoticeItem[]; waiting: number; prefs: NoticePrefs }
/** The frame reads (P1 ops `notices` and `spend`), as the host answers them. */
/** `seq` is the delivery order (a released notice gets a new one, after any cursor); a released notice names its digest. */
export interface FrameNotices { notices: (Omit<NoticeItem, 'items'> & { digest_id?: string | null })[]; cursor: number; more: boolean }
export interface FrameSpend { tz: string; days: { date: string; total_usd: number; this_app_usd: number }[]; total_usd: number; this_app_usd: number }

const str = (v: unknown, max: number) => typeof v === 'string' && v.length <= max
const time = (v: unknown) => v === null || (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v))
const money = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0

export function readNoticePrefs(v: unknown): NoticePrefs | null {
  return askObject(v) && askInteger(v.cap) && (NOTICE_CAPS as readonly number[]).includes(v.cap) && time(v.quiet_start) && time(v.quiet_end) && str(v.tz, 80) ? v as unknown as NoticePrefs : null
}

function readItem(v: unknown, depth = 0): NoticeItem | null {
  if (!askObject(v) || !str(v.id, 80) || !askInteger(v.seq) || !['notice', 'reminder', 'digest'].includes(v.kind as string) || !str(v.text, 2000)
    || !(v.from === null || v.from === undefined || str(v.from, 200)) || !str(v.at, 40)) return null
  if (v.items !== undefined && (depth > 0 || !Array.isArray(v.items) || v.items.length > 500 || !v.items.every((i) => readItem(i, 1)))) return null
  return v as unknown as NoticeItem
}

export function readNoticeList(v: unknown): NoticeList | null {
  return askObject(v) && Array.isArray(v.notices) && v.notices.length <= 100 && v.notices.every((n) => readItem(n)) && askInteger(v.waiting) && readNoticePrefs(v.prefs) ? v as unknown as NoticeList : null
}

export function readFrameNotices(v: unknown): FrameNotices | null {
  return askObject(v) && Array.isArray(v.notices) && v.notices.length <= 20 && v.notices.every((n) => readItem(n) && !(n as NoticeItem).items) && askInteger(v.cursor) && typeof v.more === 'boolean'
    ? { notices: v.notices as FrameNotices['notices'], cursor: v.cursor, more: v.more } : null
}

export function readFrameSpend(v: unknown): FrameSpend | null {
  return askObject(v) && str(v.tz, 80) && money(v.total_usd) && money(v.this_app_usd) && Array.isArray(v.days) && v.days.length <= 31
    && v.days.every((d) => askObject(d) && str(d.date, 10) && money(d.total_usd) && money(d.this_app_usd))
    ? { tz: v.tz as string, days: v.days as FrameSpend['days'], total_usd: v.total_usd as number, this_app_usd: v.this_app_usd as number } : null
}
