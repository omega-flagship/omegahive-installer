/**
 * SIM ONLY (lab-figures r1 fixture): a tiny, valid PNG made from code, so the sim's figure is generated here and
 * not copied from any report. 8-bit RGB, no filtering, zlib "stored" blocks, real CRC-32 and Adler-32. It is an
 * invented test pattern, never producer content.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function adler32(bytes: Uint8Array): number {
  let a = 1
  let b = 0
  for (const x of bytes) {
    a = (a + x) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]

function chunk(type: string, data: Uint8Array): number[] {
  const body = new Uint8Array(4 + data.length)
  for (let i = 0; i < 4; i++) body[i] = type.charCodeAt(i)
  body.set(data, 4)
  return [...u32(data.length), ...body, ...u32(crc32(body))]
}

/** zlib wrapper around stored (uncompressed) deflate blocks. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const out: number[] = [0x78, 0x01]
  for (let i = 0; i < raw.length || i === 0; i += 65535) {
    const part = raw.subarray(i, Math.min(raw.length, i + 65535))
    const last = i + 65535 >= raw.length ? 1 : 0
    out.push(last, part.length & 0xff, part.length >>> 8, ~part.length & 0xff, (~part.length >>> 8) & 0xff, ...part)
    if (raw.length === 0) break
  }
  out.push(...u32(adler32(raw)))
  return new Uint8Array(out)
}

/** A PNG of `width` × `height` RGB pixels from `pixel(x, y)`. */
export function makePng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 3))
  let o = 0
  for (let y = 0; y < height; y++) {
    raw[o++] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y)
      raw[o++] = r
      raw[o++] = g
      raw[o++] = b
    }
  }
  const ihdr = new Uint8Array([...u32(width), ...u32(height), 8, 2, 0, 0, 0])
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', ihdr), ...chunk('IDAT', zlibStored(raw)), ...chunk('IEND', new Uint8Array(0))])
}

/** The sim's invented figure: a 96 × 60 test pattern (bands and a diagonal), the same bytes every time. */
export function simTestPattern(): Uint8Array {
  return makePng(96, 60, (x, y) => {
    if (Math.abs(x - y * 1.6) < 1.5) return [235, 235, 245]
    const band = Math.floor(x / 24)
    return [[40, 60, 120], [60, 120, 90], [140, 90, 50], [110, 60, 130]][band].map((c) => Math.min(255, c + (y % 12 === 0 ? 30 : 0))) as [number, number, number]
  })
}
