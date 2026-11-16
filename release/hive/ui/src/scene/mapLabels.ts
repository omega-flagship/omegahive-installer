/**
 * The star map's swarm labels (name and "n beliefs · n minds", drawn on the canvas, scene/engine drawLabels) as
 * screen boxes, so DOM overlays such as a first-visit hint can stay off them (tour/ViewInfo). The live scene registers
 * its reader; none: no boxes.
 */
export interface LabelBox {
  left: number
  top: number
  width: number
  height: number
}

/** The box around one swarm's two label lines, as drawLabels places them (centred under the core). */
export function swarmLabelBox(sx: number, sy: number, z: number, name: string, stats: string): LabelBox {
  const zs = Math.pow(z, 0.8)
  const top = sy + 70 * zs + 8
  // 12px caps with 0.18em tracking (~10.6px a letter), and 10px stats (~5.6px a letter), with a little margin
  const width = Math.max(name.length * 10.6, stats.length * 5.6) + 16
  return { left: sx - width / 2, top: top - 4, width, height: 34 }
}

let reader: (() => LabelBox[]) | null = null
export function setMapLabelReader(fn: (() => LabelBox[]) | null): void {
  reader = fn
}
export function mapLabelBoxes(): LabelBox[] {
  try {
    return reader ? reader() : []
  } catch {
    return []
  }
}
