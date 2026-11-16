/**
 * NAL truth revision, pure (Wang's Non-Axiomatic Logic). A confidence c stands for w = c / (1 − c) units of evidence.
 * Two truths about the same statement pool their evidence: frequency is the evidence-weighted mean, and confidence is
 * w / (w + 1) over the summed weight. Confidence stays inside (0, 1), as a NAL truth value must.
 */
import type { Truth } from './types'

export const C_MIN = 0.01
export const C_MAX = 0.99

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** A truth made safe: finite, frequency in [0, 1], confidence in [0.01, 0.99]. */
export function clampTruth(t: Truth): Truth {
  const f = Number.isFinite(t.frequency) ? clamp(t.frequency, 0, 1) : 1
  const c = Number.isFinite(t.confidence) ? clamp(t.confidence, C_MIN, C_MAX) : C_MIN
  return { frequency: f, confidence: c }
}

/** Evidence weight of a confidence: w = c / (1 − c). */
export const weight = (c: number): number => {
  const k = clamp(c, C_MIN, C_MAX)
  return k / (1 - k)
}

/** Revise two truths about one statement (NAL revision). Symmetric; never reaches confidence 1. */
export function revise(a: Truth, b: Truth): Truth {
  const x = clampTruth(a)
  const y = clampTruth(b)
  const w1 = weight(x.confidence)
  const w2 = weight(y.confidence)
  const w = w1 + w2
  const frequency = (w1 * x.frequency + w2 * y.frequency) / w
  const confidence = w / (w + 1)
  return clampTruth({ frequency: round(frequency), confidence: round(confidence) })
}

const round = (n: number) => Math.round(n * 1e4) / 1e4
