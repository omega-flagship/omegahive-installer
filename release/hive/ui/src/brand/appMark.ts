/**
 * An app's own mark, made from its identity (Ask-and-apps contract R1.1 §3; Dot 3 Nov: real identity art on the awake
 * tiles, every look). The identity set gives each app its colours, a heading type pairing and a background motif
 * (shell/appLook); this draws that motif in the app's colours under a monogram in its own type. Pure and deterministic:
 * the same app is the same mark in every look and on every device. Square art, full bleed: each look clips it to its
 * own tile shape. An app with no identity theme gets one from its identity colour and a motif chosen by its id.
 */
import type { AppTheme } from '../shell/appLook'
import { TYPE_FONTS } from '../shell/appLook'

const MOTIFS: AppTheme['motif'][] = ['constellation', 'strata', 'lattice', 'grain', 'rings', 'ruled', 'blueprint']

const hash = (s: string): number => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0; return h }
const rnd = (seed: number) => () => { seed = (Math.imul(seed ^ (seed >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return (seed % 10000) / 10000 }
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** One or two letters: the first letters of the first two words (the name as people say it). */
export function monogram(name: string): string {
  const all = name.replace(/\(.*?\)/g, ' ').split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  // a leading article says nothing about the app: 'The evidence room' is ER, not TE
  const words = all.length > 1 && /^(the|a|an)$/i.test(all[0]) ? all.slice(1) : all
  if (!words.length) return 'Ω'
  const caps = words[0].match(/[A-Z]/g)
  // a CamelCase single word (OmegaDesign) keeps its two capitals
  if (words.length === 1 && caps && caps.length >= 2) return caps.slice(0, 2).join('')
  return (words[0][0] + (words[1]?.[0] ?? '')).toUpperCase()
}

/** A theme for an app with none: its identity colour, a darker surface of it, and a motif from its id. */
export function themeFromColour(id: string, colour: string): AppTheme {
  const c = /^#[0-9a-f]{6}$/i.test(colour) ? colour : '#7c8cff'
  const dark = '#' + [1, 3, 5].map((i) => Math.round(parseInt(c.slice(i, i + 2), 16) * 0.22 + 8).toString(16).padStart(2, '0')).join('')
  return { accent: c, accent_2: '#ffffff', surface: dark, ink: '#f4f6ff', type: 'humanist', motif: MOTIFS[hash(id) % MOTIFS.length], density: 'regular' }
}

function motifSvg(motif: AppTheme['motif'], accent: string, seed: number): string {
  const r = rnd(seed), a = (o: number) => `stroke="${accent}" stroke-opacity="${o}"`
  switch (motif) {
    case 'constellation': {
      const pts = Array.from({ length: 7 }, () => [8 + r() * 48, 8 + r() * 48])
      return pts.map(([x, y], i) => (i ? `<line x1="${pts[i - 1][0].toFixed(1)}" y1="${pts[i - 1][1].toFixed(1)}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" ${a(0.35)} stroke-width="0.8"/>` : '') + `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(0.9 + r() * 1.1).toFixed(1)}" fill="${accent}" fill-opacity="0.7"/>`).join('')
    }
    case 'strata': return [0, 1, 2, 3, 4].map((i) => `<path d="M0 ${12 + i * 10} Q16 ${8 + i * 10 + r() * 6} 32 ${12 + i * 10} T64 ${12 + i * 10}" fill="none" ${a(0.18 + i * 0.05)} stroke-width="2.2"/>`).join('')
    case 'lattice': return Array.from({ length: 9 }, (_, i) => `<line x1="${i * 8 - 16}" y1="0" x2="${i * 8 + 16}" y2="64" ${a(0.22)} stroke-width="0.8"/><line x1="${i * 8 + 16}" y1="0" x2="${i * 8 - 16}" y2="64" ${a(0.22)} stroke-width="0.8"/>`).join('')
    case 'grain': return Array.from({ length: 60 }, () => `<circle cx="${(r() * 64).toFixed(1)}" cy="${(r() * 64).toFixed(1)}" r="0.7" fill="${accent}" fill-opacity="${(0.15 + r() * 0.35).toFixed(2)}"/>`).join('')
    case 'rings': return [10, 18, 26, 34].map((rr, i) => `<circle cx="46" cy="46" r="${rr}" fill="none" ${a(0.32 - i * 0.06)} stroke-width="1.6"/>`).join('')
    case 'ruled': return Array.from({ length: 8 }, (_, i) => `<line x1="6" y1="${8 + i * 7}" x2="58" y2="${8 + i * 7}" ${a(0.16)} stroke-width="0.7"/>`).join('')
    case 'blueprint': return Array.from({ length: 7 }, (_, i) => `<line x1="${8 + i * 8}" y1="0" x2="${8 + i * 8}" y2="64" ${a(0.16)} stroke-width="0.6"/><line x1="0" y1="${8 + i * 8}" x2="64" y2="${8 + i * 8}" ${a(0.16)} stroke-width="0.6"/>`).join('')
    default: return ''
  }
}

/** The app's mark as SVG source (64×64, full bleed). */
export function appMarkSvg(app: { id: string; name: string }, theme: AppTheme): string {
  const seed = hash(app.id)
  const font = TYPE_FONTS[theme.type] ?? TYPE_FONTS.humanist
  const letters = esc(monogram(app.name))
  // ids are per app, so marks drawn inline on one page never borrow each other's gradient
  const gid = `am${seed.toString(36)}`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">` +
    `<defs><radialGradient id="${gid}" cx="30%" cy="25%" r="90%"><stop offset="0" stop-color="${theme.accent}" stop-opacity="0.55"/><stop offset="0.55" stop-color="${theme.surface}"/><stop offset="1" stop-color="${theme.surface}"/></radialGradient></defs>` +
    `<rect width="64" height="64" fill="url(#${gid})"/>${motifSvg(theme.motif, theme.accent, seed)}` +
    `<text x="32" y="33" text-anchor="middle" dominant-baseline="central" font-family="${esc(font)}" font-size="${letters.length > 1 ? 24 : 30}" font-weight="600" fill="${theme.ink}" letter-spacing="${letters.length > 1 ? -0.5 : 0}">${letters}</text></svg>`
}

/** The mark as a data URL, for an <img> or a texture. */
export const appMarkUrl = (app: { id: string; name: string }, theme: AppTheme): string => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(appMarkSvg(app, theme))
