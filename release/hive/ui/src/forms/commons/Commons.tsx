import { useEffect, useState } from 'react'
import type { FormProps } from '../contract'
import { Canvas } from './Canvas'
import { Classic } from './Classic'
import { chromePalette, commonsGrammar, paletteFor, paletteVars } from './palette'
import { Still } from './Still'
import { useCommons } from './useCommons'
import './commons.css'

/**
 * Commons Explorer's form: "the commons", what this swarm believes and why. One state (useCommons), three renderings:
 *  - classic: a living sky of beliefs in the hive's night (lavender and cyan among the stars);
 *  - still:   what the swarm believes, written down on paper;
 *  - canvas:  the beliefs as cards on islands of the board (light or dark, as the board is).
 * Cosmos, Flux and Construct open in classic until they get their own, dressed in that experience's chrome
 * (forms/chromeDress.ts): its surfaces, ink, accent, corners and type.
 */

/** The experience chrome's light or dark (html[data-xc-scheme]), kept current. */
function useScheme(): 'light' | 'dark' {
  const read = () => (typeof document !== 'undefined' && document.documentElement.dataset.xcScheme === 'light' ? 'light' : 'dark')
  const [s, setS] = useState<'light' | 'dark'>(read)
  useEffect(() => {
    const mo = new MutationObserver(() => setS(read()))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-xc-scheme'] })
    return () => mo.disconnect()
  }, [])
  return s
}

export default function Commons(props: FormProps) {
  const cs = useCommons(props)
  const g = commonsGrammar(props.grammar)
  const scheme = useScheme()
  const dressed = !!props.dressFrom
  const pal = paletteFor(g, scheme)
  return (
    <div className="cm" data-grammar={g} data-ask-surface="commons" data-palette={dressed ? 'chrome' : pal} data-chrome={dressed ? '' : undefined} data-host-grammar={props.dressFrom ?? props.grammar} data-scheme={dressed ? scheme : undefined} style={paletteVars(dressed ? chromePalette(scheme) : pal)} role="region" aria-label={`${props.program.name}: the commons`}>
      {g === 'still' ? <Still cs={cs} /> : g === 'canvas' ? <Canvas cs={cs} /> : <Classic cs={cs} />}
    </div>
  )
}
