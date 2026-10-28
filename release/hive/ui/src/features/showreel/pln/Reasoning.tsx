/**
 * The Reasoning layer: each inference step with its rule, the formula from the hive's own MeTTa typeset, the same
 * formula with the premise numbers plugged in, and the conclusion (stv f c) with the evidence behind it. A step whose
 * premise is an earlier step's conclusion links back to it, so a chain reads from evidence to conclusion.
 */
import type { InferenceStep } from '../types'
import { Tex } from './Formula'
import { fmt, namesOf, rounded } from './formulaText'
import { bind, branchOf, C2W, evidenceOf, RULES, W2C, type Rule, type Stv } from './rules'
import { argsOf, caseById, computed, ruleOf, type WorkedCase } from './worked'

function StvText({ tv }: { tv: Stv }) {
  const exact = rounded(tv[0]) || rounded(tv[1])
  return (
    <code className="pln-stv" title={exact ? `(stv ${tv[0]} ${tv[1]})` : undefined}>
      (stv {fmt(tv[0])} {fmt(tv[1])}){exact ? ' ≈' : ''}
    </code>
  )
}

function Evidence({ c }: { c: number }) {
  const w = evidenceOf(c)
  return <span className="pln-w">{w === null ? 'w: none (c = 1)' : <>w = {fmt(w)}</>}</span>
}

/** One line: name = formula (`out`: the conclusion's strength or confidence, said in words). */
function Line({ name, out, ex, rule, values }: { name?: string; out?: 'strength' | 'confidence'; ex: Rule['s']; rule: Rule; values?: Record<string, number> }) {
  const names = namesOf(rule)
  const n = name ? names[name] ?? { sym: name } : null
  return (
    <div className="pln-line">
      {n ? (
        <span className="pln-var">
          <i>{n.sym}</i>
          {n.sub && <sub>{n.sub}</sub>}
        </span>
      ) : (
        <span className="pln-out">{out}</span>
      )}
      <span className="pln-sign"> = </span>
      <Tex e={ex} names={names} values={values} />
    </div>
  )
}

const capNote = 'Revision caps differ: lib_pln’s Truth__Revision caps the confidence at 1.0, lib_nal’s Truth_Revision at 0.99.'

/** One rule applied to one worked example. */
export function RuleWork({ c, label, premises, conclusion, fromStep }: { c: WorkedCase; label: string; premises: string[]; conclusion: string; fromStep?: Record<number, { step: number; id: string }> }) {
  const rule = ruleOf(c)
  if (!rule) return null
  const args = argsOf(c)
  const env = bind(rule, args)
  const out = computed(c) as Stv
  const branch = branchOf(rule, args)
  const plug: Record<string, number> = env
  const revision = rule.id === 'Truth__Revision' || rule.id === 'Truth_Revision'
  return (
    <details className="pln-step" open id={`pln-${c.id}`}>
      <summary>
        <span className="pln-rule">{label}: {rule.name}</span>
        <span className="pln-src">
          {rule.id} · {rule.file}:{rule.line}
        </span>
      </summary>
      <ol className="pln-premises" aria-label="Premises">
        {rule.params.map((p, i) => (
          <li key={p.s}>
            <span className="pln-role">{p.role}</span> <span className="pln-atom">{premises[i] ?? ''}</span> <StvText tv={args[i]} /> <Evidence c={args[i][1]} />
            {fromStep?.[i] !== undefined && (
              <button type="button" className="pln-from" onClick={() => document.getElementById(`pln-${fromStep[i].id}`)?.scrollIntoView({ block: 'nearest' })}>
                the conclusion of step {fromStep[i].step + 1}
              </button>
            )}
          </li>
        ))}
      </ol>
      <p className="pln-h">The formula ({rule.file}:{rule.line})</p>
      <div className="pln-formula" role="group" aria-label={`${rule.name} formula`}>
        {rule.lets.map(([n, ex]) => (
          <Line key={n} name={n} ex={ex} rule={rule} />
        ))}
        <Line out="strength" ex={rule.s} rule={rule} />
        <Line out="confidence" ex={rule.c} rule={rule} />
      </div>
      <p className="pln-h">With the numbers</p>
      <div className="pln-formula pln-plugged" role="group" aria-label={`${rule.name} with the numbers`}>
        {rule.lets.map(([n, ex]) => (
          <Line key={n} name={n} ex={ex} rule={rule} values={plug} />
        ))}
        <Line out="strength" ex={rule.s} rule={rule} values={plug} />
        <Line out="confidence" ex={rule.c} rule={rule} values={plug} />
      </div>
      <p className="pln-conclusion">
        <span className="pln-role">Conclusion</span> <span className="pln-atom">{conclusion}</span> <StvText tv={out} /> <Evidence c={out[1]} />
      </p>
      {branch !== 'main' && <p className="pln-note">These inputs take another branch of the rule; see its notes.</p>}
      {(rule.notes ?? []).map((n) => (
        <p key={n} className="pln-note">
          {n}
        </p>
      ))}
      {revision && <p className="pln-note pln-cap">{capNote}</p>}
    </details>
  )
}

/** The two revisions side by side on inputs where the caps differ (shown with every revision step). */
function CapComparison() {
  const p = caseById('pln-rev-cap')
  const n = caseById('nal-rev-cap')
  if (!p || !n) return null
  const args = argsOf(p)
  return (
    <div className="pln-compare" role="group" aria-label="Where the two revisions differ">
      <p className="pln-h">Where the caps differ: the same two premises, {args.map((a, i) => <StvText key={i} tv={a} />)}</p>
      <p>
        lib_pln Truth__Revision ({RULES.Truth__Revision.file}:{RULES.Truth__Revision.line}) gives <StvText tv={computed(p) as Stv} />
      </p>
      <p>
        lib_nal Truth_Revision ({RULES.Truth_Revision.file}:{RULES.Truth_Revision.line}) gives <StvText tv={computed(n) as Stv} />: the confidence stops at 0.99.
      </p>
    </div>
  )
}

/** The whole layer for a step's inferences. */
export function Reasoning({ steps }: { steps: InferenceStep[] }) {
  const index = new Map(steps.map((s, i) => [s.case, i]))
  const revises = steps.some((s) => /Revision/.test(caseById(s.case)?.fn ?? ''))
  return (
    <div className="pln-layer">
      <p className="pln-intro">
        Every truth value is (stv s c): strength and confidence. The evidence behind a confidence is w = c / (1 − c) (Truth__c2w, {C2W.file}:{C2W.line}), and back, c = w / (w + 1) (Truth__w2c, {W2C.file}:{W2C.line}). Each formula below is read from the hive’s own MeTTa and computed on these inputs.
      </p>
      {steps.map((s, i) => {
        const c = caseById(s.case)
        if (!c) return <p key={s.case}>Not available yet.</p>
        const fromStep: Record<number, { step: number; id: string }> = {}
        c.args.forEach((a, k) => {
          if (!Array.isArray(a) && typeof a === 'object' && index.has(a.from)) fromStep[k] = { step: index.get(a.from)!, id: a.from }
        })
        return <RuleWork key={s.case} c={c} label={`Step ${i + 1}`} premises={s.premises} conclusion={s.conclusion} fromStep={fromStep} />
      })}
      {revises && <CapComparison />}
    </div>
  )
}
