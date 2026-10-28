import { plural } from '../../lib/plural'
import { useRef } from 'react'
import { presenceRef, shown, type Agent, type Swarm } from '../sdk'
import type { LocalPose } from './binding'
import { HEIGHT, PLACES, WIDTH, districtPoint, residentPlacements, robotAnimal, type PlaceId, type Point } from './world'

/** Art is local scenery, never a native activity, online person or physical simulation. */
function Tree({ x, y, size = 1 }: { x: number; y: number; size?: number }) {
  return <g transform={`translate(${x} ${y}) scale(${size})`}><ellipse cy="16" rx="31" ry="12" fill="#133e3233" /><path d="M-4 12L-3-46H6L5 13Z" fill="#835b3c" /><path d="M-32-32Q-47-54-22-68Q-12-100 12-81Q46-82 37-53Q51-29 25-23Q-2-9-32-32Z" fill="#488862" /><path d="M-27-44Q-37-62-15-67Q-8-84 8-76Q34-73 31-58Q8-48-27-44" fill="#75a76d" /><path d="M2-65L-1 7M-1-24L-15-39M0-35L17-48" stroke="#657851" strokeWidth="3" fill="none" /></g>
}
function Building({ id, x, y, kit }: { id: PlaceId; x: number; y: number; kit: LocalPose['kit'] }) {
  const code = id === 'code', design = id === 'design', future = kit === 'future'
  const wall = code ? '#344751' : design ? '#f3dfc0' : kit === 'woodland' ? '#c89c63' : '#c6d2d8'
  const roof = code ? '#3b5161' : design ? '#ecae67' : future ? '#9195c8' : '#719083'
  return <g transform={`translate(${x} ${y})`}>
    <ellipse cy="18" rx="103" ry="31" fill="#143d3430" />
    <path d="M-85-10L0 30L86-10L0-48Z" fill="#98a993" /><path d="M-68-86L0-52V18L-68-16Z" fill={wall} /><path d="M0-52L69-87V-16L0 18Z" fill={code ? '#213640' : '#b7c4b3'} />
    <path d="M-79-85L-3-146L79-86L0-43Z" fill={roof} /><path d="M-3-146L0-43L79-86Z" fill={code ? '#4e7689' : '#56776e'} />
    {future && <><path d="M-55-82V-131L0-160L53-132V-80" stroke="#bdf2f2" strokeWidth="3" fill="none" /><circle cy="-158" r="9" fill="#caffdf" /></>}
    {[-47, -22].map((n) => <g key={n}><path d={`M${n}-72l16 8v23l-16-8Z`} fill={code ? '#74dad4' : '#537d85'} /><path d={`M${n+7}-68v23`} stroke="#d0e7dd" strokeWidth="2" /></g>)}
    <path d="M14-46L40-58V-3L14 9Z" fill={code ? '#de93de' : '#476c65'} /><path d="M19-43L34-50V-10L19-3Z" fill="#83b6b2" />
    <path d="M-56-26L-12-4" stroke={kit === 'woodland' ? '#986f46' : '#dde5dd'} strokeWidth="3" />
    {code && <g transform="translate(-36 -108)" stroke="#b9f9e0" strokeWidth="3" fill="none"><path d="M-9-7L-16 0L-9 7M9-7L16 0L9 7M4-10L-3 10" /></g>}
    {design && <g transform="translate(-33 -109)"><path d="M-9 12L-4-9L9-5L4 16Z" fill="#fff7df" /><path d="M-1-15L3-22L10-19L9-11Z" fill="#697eb6" /></g>}
    <path d="M10 15L41 0L54 7L23 24Z" fill="#d5c9ad" /><path d="M23 24L54 7V13L23 30Z" fill="#9caa94" />
  </g>
}
export function Robot({ animal = false, module = false }: { animal?: boolean; module?: boolean }) {
  return <svg viewBox="0 0 64 76" aria-hidden="true" focusable="false" className="ot-robot">
    <ellipse cx="32" cy="68" rx="22" ry="7" fill="#163b3633" />
    {animal ? <><path d="M12 39H48V56H12Z" fill="currentColor" /><path d="M42 22L59 31L56 46L42 43Z" fill="currentColor" /><path d="M46 27L44 14L54 23M52 27L59 19L59 32" fill="#bce5d0" /><path d="M16 52V65M40 52V65M24 52V64M46 48V61" stroke="#53726c" strokeWidth="6" /><circle cx="53" cy="33" r="3" fill="#0c282b" /><path d="M13 41L6 26L4 33" stroke="currentColor" strokeWidth="6" fill="none" /></> : <><path d="M23 47V65M41 47V65" stroke="#45645f" strokeWidth="9" /><rect x="15" y="29" width="34" height="26" rx="10" fill="currentColor" /><rect x="13" y="9" width="38" height="28" rx="10" fill="#c7e4dc" /><rect x="17" y="16" width="30" height="12" rx="5" fill="#21414b" /><circle cx="24" cy="22" r="3" fill="#b7fff0" /><circle cx="40" cy="22" r="3" fill="#b7fff0" /><path d="M11 35L7 48M53 35L57 48" stroke="currentColor" strokeWidth="7" /><path d="M32 9V3" stroke="#6f9490" strokeWidth="3" /><circle cx="32" cy="3" r="3" fill="#e4b967" /></>}
    {module && <rect x="27" y="37" width="10" height="10" rx="2" fill="#264a4b" />}
  </svg>
}
export function TownScene({ agents, swarms, pose, selected, onResident, onPlace, onWalk, walkingEnabled, visitorLabel }: { agents: Agent[]; swarms: Swarm[]; pose: LocalPose; selected: string | null; onResident: (id: string) => void; onPlace: (id: PlaceId) => void; onWalk: (p: Point) => void; walkingEnabled: boolean; visitorLabel: string }) {
  const map = useRef<SVGSVGElement>(null)
  const placed = residentPlacements(agents, swarms)
  return <div className="ot-map-wrap" data-kit={pose.kit}>
    <div className="ot-map-scroll"><div className="ot-map" data-town-walk="" tabIndex={0} role="region" aria-label="Walkable town. Arrow keys or WASD move your local character. Every native tool is also in the direct directory.">
      <svg ref={map} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="ot-land" aria-hidden="true" focusable="false" data-art-content="local-world" onPointerDown={(e) => {
        if (e.defaultPrevented || e.button !== 0 || !walkingEnabled) return
        const el = map.current
        if (!el) return
        const box = el.getBoundingClientRect()
        if (!box.width || !box.height) return
        e.currentTarget.parentElement?.focus({ preventScroll: true })
        onWalk({ x: (e.clientX - box.left) / box.width * WIDTH, y: (e.clientY - box.top) / box.height * HEIGHT })
      }}>
        <defs><linearGradient id="ot-terrain" x2="0" y2="1"><stop stopColor="#d5e7ca" /><stop offset="1" stopColor="#a2cba9" /></linearGradient><linearGradient id="ot-river" x2="1" y2="1"><stop stopColor="#86cacc" /><stop offset="1" stopColor="#589dbe" /></linearGradient></defs>
        <path d="M60 110L670 10L1160 210L1172 638L683 771L60 635Z" fill="#678c74" /><path d="M60 94L670 0L1160 193L1172 620L683 750L60 616Z" fill="url(#ot-terrain)" />
        <path d="M66 600Q214 365 117 172L196 132Q306 368 161 647Z" fill="url(#ot-river)" /><path d="M86 595Q246 362 153 159" stroke="#bbe3d6" strokeWidth="5" fill="none" />
        <path d="M243 282L600 418L957 300M600 196V656M222 585L600 418L980 580" stroke="#91a58e" strokeWidth="48" fill="none" strokeLinejoin="round" /><path d="M243 276L600 412L957 294M600 190V650M222 579L600 412L980 574" stroke="#e4d6b5" strokeWidth="36" fill="none" strokeLinejoin="round" /><path d="M600 440V645" stroke="#bdad90" strokeDasharray="8 18" strokeWidth="2" />
        <path d="M83 491L255 428L280 461L106 525Z" fill="#976a46" /><path d="M86 480L258 417L280 447L107 515Z" fill="#d1ac70" /><path d="M106 479L258 423M113 491L266 435" stroke="#8c6b46" strokeWidth="3" />
        {swarms.slice(0, 8).map((s) => { const p = districtPoint(s); return <g key={s.id}><ellipse cx={p.x} cy={p.y} rx="80" ry="31" fill={`hsl(${s.hue} 30% 75% / .4)`} /><path d={`M${p.x-38} ${p.y-6}l39-44 41 44-40 18Z`} fill="#85988a" opacity=".55" /></g> })}
        {[[98,160,1.1],[320,160,.95],[405,270,.8],[830,150,1.2],[1080,420,1.1],[1080,670,.9],[745,656,.85],[342,680,1.15],[65,356,.85],[910,75,1.05]].map(([x,y,size],i) => <Tree key={i} x={x} y={y} size={size} />)}
        {PLACES.map((place) => <Building key={place.id} id={place.id} x={place.point.x} y={place.point.y} kit={pose.kit} />)}
        <g transform="translate(800 440)"><ellipse rx="65" ry="27" fill="#709e76" /><ellipse cy="-7" rx="50" ry="22" fill="#9cbe7c" /><path d="M-30-1L18-22" stroke="#d5bd87" strokeWidth="14" /><path d="M-23 9V-10M17-7V-26" stroke="#5e7755" strokeWidth="4" /></g>
        <g transform="translate(370 371)" aria-hidden="true"><ellipse rx="24" ry="8" fill="#537b6422" /><path d="M-15-9H12V0H-15Z" fill="#e8bb85" /><path d="M12-9L24-15L22-2H10M-10 0V9M7 0V9" stroke="#7c674b" strokeWidth="3" /><path d="M-15-9L-26-19" stroke="#dcb683" strokeWidth="4" /></g>
        <g transform="translate(728 324)"><ellipse cy="8" rx="17" ry="6" fill="#405a6b" /><path d="M-21-8L0-20L26-8L2 7Z" fill="#adc6bd" /><path d="M0-20L0-33L16-26L26-8" fill="#6d9595" /><circle cx="-11" cy="1" r="6" fill="#355d60" /><circle cx="15" cy="6" r="6" fill="#355d60" /></g>
        <g className={`ot-visitor ot-coat-${pose.coat}`} transform={`translate(${pose.x} ${pose.y})`}><ellipse cy="12" rx="18" ry="7" fill="#27453633" /><path d="M-6-9L-8 8M6-9L8 8" stroke="#425d65" strokeWidth="7" /><rect x="-12" y="-35" width="24" height="28" rx="9" fill="currentColor" /><circle cy="-45" r="12" fill="#e8c49e" /><path d="M-13-44Q-15-62 1-60Q16-59 14-45" fill="#415366" /><path d="M-14-30L-21-14M14-30L21-14" stroke="currentColor" strokeWidth="6" /><circle cx="3" cy="-45" r="1.5" fill="#3a464d" /></g>
      </svg>
      {PLACES.map((place) => <button type="button" key={place.id} className="ot-place" data-xc-keep-clear="" data-presence-region={`town-place-${place.id}`} data-presence-ref={presenceRef('room', `town-place-${place.id}`)} style={{ left: `${place.point.x / WIDTH * 100}%`, top: `${(place.point.y+22) / HEIGHT * 100}%` }} onClick={() => onPlace(place.id)} aria-label={`Enter ${place.label}`}><span>{place.label}</span><small>Enter</small></button>)}
      {placed.map(({ agent: a, point: p }) => { return <button type="button" key={a.id} className={`ot-resident${a.id === selected ? ' ot-selected' : ''}`} style={{ left: `${p.x / WIDTH * 100}%`, top: `${p.y / HEIGHT * 100}%`, color: `hsl(${a.hue} 35% 42%)` }} onClick={() => onResident(a.id)} data-native-mind-id={a.id} data-presence-ref={presenceRef('mind', a.id)} aria-label={`${shown(a.name)}, ${a.kind}, ${a.status}. Open resident card.`}><Robot animal={robotAnimal(a)} module={a.kind === 'module'} /><span>{shown(a.name)}</span></button> })}
      <span className="ot-visitor-label" style={{ left: `${pose.x / WIDTH * 100}%`, top: `${(pose.y+18) / HEIGHT * 100}%` }}>{visitorLabel}</span>
    </div></div>
    <p className="ot-art-caption">Scenery, homes, vehicles and visitor movement are local illustration. Resident status comes from your Hive.{agents.length > placed.length ? ` ${plural(placed.length, 'resident')} ${placed.length === 1 ? 'is' : 'are'} drawn; all ${agents.length} are in the directory.` : ''}</p>
  </div>
}
