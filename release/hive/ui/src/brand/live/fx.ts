// @ts-nocheck: the reel renderer (the brand-mark r1 morph), shared as-is so the film and the app run
// the same code. Typed wrappers are in ../LiveOmega.tsx.
// Real 3D for the living mark: leaves and flowers that grow out past its edges, blocks that fly in and lock and later get
// knocked loose, chocolate that hangs off its top edges, sprinkles that land and stick, sparks that fly off molten metal.
// Every piece is born and dies on the same front as the material change, and reports what it does to the sound.
import * as THREE from 'three'

const clamp01 = x => Math.min(1, Math.max(0, x))
const backOut = u => { const c = 1.9; u -= 1; return 1 + (c + 1) * u * u * u + c * u * u }
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler(), _Y = new THREE.Vector3(0, 1, 0), _Z = new THREE.Vector3(0, 0, 1)

function leafTexture() {
  const c = document.createElement('canvas'); c.width = 64; c.height = 128; const g = c.getContext('2d')
  g.fillStyle = '#ffffff'; g.beginPath(); g.moveTo(32, 126); g.bezierCurveTo(-6, 90, 6, 20, 32, 2); g.bezierCurveTo(58, 20, 70, 90, 32, 126); g.fill()
  g.strokeStyle = 'rgba(0,0,0,.25)'; g.lineWidth = 2.5; g.beginPath(); g.moveTo(32, 124); g.lineTo(32, 10); g.stroke()
  g.lineWidth = 1.2; for (let y = 30; y < 115; y += 14) { g.beginPath(); g.moveTo(32, y + 8); g.lineTo(14, y); g.moveTo(32, y + 8); g.lineTo(50, y); g.stroke() }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t
}
function flowerTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d'); g.translate(64, 64)
  for (let i = 0; i < 5; i++) { g.rotate(Math.PI * 2 / 5); g.fillStyle = '#ffffff'; g.beginPath(); g.ellipse(0, -30, 17, 30, 0, 0, Math.PI * 2); g.fill() }
  g.fillStyle = 'rgba(0,0,0,.18)'; g.beginPath(); g.arc(0, 0, 20, 0, Math.PI * 2); g.fill(); g.fillStyle = '#ffd23a'; g.beginPath(); g.arc(0, 0, 14, 0, Math.PI * 2); g.fill()
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t
}

export class MarkFX {
  /** o: { pivot, data, inside(x,y), reveal(x,y,id), STYLE_ID, colorAt(look,x,y), particle(x,y,style,color), sound } */
  constructor(o) {
    Object.assign(this, o); this.zf = 20.3; this.groups = []
    this.makeLeaves(); this.makeFlowers(); this.makeCubes(); this.makeDrips(); this.makeSprinkles(); this.makeSparks()
    this.makeNotes(); this.makeInk(); this.makeBubbles(); this.makeCrystals(); this.makeGraph('hyperon'); this.makeGraph('atomspace'); this.makeAurora(); this.makeWire(); this.makeSlabs(); this.makeBrush(); this.makePlanets()
    if (this.filmPieces !== false) { this.makePuppy(); this.makeBalloon() }   // film-only pieces: never built in the app (each mark is its own instance)
    this.gait = 0; this.wag = 0
  }
  outline(n) { // n evenly spaced outline samples with outward normals (mark space, y down)
    const P = this.data.union; let tot = 0; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; tot += Math.hypot(b[0] - a[0], b[1] - a[1]) }
    const out = [], step = tot / n; let acc = 0, k = 0
    for (let i = 0; i < P.length && out.length < n; i++) {
      const a = P[i], b = P[(i + 1) % P.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-6
      while (acc + l >= k * step && out.length < n) { const u = (k * step - acc) / l, x = a[0] + (b[0] - a[0]) * u, y = a[1] + (b[1] - a[1]) * u
        let nx = (b[1] - a[1]) / l, ny = -(b[0] - a[0]) / l; if (this.inside(x + nx * 2, y + ny * 2)) { nx = -nx; ny = -ny }; out.push([x, y, nx, ny]); k++ }
      acc += l
    }
    return out
  }
  interior(n) { const out = []; let g = 0; while (out.length < n && g++ < 40000) { const x = Math.random() * 280, y = Math.random() * 256; if (this.inside(x, y)) out.push([x, y]) } return out }
  group(look, items, mesh, opts = {}) { mesh.position.set(-140, 128, -8); const G = { look, items, mesh, ...opts }; for (const it of items) { it.tb = Infinity; it.td = Infinity }; this.groups.push(G); this.pivot.add(mesh); return G }

  // ── the pieces ────────────────────────────────────────────────────────────────────────────────────────────────────
  makeLeaves() {
    const geo = new THREE.PlaneGeometry(.55, 1).translate(0, .5, 0), mat = new THREE.MeshStandardMaterial({ map: leafTexture(), alphaTest: .5, side: THREE.DoubleSide, roughness: .75 })
    const items = [], greens = ['#2a5c1c', '#3b7128', '#1f4f17', '#4f8a31', '#335f22']
    for (const [x, y, nx, ny] of this.outline(240)) items.push({ x, y, z: 4 + Math.random() * 14, dir: new THREE.Vector3(nx, -ny, (Math.random() - .3) * .9).normalize(), size: 10 + Math.random() * 9, edge: 1 })
    for (const [x, y] of this.interior(300)) items.push({ x, y, z: this.zf - 1, dir: new THREE.Vector3((Math.random() - .5) * 1.2, (Math.random() - .3) * 1.2, 1).normalize(), size: 8 + Math.random() * 7, edge: 0 })
    const mesh = new THREE.InstancedMesh(geo, mat, items.length); mesh.frustumCulled = false
    items.forEach((it, i) => { it.roll = Math.random() * 6.28; it.ph = Math.random() * 6.28; mesh.setColorAt(i, new THREE.Color(greens[i % greens.length])); it.col = new THREE.Color(greens[i % greens.length]) })
    this.leaves = this.group('bush', items, mesh, { lead: 0, onBirth: (it, s) => this.sound.at(s.t, 'pop', {}, .035), onDeath: (it) => this.particle(it.x, it.y, 'leaf', it.col) })
  }
  makeFlowers() {
    const geo = new THREE.PlaneGeometry(1, 1), mat = new THREE.MeshStandardMaterial({ map: flowerTexture(), alphaTest: .5, side: THREE.DoubleSide, roughness: .5 })
    const cols = ['#ffd0ec', '#ffffff', '#e6c8ff', '#ffb0d8', '#fff2b0'], items = []
    for (const [x, y, nx, ny] of this.outline(46)) items.push({ x, y, z: 8 + Math.random() * 10, dir: new THREE.Vector3(nx * .6, -ny * .6, .8).normalize(), size: 7 + Math.random() * 5 })
    for (const [x, y] of this.interior(60)) items.push({ x, y, z: this.zf + 2, dir: new THREE.Vector3((Math.random() - .5) * .6, (Math.random() - .5) * .6, 1).normalize(), size: 6 + Math.random() * 5 })
    const mesh = new THREE.InstancedMesh(geo, mat, items.length); mesh.frustumCulled = false
    items.forEach((it, i) => { it.roll = Math.random() * 6.28; it.ph = Math.random() * 6.28; it.col = new THREE.Color(cols[i % cols.length]); mesh.setColorAt(i, it.col) })
    this.flowers = this.group('bush', items, mesh, { delay: () => .25 + Math.random() * .3, onBirth: (it, s) => this.sound.at(s.t + .3, 'bell', {}, .12), onDeath: (it) => this.particle(it.x, it.y, 'leaf', it.col) })
  }
  makeCubes() {
    const items = []
    for (let y = 5.5; y < 256; y += 11) for (let x = 5.5; x < 280; x += 11) if (this.inside(x, y) && this.inside(x - 4, y - 4) && this.inside(x + 4, y + 4) && Math.random() < .5) items.push({ x, y, h: 2 + Math.random() * 7 })
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(10.4, 10.4, 10.4), new THREE.MeshStandardMaterial({ roughness: .85, metalness: 0 }), items.length); mesh.frustumCulled = false
    items.forEach(it => { it.ax = new THREE.Vector3(Math.random() - .5, Math.random() - .5, Math.random() - .5).normalize(); it.v = new THREE.Vector3((Math.random() - .5) * 120, 90 + Math.random() * 90, 60 + Math.random() * 90); it.dx = (Math.random() - .5) * 60 })
    this.cubes = this.group('voxel', items, mesh, { lead: .12, onDeath: (it, s) => this.sound.at(s.t, 'tumble', {}, .05) })
    this.cubesColoured = false
  }
  makeDrips() {
    const items = []
    for (const [x, y, nx, ny] of this.outline(130)) if (ny < -.35 && Math.random() < .55) items.push({ x, y, r: 3.6 + Math.random() * 2.8, len: 8 + Math.random() * 20 })
    const mesh = new THREE.InstancedMesh(new THREE.CapsuleGeometry(1, 1, 6, 14), new THREE.MeshPhysicalMaterial({ roughness: .2, clearcoat: 1, clearcoatRoughness: .08 }), items.length); mesh.frustumCulled = false
    items.forEach((it, i) => { it.col = new THREE.Color(Math.random() < .5 ? '#3a1c0c' : '#4a2410'); mesh.setColorAt(i, it.col); it.ph = Math.random() * 6.28 })
    this.drips = this.group('cake', items, mesh, { onBirth: (it, s) => this.sound.at(s.t, 'plop', {}, .08) })
  }
  makeSprinkles() {
    const cols = ['#ff4f8a', '#ffd23a', '#4fc8ff', '#ffffff', '#7aff6a', '#ff8a2a'], items = this.interior(190).map(([x, y]) => ({ x, y }))
    const mesh = new THREE.InstancedMesh(new THREE.CapsuleGeometry(.8, 2.6, 3, 8), new THREE.MeshStandardMaterial({ roughness: .35 }), items.length); mesh.frustumCulled = false
    items.forEach((it, i) => { it.rot = Math.random() * 6.28; it.col = new THREE.Color(cols[i % cols.length]); mesh.setColorAt(i, it.col); it.v = new THREE.Vector3((Math.random() - .5) * 80, 60 + Math.random() * 60, 40 + Math.random() * 60) })
    this.sprinkles = this.group('cake', items, mesh, { lead: .06, delay: () => .05 + Math.random() * .2 })
  }
  makeSparks() {
    const N = 320, mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }), N); mesh.frustumCulled = false
    this.sparks = { mesh, N, next: 0, pos: new Float32Array(N * 3), vel: new Float32Array(N * 3), life: new Float32Array(N), max: new Float32Array(N).fill(1) }
    for (let i = 0; i < N; i++) mesh.setColorAt(i, new THREE.Color('#ffb040'))
    mesh.position.set(-140, 128, -8); this.pivot.add(mesh); this.sparkPts = this.interior(1400)
  }

  // ── lifecycle: births and deaths ride the change front ──────────────────────────────────────────────────────────
  lifecycle(G, s) {
    if (s.target === G.look) {                                                    // arriving
      if (G.revStyle !== s.style) { G.revStyle = s.style; for (const it of G.items) it.ra = it.r0 ?? this.reveal(it.x, it.y, this.STYLE_ID[s.style]) }
      for (const it of G.items) {
        if ((it.tb === Infinity || (it.td < Infinity && s.t - it.td > .35)) && it.ra - (G.lead || 0) < s.front) { it.tb = s.t + (G.delay ? G.delay(it) : 0); it.td = Infinity; it.landed = false; G.onBirth?.(it, s) }
        else if (it.tb < Infinity && it.td === Infinity && s.t >= it.tb && it.ra - (G.lead || 0) > s.front + .04) it.td = s.t      // the change ran back past it
      }
    } else if (s.look === G.look && s.target) {                                   // being taken over
      if (G.depStyle !== s.style) { G.depStyle = s.style; for (const it of G.items) it.rd = this.reveal(it.x, it.y, this.STYLE_ID[s.style]) }
      for (const it of G.items) {
        if (it.td === Infinity && it.tb < Infinity && it.rd < s.front + .03) { it.td = s.t; G.onDeath?.(it, s) }
        else if (it.td < Infinity && s.t - it.td > .35 && it.rd > s.front + .06) { it.tb = s.t; it.td = Infinity }                  // the change ran back: it grows again
      }
    } else if (s.look === G.look) { G.revStyle = null; for (const it of G.items) if (it.tb === Infinity || it.td < Infinity) { it.tb = s.t - 10; it.td = Infinity } }   // holding: all present
    else { G.depStyle = null; for (const it of G.items) { if (it.tb < Infinity && it.td === Infinity) it.td = s.t; if (s.t - it.td > 2.5) { it.tb = Infinity; it.td = Infinity } } }
  }
  /** The change never happened: every piece back to before it (unborn, or whole). */
  reset() { for (const G of this.groups) { G.revStyle = null; G.depStyle = null; for (const it of G.items) { it.tb = G.look === this.lastLook ? it.tb : Infinity; it.td = Infinity; it.landed = false } } }
  /** A behaviour's piece event (omega-mark.metta): bloom, sprout, wilt, nova, bubbles, flower-talk. */
  event(name, t) {
    const R = Math.random
    if (name === 'bloom') { for (const it of this.flowers.items) { it.tb = t + R() * .4; it.td = Infinity } for (const [x, y] of this.interior(50)) this.particle(x, y, 'leaf', new THREE.Color(R() < .6 ? '#ffb0d8' : '#ffffff')) }
    if (name === 'sprout') for (const it of this.leaves.items) if (R() < .35) { it.tb = t + R() * .6; it.td = Infinity }
    if (name === 'wilt') this.wiltT = t
    if (name === 'nova') for (const [x, y] of this.interior(70)) this.particle(x, y, 'stars', null)
    if (name === 'bubbles') this.bubbleUntil = t + 1.6
    if (name === 'flower-talk') this.talking = true
  }
  presenceOf(look, s) { return s.target === look ? clamp01(s.front * 1.2) : s.look === look ? (s.target ? 1 - clamp01(s.front * 1.3) : 1) : 0 }
  life(it, t, grow = .5, die = .4) { if (it.tb === Infinity || t < it.tb) return 0; return backOut(clamp01((t - it.tb) / grow)) * (it.td === Infinity ? 1 : 1 - clamp01((t - it.td) / die)) }

  tick(s) {
    const t = s.t; if (!s.target) this.lastLook = s.look; else if (this.lastLook == null) this.lastLook = s.look
    if (!this.cubesColoured && this.colorAt('voxel', 1, 1)) { this.cubes.items.forEach((it, i) => this.cubes.mesh.setColorAt(i, this.colorAt('voxel', it.x, it.y))); this.cubes.mesh.instanceColor.needsUpdate = true; this.cubesColoured = true }
    if (s.dt > 0) for (const G of this.groups) this.lifecycle(G, s)   // births and deaths happen only as time runs forward; a rewind replays them backwards
    this.tickMore(s)
    // leaves and flowers: grow out with a spring, sway in the wind, droop and drop when buried
    for (const G of [this.leaves, this.flowers]) {
      G.items.forEach((it, i) => {
        const k = this.life(it, t, G === this.leaves ? .5 : .4, .35)
        _q.setFromUnitVectors(_Y, it.dir); _q2.setFromAxisAngle(it.dir, it.roll); _q.premultiply(_q2)
        const wl = this.wiltT !== undefined && t - this.wiltT < 2.2 ? Math.sin(Math.PI * (t - this.wiltT) / 2.2) : 0   // a wilt, then recovery
        const droop = (it.td < Infinity ? clamp01((t - it.td) / .35) : 0) + wl * .9
        _e.set(Math.sin(t * 1.7 + it.ph) * (it.edge ? .22 : .12) + droop * .9, 0, Math.sin(t * 1.3 + it.ph * 2) * .1); _q2.setFromEuler(_e); _q.multiply(_q2)
        const talk = G === this.flowers ? 1 + .35 * (this.voice || 0) * (.6 + .4 * Math.sin(t * 9 + i)) : 1   // flowers open and close with the words
        _p.set(it.x, -it.y, it.z); _s.setScalar(it.size * Math.max(0, k) * (1 - wl * .22) * talk); _m.compose(_p, _q, _s); G.mesh.setMatrixAt(i, _m)
      })
      G.mesh.instanceMatrix.needsUpdate = true
    }
    // blocks: fly in on an arc, land with a squash; knocked loose, they tumble away under gravity
    this.cubes.items.forEach((it, i) => {
      let S = 0; _q.identity(); _s.set(1, 1, 1); const rest = this.zf + it.h - 5.2
      if (it.tb < Infinity && t >= it.tb) {
        const u = clamp01((t - it.tb) / .34)
        if (u < 1) { const f = u * u; _p.set(it.x + it.dx * (1 - u), -it.y + 150 * (1 - f), rest + 110 * (1 - f)); _q.setFromAxisAngle(it.ax, (1 - u) * 4); S = 1 }
        else { if (!it.landed) { it.landed = true; this.sound.at(it.tb + .34, 'clack', {}, .03) } const w = clamp01((t - it.tb - .34) / .16); _p.set(it.x, -it.y, rest); _s.set(1 + .14 * (1 - w), 1 + .14 * (1 - w), 1 - .3 * (1 - w)); S = 1 }
        if (it.td < Infinity) { const d = t - it.td; _p.set(it.x + it.v.x * d, -it.y + it.v.y * d - 210 * d * d, rest + it.v.z * d); _q.setFromAxisAngle(it.ax, d * 7); S = 1 - clamp01((d - 1.1) / .5); _s.set(1, 1, 1) }
      } else it.landed = false
      _s.multiplyScalar(S); _m.compose(_p, _q, _s); this.cubes.mesh.setMatrixAt(i, _m)
    })
    this.cubes.mesh.instanceMatrix.needsUpdate = true
    // chocolate drips: grow down over the front from the top edges, a slow creep while it holds
    this.drips.items.forEach((it, i) => {
      const g = it.tb === Infinity || t < it.tb ? 0 : 1 - Math.pow(1 - clamp01((t - it.tb) / 1.4), 3), dieK = it.td === Infinity ? 1 : 1 - clamp01((t - it.td) / .25)
      const L = it.len * g * dieK * (1 + .08 * clamp01((t - it.tb - 1.4) / 6)), R = it.r * Math.min(1, g * 3) * dieK
      _q.identity(); _p.set(it.x, -(it.y + L / 2 - 1), this.zf + R * .45); _s.set(R, Math.max(.001, L / 2 + .001), R * .5); _m.compose(_p, _q, _s); this.drips.mesh.setMatrixAt(i, _m)
    })
    this.drips.mesh.instanceMatrix.needsUpdate = true
    // sprinkles: rain down and stick; knocked off when the cake goes
    this.sprinkles.items.forEach((it, i) => {
      let S = 0
      if (it.tb < Infinity && t >= it.tb) {
        const u = clamp01((t - it.tb) / .35); _p.set(it.x, -it.y + 40 * (1 - u), this.zf + .9 + 70 * (1 - u) * (1 - u)); S = 1
        if (u >= 1 && !it.landed) { it.landed = true; this.sound.at(it.tb + .35, 'tick', {}, .025) }
        if (it.td < Infinity) { const d = t - it.td; _p.set(it.x + it.v.x * d, -it.y + it.v.y * d - 240 * d * d, this.zf + it.v.z * d); S = 1 - clamp01((d - .9) / .4) }
      } else it.landed = false
      _q.setFromAxisAngle(_Z, it.rot); _q2.setFromAxisAngle(_Y, 0); _s.setScalar(S); _m.compose(_p, _q, _s); this.sprinkles.mesh.setMatrixAt(i, _m)
    })
    this.sprinkles.mesh.instanceMatrix.needsUpdate = true
    // sparks fly off the molten front
    const P = this.sparks
    if (s.target && s.style === 'forge' && s.dt > 0) {   // no new sparks while time runs backwards
      if (!P.revs) P.revs = this.sparkPts.map(([x, y]) => this.reveal(x, y, this.STYLE_ID.forge))
      let n = 260 * s.dt
      while (n > 0) { if (Math.random() < n) { for (let tries = 0; tries < 12; tries++) { const j = (Math.random() * this.sparkPts.length) | 0; if (Math.abs(P.revs[j] - s.front) < .035) { this.spark(this.sparkPts[j], t); break } } } n -= 1 }
    }
    for (let i = 0; i < P.N; i++) {
      if (P.life[i] <= 0 && s.dt >= 0) { _m.makeScale(0, 0, 0); P.mesh.setMatrixAt(i, _m); continue }
      P.life[i] -= s.dt; if (P.life[i] <= 0 || P.life[i] > P.max[i]) { _m.makeScale(0, 0, 0); P.mesh.setMatrixAt(i, _m); continue }   // rewinding: back before its birth, gone
      P.vel[i * 3 + 1] -= 380 * s.dt
      for (let a = 0; a < 3; a++) P.pos[i * 3 + a] += P.vel[i * 3 + a] * s.dt
      _p.set(P.vel[i * 3], P.vel[i * 3 + 1], P.vel[i * 3 + 2]); const sp = _p.length(); _q.setFromUnitVectors(_Y, _p.normalize())
      const k = P.life[i] / P.max[i]; _s.set(.7 * k + .2, Math.max(2, sp * .045), .7 * k + .2); _p.set(P.pos[i * 3], P.pos[i * 3 + 1], P.pos[i * 3 + 2]); _m.compose(_p, _q, _s); P.mesh.setMatrixAt(i, _m)
      P.mesh.setColorAt(i, _c.setRGB(1, .45 + .5 * k, .12 + .6 * k * k))
    }
    P.mesh.instanceMatrix.needsUpdate = true; P.mesh.instanceColor.needsUpdate = true
  }
  // ── the twelve more ───────────────────────────────────────────────────────────────────────────────────────────────
  makeNotes() { // real sticky notes, exactly where the material's notes land: they fly in, slap on with a curled corner, later peel away
    const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 128, 128)
    gr.addColorStop(0, '#ffe066'); gr.addColorStop(1, '#f5c430'); g.fillStyle = gr; g.fillRect(0, 0, 128, 128); g.fillStyle = 'rgba(0,0,0,.08)'; g.fillRect(0, 0, 128, 14)
    g.strokeStyle = 'rgba(43,72,224,.55)'; g.lineWidth = 3; for (const y of [48, 70, 92]) { g.beginPath(); g.moveTo(20, y); g.lineTo(40 + Math.random() * 60, y); g.stroke() }
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace
    const items = []
    for (let gy = -1; gy < 8; gy++) for (let gx = -1; gx < 9; gx++) { const h = this.h21(gx + 9, gy + 9), x = (gx + .5) * 38 + (this.h21(gx + 2, gy + 2) - .5) * 8, y = (gy + .5) * 38 + (this.h21(gx + 5, gy + 5) - .5) * 8
      if ([[0, 0], [-18, -18], [18, -18], [-18, 18], [18, 18]].some(([ox, oy]) => this.inside(x + ox, y + oy))) items.push({ x, y, a: (h - .5) * .4, r0: .06 + h * .82 - .08, v: new THREE.Vector3((Math.random() - .5) * 120, 60 + Math.random() * 80, 120 + Math.random() * 80), sp: (Math.random() - .5) * 6 }) }
    const geo = new THREE.PlaneGeometry(40, 40, 6, 6), landed = new THREE.InstancedBufferAttribute(new Float32Array(items.length), 1); geo.setAttribute('landed', landed)
    const mat = new THREE.ShaderMaterial({ uniforms: { map: { value: tex }, mask: { value: this.mask } }, side: THREE.DoubleSide,
      vertexShader: 'attribute float landed; varying vec2 vUv, vMk; varying float vL, vSh; void main(){ vUv = uv; vec3 p = position; float c = uv.x * (1. - uv.y); c *= c; p.z += c * 8.; vec4 mp = instanceMatrix * vec4(p, 1.); vMk = vec2(mp.x, -mp.y); vL = landed; vSh = .8 + .2 * (1. - c) + .1 * uv.y; gl_Position = projectionMatrix * modelViewMatrix * mp; }',
      fragmentShader: 'uniform sampler2D map, mask; varying vec2 vUv, vMk; varying float vL, vSh; void main(){ vec2 mu = vec2(vMk.x / 280., 1. - vMk.y / 256.); if (vL > .5 && (any(lessThan(mu, vec2(0.))) || any(greaterThan(mu, vec2(1.))) || texture2D(mask, mu).r < .5)) discard; gl_FragColor = vec4(texture2D(map, vUv).rgb * vSh, 1.); }' })
    const mesh = new THREE.InstancedMesh(geo, mat, items.length); mesh.frustumCulled = false; this.notesLanded = landed
    this.notes = this.group('canvas', items, mesh)
  }
  makeInk() { // ink drops fall onto the seeds the ink bleeds from, and splash in crowns
    const items = []
    for (let gy = -1; gy < 7; gy++) for (let gx = -1; gx < 8; gx++) { const x = (gx + this.h21(gx, gy)) * 45, y = (gy + this.h21(gx + 17.3, gy + 17.3)) * 45; if (this.inside(x, y)) items.push({ x, y }) }
    const mat = new THREE.MeshPhysicalMaterial({ color: '#060504', roughness: .08, clearcoat: 1, clearcoatRoughness: .05 })
    const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 16, 12), mat, items.length); mesh.frustumCulled = false
    this.ink = this.group('still', items, mesh, { lead: .1 })
    const N = 400; this.splash = { mesh: new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 6), mat, N), N, next: 0, pos: new Float32Array(N * 3), vel: new Float32Array(N * 3), life: new Float32Array(N), max: new Float32Array(N).fill(1), size: new Float32Array(N) }
    this.splash.mesh.frustumCulled = false; this.splash.mesh.position.set(-140, 128, -8); this.pivot.add(this.splash.mesh)
  }
  makeBubbles() { // bubbles rise through the flood and pop at its surface
    const N = 160; this.bub = { mesh: new THREE.InstancedMesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshStandardMaterial({ color: '#ffe4f6', roughness: 0, metalness: .1, transparent: true, opacity: .42, envMapIntensity: 2.2 }), N), N, next: 0,
      x: new Float32Array(N), y: new Float32Array(N), z: new Float32Array(N), vy: new Float32Array(N), r: new Float32Array(N), life: new Float32Array(N) }
    this.bub.mesh.frustumCulled = false; this.bub.mesh.position.set(-140, 128, -8); this.pivot.add(this.bub.mesh); this.bubPts = this.interior(900)
  }
  makeCrystals() { // glass crystals grow out of the surface from the frost seeds, and shatter when the glass goes
    const items = [], mat = new THREE.MeshPhysicalMaterial({ color: '#a8f4e6', roughness: .04, metalness: 0, transmission: .82, thickness: 6, ior: 1.5, envMapIntensity: 1.6 })
    for (let gy = -1; gy < 6; gy++) for (let gx = -1; gx < 7; gx++) { const x = (gx + this.h21(gx, gy)) * 55, y = (gy + this.h21(gx + 17.3, gy + 17.3)) * 55; if (!this.inside(x, y)) continue
      for (let k = 0; k < 3; k++) items.push({ x: x + (Math.random() - .5) * 10, y: y + (Math.random() - .5) * 10, z: this.zf - 2, dir: new THREE.Vector3((Math.random() - .5) * 1.4, (Math.random() - .5) * 1.4, 1).normalize(), len: 10 + Math.random() * 14, w: 2.5 + Math.random() * 2 }) }
    for (const [x, y, nx, ny] of this.outline(40)) items.push({ x, y, z: 4 + Math.random() * 12, dir: new THREE.Vector3(nx, -ny, (Math.random() - .3) * .6).normalize(), len: 9 + Math.random() * 12, w: 2.2 + Math.random() * 1.6 })
    const mesh = new THREE.InstancedMesh(new THREE.OctahedronGeometry(1, 0), mat, items.length); mesh.frustumCulled = false
    items.forEach(it => { it.roll = Math.random() * 6.28; it.v = new THREE.Vector3((Math.random() - .5) * 160, 40 + Math.random() * 140, 60 + Math.random() * 120); it.ax = new THREE.Vector3(Math.random(), Math.random(), Math.random()).normalize() })
    this.crystals = this.group('brand', items, mesh, { onBirth: () => {} })
  }
  makeGraph(look) { // a real graph: nodes swarm in on spirals and settle, links grow between them; later it swirls back out
    const nodes = []
    for (let gy = -1; gy < 10; gy++) for (let gx = -1; gx < 11; gx++) { const x = (gx + this.h21(gx, gy)) * 30, y = (gy + this.h21(gx + 17.3, gy + 17.3)) * 30; if (this.inside(x, y)) nodes.push({ x, y, a0: Math.random() * 6.28, R0: 260 + Math.random() * 160 }) }
    const links = []; nodes.forEach((n, i) => { nodes.map((m, j) => [j, Math.hypot(m.x - n.x, m.y - n.y)]).filter(([j]) => j !== i).sort((a, b) => a[1] - b[1]).slice(0, 2).forEach(([j, d]) => { if (d < 48 && !links.some(l => (l.a === j && l.b === i))) links.push({ a: i, b: j }) }) })
    const hy = look === 'hyperon', col = n => new THREE.Color(hy ? (n.x < 140 ? '#ffc861' : '#5ff0e0') : '#cdbdff')
    const nm = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 14, 10), new THREE.MeshBasicMaterial({ toneMapped: false }), nodes.length); nm.frustumCulled = false; nodes.forEach((n, i) => nm.setColorAt(i, col(n).multiplyScalar(1.6)))
    const lm = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 6).translate(0, .5, 0), new THREE.MeshBasicMaterial({ toneMapped: false }), links.length); lm.frustumCulled = false
    links.forEach((l, i) => lm.setColorAt(i, col(nodes[l.a]).multiplyScalar(.9)))
    const G = this.group(look, nodes, nm, { lead: .05 }); G.links = links; G.lm = lm; lm.position.set(-140, 128, -8); this.pivot.add(lm); (this.graphs = this.graphs || []).push(G)
  }
  makeAurora() { // ribbons of aurora wrap around the mark as Classic arrives, and drift around it while it holds
    this.aur = []; for (let k = 0; k < 3; k++) {
      const mat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, uniforms: { t: { value: 0 }, pres: { value: 0 }, sweep: { value: 0 }, ph: { value: k * 2.1 } },
        vertexShader: `uniform float t, ph; varying vec2 vU; void main(){ vU = uv; float th = ph + uv.x * 5.6; float R = 165. + 22. * sin(uv.x * 9. + t * .6 + ph);
          vec3 p = vec3(140. + R * cos(th), -128. + 55. * sin(th * 1.3 + t * .4 + ph) + (uv.y - .5) * 46., 10. + R * .55 * sin(th)); gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.); }`,
        fragmentShader: `uniform float pres, sweep; varying vec2 vU; void main(){ if (vU.x > sweep) discard; float a = pow(vU.y, 1.4) * (1. - vU.y) * 3.2 * pres * smoothstep(sweep, sweep - .08, vU.x) * smoothstep(0., .08, vU.x);
          gl_FragColor = vec4(mix(vec3(.55, .45, 1.), vec3(.35, .95, 1.), vU.y) * a, a); }` })
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 160, 1), mat); m.frustumCulled = false; m.position.set(-140, 128, -8); this.pivot.add(m); this.aur.push(m) }
  }
  makeWire() { // a glowing wireframe of the mark itself and a laser plane that scans it
    const mat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { scanY: { value: -1 }, pres: { value: 0 } },
      vertexShader: 'varying float vY; void main(){ vY = -position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
      fragmentShader: 'uniform float scanY, pres; varying float vY; float sqr(float x){ return x * x; } void main(){ float a = pres * (step(vY, scanY) * .55 + exp(-sqr((vY - scanY) / 5.)) * 1.5); gl_FragColor = vec4(vec3(.3, 1., .5) * a, a); }' })
    this.wire = new THREE.LineSegments(new THREE.EdgesGeometry(this.geo, 18), mat); this.wire.position.set(-140, 128, -8); this.wire.frustumCulled = false; this.pivot.add(this.wire)
    this.laser = new THREE.Mesh(new THREE.PlaneGeometry(340, 40), new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, uniforms: { pres: { value: 0 } },
      vertexShader: 'varying vec2 vU; void main(){ vU = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
      fragmentShader: 'uniform float pres; varying vec2 vU; float sqr(float x){ return x * x; } void main(){ float a = pres * exp(-sqr((vU.y - .5) * 9.)) * smoothstep(0., .15, vU.x) * smoothstep(1., .85, vU.x); gl_FragColor = vec4(vec3(.35, 1., .55) * a, a); }' }))
    this.laser.rotation.x = -Math.PI / 2; this.laser.frustumCulled = false; this.pivot.add(this.laser)
  }
  makeSlabs() { const N = 60; this.slab = { mesh: new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ toneMapped: false }), N), N, next: 0, x: new Float32Array(N), y: new Float32Array(N), z: new Float32Array(N), w: new Float32Array(N), life: new Float32Array(N) }
    this.slab.mesh.frustumCulled = false; this.slab.mesh.position.set(-140, 128, -8); this.pivot.add(this.slab.mesh); this.slabPts = this.interior(600) }
  makeBrush() { // a real paintbrush that paints the enamel on, stroke by stroke
    const b = new THREE.Group(), wood = new THREE.MeshStandardMaterial({ color: '#8a5a32', roughness: .6 }), metal = new THREE.MeshStandardMaterial({ color: '#c8ccd4', metalness: .9, roughness: .25 }), hair = new THREE.MeshStandardMaterial({ color: '#1f8f80', roughness: .7 })
    const h = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 3, 60, 16), wood); h.position.y = 52; const f = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 3.4, 12, 16), metal); f.position.y = 18
    const br = new THREE.Mesh(new THREE.CylinderGeometry(4.4, 1.4, 16, 16), hair); br.position.y = 6; b.add(h, f, br); b.scale.setScalar(0); this.brush = b; this.pivot.add(b)
  }
  makePlanets() { // small worlds orbit inside the glass while Cosmos lives
    this.planets = [['#ffb070', 5.5, 26, .5], ['#8ac8ff', 3.6, 36, -.34], ['#e8c8ff', 2.6, 18, .8]].map(([c, r, R, w]) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 18), new THREE.MeshStandardMaterial({ color: c, roughness: .5, emissive: c, emissiveIntensity: .35 })); m.userData = { R, w }; this.pivot.add(m); return m })
  }
  makePuppy() { // the Omega as a puppy: its body is the mark (puppy fur); a head on the left crescent's tip, ears, a tail, four legs
    const fur = new THREE.MeshStandardMaterial({ color: '#dba567', roughness: .92 }), furDark = new THREE.MeshStandardMaterial({ color: '#b97a3e', roughness: .95 })
    const shiny = new THREE.MeshPhysicalMaterial({ color: '#0d0907', roughness: .12, clearcoat: 1, clearcoatRoughness: .05 }), white = new THREE.MeshBasicMaterial({ color: '#ffffff' })
    const pink = new THREE.MeshStandardMaterial({ color: '#ef8a9a', roughness: .45 }), S = new THREE.SphereGeometry(1, 28, 20), C = new THREE.CapsuleGeometry(1, 1, 6, 12)
    const g = new THREE.Group(); g.position.set(-140, 128, -8); this.pivot.add(g); this.pup = g
    const add = (geo, mat, [x, y, z], [sx, sy, sz], rot = [0, 0, 0], parent = g) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, -y, z); m.scale.set(sx, sy, sz); m.rotation.set(...rot); parent.add(m); return m }
    const head = new THREE.Group(); head.position.set(176, -4, 22); g.add(head); this.pupHead = head                 // on the tip, looking a little right
    add(S, fur, [0, 0, 0], [30, 27, 26], [0, 0, 0], head)                                                           // head
    add(S, fur, [20, 8, 14], [17, 12, 15], [0, 0, 0], head)                                                          // snout
    add(S, shiny, [33, 4, 22], [6, 4.6, 4.6], [0, 0, 0], head)                                                       // nose
    add(S, pink, [24, 20, 20], [6, 7, 2.5], [0, 0, -.2], head)                                                       // tongue
    for (const [ex, ey] of [[-8, -6], [10, -10]]) { add(S, shiny, [ex, ey, 22], [6.5, 7.5, 4], [0, 0, 0], head); add(S, white, [ex + 2.2, ey - 2.6, 26], [1.9, 1.9, 1], [0, 0, 0], head) }   // big eyes, catchlights
    this.pupEars = [[-26, -10, -1], [14, -24, 1]].map(([ex, ey, side]) => { const e = new THREE.Group(); e.position.set(ex, -ey, 6); head.add(e); add(S, furDark, [side * 6, 16, 0], [9, 19, 5], [0, 0, side * .35], e); return e })   // floppy ears
    const tail = new THREE.Group(); tail.position.set(274, -214, 10); g.add(tail); this.pupTail = tail; add(C, fur, [6, -14, 0], [6, 12, 6], [0, 0, -.5], tail); add(S, fur, [12, -28, 0], [8, 8, 8], [0, 0, 0], tail)
    this.pupLegs = [[46, 1], [98, -1], [188, 1], [238, -1]].map(([lx, ph]) => { const l = new THREE.Group(); l.position.set(lx, -246, 8); g.add(l); add(C, fur, [0, 14, 0], [7, 9, 7], [0, 0, 0], l); add(S, furDark, [3, 26, 2], [9, 6, 9], [0, 0, 0], l); l.userData.ph = ph; return l })   // legs and paws
    g.scale.setScalar(0)
  }
  makeBalloon() { // a comedy balloon: the knot under the base and a curly string
    const g = new THREE.Group(); g.position.set(-140, 128, -8); this.pivot.add(g); this.bal = g
    const knot = new THREE.Mesh(new THREE.ConeGeometry(7, 12, 16), new THREE.MeshPhysicalMaterial({ color: '#6a4ae0', roughness: .2, clearcoat: 1, metalness: .3 })); knot.position.set(140, -262, 6); knot.rotation.z = Math.PI; g.add(knot)
    const pts = []; for (let i = 0; i <= 60; i++) { const u = i / 60; pts.push(new THREE.Vector3(140 + Math.sin(u * 14) * 7 * (1 - u * .4), -268 - u * 190, 6 + Math.cos(u * 14) * 5)) }   // curly ribbon
    this.balString = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 120, 1.1, 6), new THREE.MeshStandardMaterial({ color: '#f4efe6', roughness: .6 })); g.add(this.balString)
    g.scale.setScalar(0)
  }
  tickMore(s) {
    const t = s.t
    if (this.pup) { const pp = this.presenceOf('puppy', s), k = Math.min(1, pp * 1.4)                                                     // the puppy's parts: present while it is a puppy
      this.pup.scale.setScalar(k); this.pup.visible = k > .001
      if (k > 0) { const run = this.gait, f = t * (run > .1 ? 13 : 3)
        this.pupLegs.forEach(l => { l.rotation.z = Math.sin(f + l.userData.ph * 1.6) * .6 * run })
        this.pupTail.rotation.z = Math.sin(t * (this.wag > .5 ? 22 : 6)) * (.25 + .5 * this.wag)
        this.pupEars.forEach((e, i) => { e.rotation.z = Math.sin(f * .5 + i) * (.12 + .25 * run) })
        this.pupHead.rotation.set(Math.sin(t * 2.2) * .05, .25 + Math.sin(t * 1.4) * .06, Math.sin(f) * .05 * run) } }
    if (this.bal) { const pb = this.presenceOf('balloon', s); this.bal.scale.setScalar(Math.min(1, pb * 1.2)); this.bal.visible = pb > .001; this.balString.rotation.z = Math.sin(t * 1.8) * .05 }
    // notes
    this.notes.items.forEach((it, i) => {
      let S = 0, L = 0; _q.identity()
      if (it.tb < Infinity && t >= it.tb) { const u = clamp01((t - it.tb) / .28), bounce = u >= 1 ? Math.exp(-(t - it.tb - .28) * 14) * Math.sin((t - it.tb - .28) * 40) * 2 : 0
        _p.set(it.x, -it.y + 30 * (1 - u), this.zf + .5 + 60 * (1 - u) * (1 - u) + bounce); _e.set((1 - u) * .9, 0, -it.a); _q.setFromEuler(_e); S = 1 + .12 * (1 - u); L = u >= 1 ? 1 : 0
        if (it.td < Infinity) { const d = t - it.td; _p.set(it.x + it.v.x * d, -it.y + it.v.y * d - 120 * d * d, this.zf + .5 + it.v.z * d); _e.set(d * 2.2, d * it.sp, -it.a + d * it.sp * .5); _q.setFromEuler(_e); S = 1 - clamp01((d - .8) / .5); L = 0 } }
      _s.setScalar(S); _m.compose(_p, _q, _s); this.notes.mesh.setMatrixAt(i, _m); this.notesLanded.array[i] = L
    })
    this.notes.mesh.instanceMatrix.needsUpdate = true; this.notesLanded.needsUpdate = true
    // ink drops and their splashes
    this.ink.items.forEach((it, i) => {
      let S = 0
      if (it.tb < Infinity && t >= it.tb) { const u = clamp01((t - it.tb) / .3); if (u < 1) { _p.set(it.x, -it.y, this.zf + 230 * (1 - u * u)); _s.set(4, 4, 7); S = 1 }
        else if (!it.splashed) { it.splashed = true; for (let k = 0; k < 14; k++) this.splashOne(it.x, it.y, k / 14) } }
      else it.splashed = false
      _q.identity(); if (!S) _s.set(0, 0, 0); _m.compose(_p, _q, _s); this.ink.mesh.setMatrixAt(i, _m)
    })
    this.ink.mesh.instanceMatrix.needsUpdate = true
    const SP = this.splash
    for (let i = 0; i < SP.N; i++) { if (SP.life[i] <= 0) { _m.makeScale(0, 0, 0); SP.mesh.setMatrixAt(i, _m); continue }
      SP.life[i] -= s.dt; SP.vel[i * 3 + 2] -= 520 * s.dt; for (let a = 0; a < 3; a++) SP.pos[i * 3 + a] += SP.vel[i * 3 + a] * s.dt; if (SP.pos[i * 3 + 2] < this.zf) { SP.pos[i * 3 + 2] = this.zf; SP.vel.fill(0, i * 3, i * 3 + 3) }
      _p.set(SP.pos[i * 3], SP.pos[i * 3 + 1], SP.pos[i * 3 + 2]); _s.setScalar(SP.size[i] * clamp01(SP.life[i] / .3)); _m.compose(_p, _q.identity(), _s); SP.mesh.setMatrixAt(i, _m) }
    SP.mesh.instanceMatrix.needsUpdate = true
    // bubbles
    const B = this.bub, flooding = s.target === 'flux' && s.style === 'flood', holdF = (s.look === 'flux' && !s.target) || t < (this.bubbleUntil ?? -1)
    if (flooding || holdF) { if (!B.revs) B.revs = this.bubPts.map(([x, y]) => this.reveal(x, y, this.STYLE_ID.flood)); let n = (flooding ? 70 : 10) * s.dt
      while (n > 0) { if (Math.random() < n) { const j = (Math.random() * this.bubPts.length) | 0; if (!flooding || B.revs[j] < s.front - .05) { const i = B.next; B.next = (i + 1) % B.N; B.x[i] = this.bubPts[j][0]; B.y[i] = this.bubPts[j][1]; B.z[i] = this.zf + 2 + Math.random() * 6; B.vy[i] = 30 + Math.random() * 50; B.r[i] = 1.2 + Math.random() * 3; B.life[i] = 2.5 } } n -= 1 } }
    for (let i = 0; i < B.N; i++) { if (B.life[i] <= 0) { _m.makeScale(0, 0, 0); B.mesh.setMatrixAt(i, _m); continue }
      B.life[i] -= s.dt; B.y[i] -= B.vy[i] * s.dt; B.x[i] += Math.sin(t * 4 + i) * 6 * s.dt
      if (flooding && this.reveal(B.x[i], B.y[i], this.STYLE_ID.flood) > s.front - .01) B.life[i] = 0; if (!this.inside(B.x[i], B.y[i])) B.life[i] = 0
      _p.set(B.x[i], -B.y[i], B.z[i]); _s.setScalar(B.r[i] * clamp01(B.life[i] * 4)); _m.compose(_p, _q.identity(), _s); B.mesh.setMatrixAt(i, _m) }
    B.mesh.instanceMatrix.needsUpdate = true
    // crystals
    this.crystals.items.forEach((it, i) => {
      _q.setFromUnitVectors(_Y, it.dir); _q2.setFromAxisAngle(it.dir, it.roll); _q.premultiply(_q2)
      let g = it.tb === Infinity || t < it.tb ? 0 : backOut(clamp01((t - it.tb) / .45)); _p.set(it.x, -it.y, it.z)
      if (it.td < Infinity) { const d = t - it.td; _p.set(it.x + it.v.x * d, -it.y + it.v.y * d - 300 * d * d, it.z + it.v.z * d); _q2.setFromAxisAngle(it.ax, d * 9); _q.multiply(_q2); g *= 1 - clamp01((d - .7) / .4) }
      _s.set(it.w * g, it.len * g, it.w * g); _p.addScaledVector(_v.copy(_Y).applyQuaternion(_q), it.len * g * .6); _m.compose(_p, _q, _s); this.crystals.mesh.setMatrixAt(i, _m)
    })
    this.crystals.mesh.instanceMatrix.needsUpdate = true
    // graphs
    for (const G of this.graphs) {
      const P = G.items.map((n, i) => {
        let k = 0; const rest = _v2.set(n.x, -n.y, this.zf + 5 + Math.sin(t * 1.5 + i) * 1.2)
        if (n.tb < Infinity && t >= n.tb) { const u = clamp01((t - n.tb) / .6), e = 1 - Math.pow(1 - u, 3), a = n.a0 + (1 - e) * 3, R = n.R0 * (1 - e)
          _p.set(rest.x + Math.cos(a) * R, rest.y + Math.sin(a) * R, rest.z + R * .4); k = u >= 1 ? 1 + .25 * Math.max(0, Math.sin(t * 3 + i)) : .8
          if (n.td < Infinity) { const d = clamp01((t - n.td) / .7), a2 = n.a0 + d * 3, R2 = n.R0 * d * d; _p.set(rest.x + Math.cos(a2) * R2, rest.y + Math.sin(a2) * R2, rest.z + R2 * .4); k *= 1 - d } }
        else _p.copy(rest)
        _s.setScalar(2.6 * k); _m.compose(_p, _q.identity(), _s); G.mesh.setMatrixAt(i, _m); return [_p.clone(), k] })
      G.mesh.instanceMatrix.needsUpdate = true
      G.links.forEach((l, i) => { const [pa, ka] = P[l.a], [pb, kb] = P[l.b], on = ka > .9 && kb > .9 ? 1 : 0, nA = G.items[l.a], nB = G.items[l.b]
        const grow = on ? clamp01((t - Math.max(nA.tb, nB.tb) - .6) / .3) * Math.min(ka, kb, 1) : 0
        _v.subVectors(pb, pa); const L = _v.length(); _q.setFromUnitVectors(_Y, _v.normalize()); _s.set(.55 * grow, L * grow, .55 * grow); _m.compose(pa, _q, _s); G.lm.setMatrixAt(i, _m) })
      G.lm.instanceMatrix.needsUpdate = true
    }
    // aurora ribbons: they sweep in as Classic arrives; in the app the resting mark holds none (at app sizes the drifting
    // ribbons read as horizontal smears across the glass, Codex's Classic captures 3 Nov); the film keeps them
    const pa = this.presenceOf('classic', s)
    for (const m of this.aur) { const u = m.material.uniforms; u.t.value = t; u.pres.value = s.target === 'classic' ? 1 : s.look === 'classic' && !s.target ? (this.filmPieces === false ? 0 : .5) : pa * .8; u.sweep.value = s.target === 'classic' ? clamp01(s.front * 1.4) : 1; m.visible = u.pres.value > .001 }   // never drawn when absent (a real GPU showed faint rings)
    // wireframe and laser
    const wu = this.wire.material.uniforms, scanning = s.target === 'construct'
    wu.pres.value = scanning ? 1 : s.look === 'construct' ? (s.target ? 1 - clamp01(s.front * 1.3) : .3) : 0; wu.scanY.value = scanning ? s.front / .92 * 256 : 300
    this.laser.material.uniforms.pres.value = scanning ? 1 - clamp01((s.front - .95) * 10) : 0; this.wire.visible = wu.pres.value > .001; this.laser.visible = this.laser.material.uniforms.pres.value > .001; this.laser.position.set(0, 128 - (scanning ? s.front / .92 * 256 : 0), 4)
    // glitch slabs, in the same bursts as the material's glitches
    const SL = this.slab, glitchy = (s.target === 'glitch' && s.style === 'glitch') || (s.look === 'glitch' && !s.target && this.vnoise(t * 1.7, 2) > .62)
    if (glitchy) { let n = 70 * s.dt; while (n > 0) { if (Math.random() < n) { const i = SL.next; SL.next = (i + 1) % SL.N; const [x, y] = this.slabPts[(Math.random() * this.slabPts.length) | 0]; SL.x[i] = x + (Math.random() - .5) * 20; SL.y[i] = y; SL.z[i] = this.zf + 2 + Math.random() * 8; SL.w[i] = 18 + Math.random() * 46; SL.life[i] = .08 + Math.random() * .16; SL.mesh.setColorAt(i, _c.set(Math.random() < .5 ? '#5ff0ff' : '#ff5fd8').multiplyScalar(1.4)) } n -= 1 } }
    for (let i = 0; i < SL.N; i++) { SL.life[i] -= s.dt; const on = SL.life[i] > 0; _p.set(SL.x[i], -SL.y[i], SL.z[i]); _s.set(on ? SL.w[i] : 0, on ? 3 + (i % 3) * 2 : 0, on ? 2 : 0); _m.compose(_p, _q.identity(), _s); SL.mesh.setMatrixAt(i, _m) }
    SL.mesh.instanceMatrix.needsUpdate = true; if (SL.mesh.instanceColor) SL.mesh.instanceColor.needsUpdate = true
    // the paintbrush follows the stroke being painted
    if (s.target === 'omegatown' && s.style === 'paint' && s.front < 1) { const f = clamp01(s.front) * 11, b = Math.min(10, Math.floor(f)), xp = clamp01((f - b) / .98), x = b % 2 === 0 ? xp * 280 : (1 - xp) * 280, y = b * 24 + 12 - 6 * Math.sin(x * .04)
      this.brush.position.set(x - 140, -y + 128, this.zf - 8 + 4); this.brush.rotation.set(.55, 0, (b % 2 === 0 ? -1 : 1) * .5); this.brush.scale.setScalar(Math.min(2.2, this.brush.scale.x + s.dt * 10)) }   // big enough to read, leaning toward you
    else this.brush.scale.setScalar(Math.max(0, this.brush.scale.x - s.dt * 10))
    // planets orbit inside the glass
    const pc = this.presenceOf('cosmos', s)
    this.planets.forEach((m, k) => { const { R, w } = m.userData, a = t * w + k * 2; m.position.set(212 - 140 + Math.cos(a) * R, -(118 - Math.sin(a) * R * .7) + 128, this.zf - 8 + 6 + Math.sin(a) * 3); m.scale.setScalar(pc) })
  }
  splashOne(x, y, f) { const S = this.splash, i = S.next, a = f * 6.283 + Math.random() * .3, v = 60 + Math.random() * 60; S.next = (i + 1) % S.N
    S.pos.set([x, -y, this.zf + 1], i * 3); S.vel.set([Math.cos(a) * v, Math.sin(a) * v, 110 + Math.random() * 90], i * 3); S.size[i] = .9 + Math.random() * 1.4; S.life[i] = S.max[i] = .7 + Math.random() * .3 }
  spark([x, y], t) {
    const P = this.sparks, i = P.next; P.next = (i + 1) % P.N
    P.pos.set([x, -y, this.zf + 1], i * 3); P.vel.set([(Math.random() - .5) * 140, 60 + Math.random() * 200, 50 + Math.random() * 150], i * 3); P.life[i] = P.max[i] = .45 + Math.random() * .5
    this.sound.at(t, 'spark', {}, .03)
  }
}
const _c = new THREE.Color(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3()
