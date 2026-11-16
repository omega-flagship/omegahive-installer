import type { FormProps } from '../contract'
import { Classic } from './Classic'
import { Construct } from './Construct'
import { caseGrammar, chromePalette, paletteVars } from './palette'
import { useXcScheme } from '../chromeDress'
import { Still } from './Still'
import { useCase } from './useCase'
import './caseFile.css'

/**
 * OmegaTruth's case file: the evidence room. One state (useCase), three renderings:
 *  - classic: dark glass, the balance as a luminous brass beam;
 *  - still: a legal brief on warm paper, For and Against as facing columns, footnoted exhibits, errata;
 *  - construct: a terminal docket, CLAIMS / EVIDENCE ± / EXHIBITS custody log / ERRATA, keyboard verbs.
 * Other grammars use the classic rendering until they get their own, dressed in that experience's chrome
 * (forms/chromeDress.ts): its surfaces, ink, accent, corners and type.
 */

export default function CaseFile(props: FormProps) {
  const cs = useCase(props)
  const g = caseGrammar(props.grammar)
  // the app's own name, as the host lists it: the case file never names an app itself (it serves any argument app)
  const brand = props.program.name
  const scheme = useXcScheme()
  const dressed = !!props.dressFrom
  return (
    <div className="cf" data-grammar={g} data-chrome={dressed ? '' : undefined} data-scheme={dressed ? scheme : undefined} data-host-grammar={props.dressFrom ?? props.grammar} style={paletteVars(dressed ? chromePalette(scheme) : g)} aria-label={`${props.program.name}: case file`} role="region">
      {g === 'still' ? <Still cs={cs} describe={props.describe} brand={brand} /> : g === 'construct' ? <Construct cs={cs} describe={props.describe} brand={brand} /> : <Classic cs={cs} describe={props.describe} brand={brand} />}
    </div>
  )
}
