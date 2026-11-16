/** One furniture palette. Artwork, source imagery, charts and per-mind identity hue are content exceptions. */
export const P = {
  ink: '#17212f', muted: '#536176', secondary: '#475569', buttonInk: '#26364b',
  line: '#d5dae3', edge: '#7c8799', separator: '#e8ebf0', scrollbar: '#a7b0c0', dot: '#8d9ab0',
  accent: '#315ed4', accentStrong: '#244aa7', surface: '#fff', page: '#f6f7f9', raised: '#f2f4f7',
  hover: '#f1f4f9', rowHover: '#f7f9fc', selected: '#edf1fc', badge: '#e5eaf7', neutral: '#f0f2f6',
  personBubble: '#f0f4ff', personLine: '#ccd7f6', success: '#236047', successSurface: '#e8f5ed',
  danger: '#ac2531', error: '#982431', errorSurface: '#fff0f2', notice: '#7b2433',
  noticeSurface: '#fff1f3', noticeEdge: '#b94d63',
  font: "'Inter Variable', Inter, system-ui, sans-serif",
  scrim: 'rgb(17 24 39 / 0.32)', shadow: '0 22px 70px -22px rgb(17 24 39 / 0.3)',
}
export const TOKENS: Record<string, string> = Object.fromEntries(Object.entries(P).map(([key, value]) => [`--pr-${key}`, value]))
