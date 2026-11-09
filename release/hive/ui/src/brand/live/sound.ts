// @ts-nocheck: the reel renderer (the brand-mark r1 morph), shared as-is so the film and the app run
// the same code. Typed wrappers are in ../LiveOmega.tsx.
// The living mark's sound, as music. Every sound comes from a real event of the mark (a block landing, a sprout pushing
// through, a drip forming, the pour, the forge) and plays as a soft tuned note in one key over each material's own chord,
// synthesised with Web Audio; nothing is a recording. Live, it plays as it
// happens once the person allows sound; when filming, the same events render offline to a WAV laid under the frames.
export class MarkSound {
  constructor() { this.events = []; this.live = null; this.last = {} }
  /** Live sound needs a person's gesture first (browsers require it). */
  async enableLive() { if (!this.live) { this.live = new AudioContext(); this.liveOut = this.chain(this.live) } await this.live.resume() }
  /** Record an event at mark time t; `gap` thins rapid repeats of one kind (seconds). */
  at(t, kind, o = {}, gap = 0) {
    if (gap && t - (this.last[kind] ?? -9) < gap) return
    this.last[kind] = t; this.events.push({ t, kind, o })
    if (this.live) this.play(this.live, this.liveOut, kind, this.live.currentTime + .01, o)
  }
  chain(ctx) {
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -16; comp.ratio.value = 4; comp.connect(ctx.destination)
    const dry = ctx.createGain(); dry.gain.value = .85; dry.connect(comp)
    const conv = ctx.createConvolver(); conv.buffer = this.ir(ctx); const wet = ctx.createGain(); wet.gain.value = .45; conv.connect(wet); wet.connect(comp)
    const bus = ctx.createGain(); bus.gain.value = .9; bus.connect(dry); bus.connect(conv); return bus
  }
  ir(ctx) { // a soft room: decaying noise
    const n = Math.floor(ctx.sampleRate * 3.2), b = ctx.createBuffer(2, n, ctx.sampleRate)
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); let s = 7 + c; for (let i = 0; i < n; i++) { s = (s * 16807) % 2147483647; d[i] = (s / 2147483647 * 2 - 1) * Math.pow(1 - i / n, 3) } }
    return b
  }
  noise(ctx) {
    if (this._nz?.ctx === ctx) return this._nz.b
    const n = ctx.sampleRate * 2, b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0); let s = 3
    for (let i = 0; i < n; i++) { s = (s * 16807) % 2147483647; d[i] = s / 2147483647 * 2 - 1 }
    this._nz = { ctx, b }; return b
  }
  env(g, t, a, peak, dec) { g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(.0001, t + a + dec) }
  tone(ctx, out, t, f0, f1, dur, peak, type = 'sine', a = .005) {
    const o = ctx.createOscillator(), g = ctx.createGain(); o.type = type; o.frequency.setValueAtTime(f0, t)
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + a + dur)
    this.env(g, t, a, peak, dur); o.connect(g); g.connect(out); o.start(t); o.stop(t + a + dur + .05)
  }
  hiss(ctx, out, t, dur, peak, type, f, q = 1, a = .005, f1 = null) {
    const s = ctx.createBufferSource(); s.buffer = this.noise(ctx); s.loop = true
    const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.setValueAtTime(f, t); if (f1) fl.frequency.exponentialRampToValueAtTime(f1, t + a + dur); fl.Q.value = q
    const g = ctx.createGain(); this.env(g, t, a, peak, dur); s.connect(fl); fl.connect(g); g.connect(out); s.start(t, Math.random() * 1.5); s.stop(t + a + dur + .05)
  }
  // one key for everything (C major pentatonic), so every event is a note in the same piece
  note(r, lo = 0, span = 10) { const P = [0, 2, 4, 7, 9], i = lo + Math.floor(r * span); return 261.63 * Math.pow(2, (Math.floor(i / 5) * 12 + P[((i % 5) + 5) % 5]) / 12) }
  voice(ctx, out, t, f, dur, peak, partials, a = .004, lp = 6000) {               // a soft tuned voice: a few sine partials through a gentle filter
    const g = ctx.createGain(), fl = ctx.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = lp; fl.connect(g); g.connect(out); this.env(g, t, a, peak, dur)
    for (const [m, v, dk] of partials) { const o = ctx.createOscillator(), og = ctx.createGain(); o.frequency.value = f * m; og.gain.setValueAtTime(v, t); og.gain.exponentialRampToValueAtTime(.0001, t + a + dur * (dk || 1)); o.connect(og); og.connect(fl); o.start(t); o.stop(t + a + dur + .05) }
  }
  pad(ctx, out, t, root, dur, peak) {                                               // a slow chord bed: detuned soft voices, swelling in and out
    for (const [st, v] of [[0, 1], [7, .7], [16, .5], [14, .35]]) for (const dt of [-3, 3]) {
      const o = ctx.createOscillator(), g = ctx.createGain(), fl = ctx.createBiquadFilter(); o.type = 'triangle'; o.frequency.value = root * Math.pow(2, st / 12); o.detune.value = dt
      fl.type = 'lowpass'; fl.frequency.value = 900; g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(peak * v, t + Math.min(1.6, dur * .4)); g.gain.setValueAtTime(peak * v, t + dur * .7); g.gain.linearRampToValueAtTime(.0001, t + dur)
      o.connect(fl); fl.connect(g); g.connect(out); o.start(t); o.stop(t + dur + .05) }
  }
  air(ctx, out, t, dur, peak, f0, f1) { this.hiss(ctx, out, t, dur, peak, 'bandpass', f0, .7, dur * .45, f1) }   // a breath of air, never a hiss
  play(ctx, out, kind, t, o) {
    const r = o.r ?? Math.random(), d = o.dur || 2.6
    switch (kind) {
      case 'bed': this.pad(ctx, out, t, o.root || 130.81, d, .028); break                                                           // each material's chord, held while it lives
      case 'clack': this.voice(ctx, out, t, this.note(r, 5, 8), .45, .09, [[1, 1], [4, .35, .15], [10, .1, .05]], .002); break         // a block lands: a soft marimba note
      case 'tumble': this.voice(ctx, out, t, this.note(r, 3, 6), .3, .035, [[1, 1], [4, .3, .2]], .002); break
      case 'pop': this.voice(ctx, out, t, this.note(r, 10, 6), .35, .03, [[1, 1], [2.01, .3, .5]], .003); break                        // a sprout: a kalimba pluck
      case 'bell': this.voice(ctx, out, t, this.note(r, 12, 5), 1.2, .022, [[1, 1], [2.76, .35, .5], [5.4, .12, .25]], .004); break    // a flower opens: a glass bell
      case 'rustle': this.air(ctx, out, t, d, .02, 1800, 2600); break
      case 'pour': this.air(ctx, out, t, d, .035, 260, 520); this.voice(ctx, out, t + .1, 65.41, d, .05, [[1, 1], [2, .3]], d * .4, 400); break   // a warm low swell
      case 'plop': this.voice(ctx, out, t, this.note(r, 0, 5), .5, .05, [[1, 1], [3, .2, .2]], .004, 1500); break                       // a drip forms: a low round note
      case 'tick': this.voice(ctx, out, t, this.note(r, 14, 6), .4, .012, [[1, 1], [2.76, .3, .4]], .002); break                        // a sprinkle lands: a tiny chime
      case 'forge': this.voice(ctx, out, t, 55, d, .09, [[1, 1], [2, .4], [3, .15]], d * .5, 600); this.air(ctx, out, t, d, .04, 300, 1400)   // a deep swell rising
        for (let i = 0; i < 4; i++) this.voice(ctx, out, t + .5 + i * .45, this.note(.3 + i * .15, 10, 6), 1.4, .018, [[1, 1], [2.76, .25, .5]], .3); break
      case 'spark': break
      case 'clang': this.voice(ctx, out, t, 110, 3.6, .1, [[1, 1], [2, .5, .7], [2.76, .35, .5], [5.4, .15, .3]], .004); break           // it cools and rings: a big warm bell
      case 'whoosh': this.air(ctx, out, t, Math.min(d, 1.6), .03, 500, 1800); break
      case 'thump': this.voice(ctx, out, t, 65.41, .6, .12, [[1, 1], [1.5, .3, .3]], .004, 300); break                                   // the last block: a soft low drum
      case 'splat': this.voice(ctx, out, t, 98, .7, .08, [[1, 1], [2, .25, .3]], .006, 500); break
    }
  }
  /** Render every recorded event to a WAV (base64), for laying under filmed frames. */
  async renderWav(dur, sr = 48000) {
    const ctx = new OfflineAudioContext(2, Math.ceil(sr * dur), sr), out = this.chain(ctx)
    const fade = ctx.createGain(); fade.gain.setValueAtTime(1, Math.max(0, dur - 1.2)); fade.gain.linearRampToValueAtTime(0, dur); fade.connect(out)   // ends softly, never cut
    for (const e of this.events) if (e.t < dur) this.play(ctx, fade, e.kind, Math.max(0, e.t) + .002, e.o)
    return wavBase64(await ctx.startRendering())
  }
}

function wavBase64(buf) {
  const ch = buf.numberOfChannels, n = buf.length, sr = buf.sampleRate, bytes = new Uint8Array(44 + n * ch * 2), v = new DataView(bytes.buffer)
  const w = (o, s) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i) }
  w(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true)
  v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * ch * 2, true)
  const d = [...Array(ch)].map((_, c) => buf.getChannelData(c)); let o = 44
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { v.setInt16(o, Math.max(-1, Math.min(1, d[c][i])) * 32767, true); o += 2 }
  let s = ''; for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768))
  return btoa(s)
}
