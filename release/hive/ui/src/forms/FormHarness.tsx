import { Suspense, useCallback, useState } from 'react'
import { fixtureAct, fixtureDescribe, fixtureGraph, fixtureProgram } from './caseFile/fixture'
import { FORMS, GRAMMARS, NATIVE_GRAMMARS, formFor, type Grammar } from './contract'

/**
 * A standalone page for developing and screenshotting app forms against SYNTHETIC fixtures, outside the hive.
 * ?grammar=classic|still|construct (any Grammar; non-native ones fall back inside the form).
 * Nothing leaves the page: act() is the fixture's stand-in.
 */

const BACKDROP: Record<string, string> = { classic: '#04040f', still: '#f6f0e3', construct: '#010805' }

function readGrammar(): Grammar {
  const g = new URLSearchParams(location.search).get('grammar') as Grammar | null
  return g && GRAMMARS.includes(g) ? g : 'classic'
}

export function FormHarness() {
  const [grammar, setGrammar] = useState<Grammar>(readGrammar)
  const [focused, setFocused] = useState<string | null>(null)
  const formId = formFor(fixtureProgram.id, fixtureDescribe)
  const Form = formId ? FORMS[formId] : null
  const choose = useCallback((g: Grammar) => {
    const u = new URL(location.href)
    u.searchParams.set('grammar', g)
    history.replaceState(null, '', u)
    setGrammar(g)
  }, [])
  const chrome = new URLSearchParams(location.search).get('chrome') !== '0'
  return (
    <div style={{ height: '100dvh', overflow: 'auto', background: BACKDROP[grammar] ?? BACKDROP.classic }}>
      {chrome && (
        <nav
          aria-label="Form harness"
          style={{ position: 'fixed', zIndex: 100, right: 8, top: 8, display: 'flex', gap: 4, padding: 4, borderRadius: 10, background: 'rgb(0 0 0 / 0.55)', backdropFilter: 'blur(8px)', font: '12px/1 system-ui, sans-serif' }}
        >
          {(formId ? NATIVE_GRAMMARS[formId] : GRAMMARS).map((g) => (
            <button
              key={g}
              type="button"
              aria-pressed={g === grammar}
              onClick={() => choose(g)}
              style={{ padding: '6px 9px', borderRadius: 7, border: 0, cursor: 'pointer', color: g === grammar ? '#0b0820' : '#eceaff', background: g === grammar ? '#e8c27a' : 'transparent' }}
            >
              {g}
            </button>
          ))}
          <span className="sr-only" aria-live="polite">
            {focused ? `focus ${focused}` : ''}
          </span>
        </nav>
      )}
      {Form ? (
        <Suspense fallback={null}>
          <Form key={grammar} program={fixtureProgram} describe={fixtureDescribe} graph={fixtureGraph} grammar={grammar} act={fixtureAct} focus={setFocused} />
        </Suspense>
      ) : (
        <p style={{ color: 'var(--color-ink)', padding: 24 }}>No form for this program.</p>
      )}
    </div>
  )
}
