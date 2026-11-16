// stateAt(timeline, t): pure in (timeline, t). No dt, no clock, no Math.random.
const ease = {'in-out': u => u<.5 ? 2*u*u : 1-Math.pow(-2*u+2,2)/2, linear: u => u};
export function stateAt(tl, t) {
  const seg = tl.segments.find(s => t >= s.from && t < s.to) ?? tl.segments.at(-1);
  const age = t - seg.from;
  const tr = tl.transitions.find(x => t >= x.from && t < x.to);
  const morph = tr ? {a: tr.envA, b: tr.envB, kind: tr.morph, p: ease[tr.ease]((t - tr.from)/(tr.to - tr.from))} : null;
  const p = seg.presence;
  return { beat: seg.beat, env: seg.env, action: seg.action, intent: seg.intent, next: seg.next,
    lt: seg.lt.a + seg.lt.rate*age,
    presence: {mode: p.mode, v: p.target + (p.from - p.target)*Math.exp(-p.k*age)},
    morph, fired: tl.events.filter(e => e.t <= t).map(e => e.id),
    endcard: tl.endcard && t >= tl.endcard.from ? tl.endcard.text : null };
}
