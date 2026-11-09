/**
 * The person's mind drawn in the look they are in (Jon: "use whatever is tasteful for each UI"): Classic's glass
 * figure, Cosmos's constellation, Still's line portrait. One set of props, one set of data; only the drawing differs.
 */
import { GlassFigure, type GlassFigureProps } from './GlassFigure'
import { ConstellationFigure, LinePortrait } from './LookFigures'
import { useMindLook, type MindLook } from './mindLook'

export function MindFigure(props: GlassFigureProps & { look?: MindLook }) {
  const auto = useMindLook()
  const look = props.look ?? auto
  if (look === 'cosmos') return <ConstellationFigure {...props} />
  if (look === 'still') return <LinePortrait {...props} />
  return <GlassFigure {...props} />
}
