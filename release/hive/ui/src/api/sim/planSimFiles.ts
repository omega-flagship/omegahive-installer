/**
 * SIM: the files the invented plan writes for "a small web page that shows the weather in London" (planSim.ts). Real,
 * working code: index.html links ./style.css, ./app.js and ./icon.svg in the exact form the app frame inlines
 * (lib/appFrame appDocument); app.js fills the card from an inline invented forecast, with no network. Invented data.
 */

/** the empty app the plan starts from (each file a placeholder until its piece is integrated) */
export const SCAFFOLD: Record<string, string> = {
  'index.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>New app</title>
  <link rel="stylesheet" href="./style.css">
</head>
<body>
  <script type="module" src="./app.js"></script>
</body>
</html>
`,
  'style.css': '/* nothing here yet */\n',
  'app.js': '// nothing here yet\n',
  'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"></svg>\n',
}

export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>London weather</title>
  <link rel="stylesheet" href="./style.css">
</head>
<body>
  <main class="card" aria-live="polite">
    <header class="head">
      <img class="icon" src="./icon.svg" alt="" width="64" height="64">
      <div>
        <h1 class="city">London</h1>
        <p class="when" id="when">Right now</p>
      </div>
    </header>
    <p class="temp" id="temp">--</p>
    <p class="sky" id="sky">Fetching the weather…</p>
    <h2 class="next">Next three days</h2>
    <ul class="days" id="days">
      <li class="day">…</li>
    </ul>
  </main>
  <script type="module" src="./app.js"></script>
</body>
</html>
`

const PALETTES = {
  calm: { bg: '#eef2f5', card: '#ffffff', ink: '#23313d', soft: '#6b7c8a', accent: '#4f7cac', line: '#dde4ea', font: '"Helvetica Neue", Arial, sans-serif', radius: '14px' },
  bright: { bg: '#ffe066', card: '#fff8e1', ink: '#3d1f5c', soft: '#8a4fbf', accent: '#ff5d73', line: '#ffd23f', font: '"Trebuchet MS", "Comic Sans MS", sans-serif', radius: '26px' },
}
export type Palette = keyof typeof PALETTES
/** the person's answer to the look question picks the palette (calm unless they asked for bright or playful) */
export const paletteFor = (answer: string | null): Palette => (answer && /bright|playful/i.test(answer) ? 'bright' : 'calm')

export function styleCss(p: Palette): string {
  const c = PALETTES[p]
  return `/* ${p === 'calm' ? 'Calm and minimal' : 'Bright and playful'} */
:root {
  --bg: ${c.bg};
  --card: ${c.card};
  --ink: ${c.ink};
  --soft: ${c.soft};
  --accent: ${c.accent};
  --line: ${c.line};
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: var(--bg);
  color: var(--ink);
  font-family: ${c.font};
}
.card {
  width: min(360px, calc(100vw - 32px));
  padding: 24px;
  background: var(--card);
  border-radius: ${c.radius};
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.08);
}
.head { display: flex; align-items: center; gap: 14px; }
.icon { flex: none; }
.city { margin: 0; font-size: 22px; }
.when { margin: 2px 0 0; color: var(--soft); font-size: 14px; }
.temp { margin: 18px 0 4px; font-size: 56px; font-weight: 700; color: var(--accent); }
.sky { margin: 0 0 18px; color: var(--soft); }
.next { margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--soft); }
.days { list-style: none; margin: 0; padding: 0; }
.day {
  display: flex;
  justify-content: space-between;
  padding: 8px 0;
  border-top: 1px solid var(--line);
}
.day .lo { color: var(--soft); margin-left: 8px; }
`
}

/** app.js: `fixed` adds the "°C" the units check asks for (the first draft leaves it out) */
export function appJs(fixed: boolean): string {
  return `// London weather: an invented forecast, drawn without any network call.
export const forecast = {
  city: 'London',
  now: { temp: 14, sky: 'Light cloud', wind: 11 },
  days: [
    { day: 'Tue', high: 15, low: 9, sky: 'Showers' },
    { day: 'Wed', high: 17, low: 10, sky: 'Sunny spells' },
    { day: 'Thu', high: 13, low: 8, sky: 'Rain' },
  ],
}

export function formatTemp(t) {
  return ${fixed ? '`${Math.round(t)}°C`' : 'String(Math.round(t))'}
}

function dayRow(d) {
  const li = document.createElement('li')
  li.className = 'day'
  const name = document.createElement('span')
  name.textContent = \`\${d.day} · \${d.sky}\`
  const temps = document.createElement('span')
  const lo = document.createElement('span')
  lo.className = 'lo'
  lo.textContent = formatTemp(d.low)
  temps.append(formatTemp(d.high), lo)
  li.append(name, temps)
  return li
}

export function render(data) {
  document.getElementById('temp').textContent = formatTemp(data.now.temp)
  document.getElementById('sky').textContent = \`\${data.now.sky} · wind \${data.now.wind} km/h\`
  document.getElementById('days').replaceChildren(...data.days.map(dayRow))
}

if (typeof document !== 'undefined') render(forecast)
`
}

/** the acceptance check the test author writes first (the engine's contract: checks/acceptance_check.py, Python stdlib
 * only, run in the checkpoint's files; its last line is CREATE-CHECK {passed, failing, notes}) */
export const CHECK_PATH = 'checks/acceptance_check.py'
export const CHECK_PY = `import json, pathlib, re

def read(name):
    p = pathlib.Path(name)
    return p.read_text("utf-8") if p.exists() else ""

failing, notes = [], []
app = read("app.js")
if "London" not in app or "days" not in app:
    failing.append("app.js"); notes.append("1 failed: shows the temperature for London")
elif "\\u00b0C" not in app and "°C" not in app:
    failing.append("app.js"); notes.append('1 failed: shows "°C" after the temperature')
if 'src="./app.js"' not in read("index.html"):
    failing.append("index.html")
print("CREATE-CHECK " + json.dumps({"passed": not failing, "failing": failing, "notes": notes}))
`

export const TEST_JS = `import { test, expect } from 'vitest'
import { forecast, formatTemp } from '../app.js'

test('shows the temperature for London', () => {
  expect(forecast.city).toBe('London')
  expect(typeof forecast.now.temp).toBe('number')
  expect(forecast.days).toHaveLength(3)
})

test('shows "°C" after the temperature', () => {
  expect(formatTemp(14)).toBe('14°C')
  expect(formatTemp(13.6)).toBe('14°C')
})
`

export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Sun behind a cloud">
  <g stroke="#f4b400" stroke-width="3" stroke-linecap="round">
    <line x1="24" y1="6" x2="24" y2="12"/>
    <line x1="8" y1="22" x2="14" y2="22"/>
    <line x1="12.7" y1="10.7" x2="16.9" y2="14.9"/>
    <line x1="35.3" y1="10.7" x2="31.1" y2="14.9"/>
  </g>
  <circle cx="24" cy="24" r="9" fill="#ffcc33"/>
  <path d="M20 50h28a10 10 0 0 0 0-20a14 14 0 0 0-26 4a8 8 0 0 0-2 16z" fill="#dfe6ee" stroke="#9fb0c0" stroke-width="2"/>
</svg>
`
