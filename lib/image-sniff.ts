export type SniffedImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/avif'

const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end))

// The image type the bytes actually hold, whatever a server or client claims.
// SVG, HTML and anything unrecognized are null.
export function sniffImageType(bytes: Uint8Array): SniffedImageType | null {
  if (bytes.length < 12) return null
  if (bytes[0] === 0x89 && ascii(bytes, 1, 8) === 'PNG\r\n\x1a\n') return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'image/gif'
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp'
  if (ascii(bytes, 4, 8) === 'ftyp') {
    // An ISO-BMFF file is AVIF when its major or a compatible brand says so.
    const size = Math.min(bytes.length, (bytes[0] << 24 | bytes[1] << 16 | bytes[2] << 8 | bytes[3]) >>> 0)
    for (let offset = 8; offset + 4 <= size; offset += offset === 8 ? 8 : 4) {
      const brand = ascii(bytes, offset, offset + 4)
      if (brand === 'avif' || brand === 'avis') return 'image/avif'
    }
  }
  return null
}

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1]
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8)
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)
const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

/** Width and height from an image's header, or null when it is malformed or truncated. */
export function imageDimensions(bytes: Uint8Array, type: SniffedImageType): { width: number; height: number } | null {
  if (type === 'image/png') return bytes.length >= 24 && ascii(bytes, 12, 16) === 'IHDR'
    ? { width: (bytes[16] << 24 | bytes[17] << 16 | bytes[18] << 8 | bytes[19]) >>> 0, height: (bytes[20] << 24 | bytes[21] << 16 | bytes[22] << 8 | bytes[23]) >>> 0 }
    : null
  if (type === 'image/gif') return bytes.length >= 10 ? { width: u16le(bytes, 6), height: u16le(bytes, 8) } : null
  if (type === 'image/webp') {
    const chunk = ascii(bytes, 12, 16)
    if (chunk === 'VP8 ' && bytes.length >= 30) return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff }
    if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
      return { width: 1 + (((bytes[22] & 0x3f) << 8) | bytes[21]), height: 1 + (((bytes[24] & 0x0f) << 10) | (bytes[23] << 2) | ((bytes[22] & 0xc0) >> 6)) }
    }
    if (chunk === 'VP8X' && bytes.length >= 30) return { width: 1 + u24le(bytes, 24), height: 1 + u24le(bytes, 27) }
    return null
  }
  if (type === 'image/jpeg') {
    // Walk the segments to the first frame header, baseline or progressive.
    let index = 2
    while (index + 9 <= bytes.length) {
      if (bytes[index] !== 0xff) return null
      const marker = bytes[index + 1]
      if (marker === 0xff) { index++; continue }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { index += 2; continue }
      if (JPEG_FRAMES.has(marker)) return { width: u16be(bytes, index + 7), height: u16be(bytes, index + 5) }
      const length = u16be(bytes, index + 2)
      if (length < 2) return null
      index += 2 + length
    }
    return null
  }
  return null
}
