// @ts-expect-error Node strip-types tests require the source extension.
import { assetReference, BLANK_IMAGE, rewriteRemoteImages } from './design-artifact.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { sniffImageType } from './image-sniff.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { fetchPublicImage } from './public-fetch.ts'

// A design never touches the network while it runs: a script could choose which
// requests to make and so leak what the viewer types. The images the stored markup
// names are embedded as data: URLs before the design runs: artifact-frame marks them,
// and its wrapper (fx0's own code, not the design) loads them from /api/artifact-image,
// where the browser keeps them across revisions. What is loaded depends only on the
// stored design, never on the viewer.

export const MAX_REMOTE_IMAGES = 12

/** One remote image as a data: URL. Throws when it is unreachable, too large or not an image. */
export async function loadRemoteImage(url: string): Promise<string> {
  const { body } = await fetchPublicImage(url, AbortSignal.timeout(5_000))
  const type = sniffImageType(body)
  if (!type) throw new Error('Not an image')
  return `data:${type};base64,${body.toString('base64')}`
}

/**
 * The design with each remote or attached image replaced by a marker the wrapper swaps for the
 * image, in document order, at most MAX_REMOTE_IMAGES; any other becomes a blank image.
 * The nonce is fresh per response, so the design's own text cannot name a marker.
 */
export function markRemoteImages(html: string, nonce: string, { remote = true } = {}): { html: string; images: { marker: string; url: string }[] } {
  const urls: string[] = []
  rewriteRemoteImages(html, (url: string) => {
    // With remote images off, only attached images (fx0-asset:) are shown.
    if (!urls.includes(url) && (remote || assetReference(url))) urls.push(url)
    return BLANK_IMAGE
  })
  const images = urls.slice(0, MAX_REMOTE_IMAGES).map((url, index) => ({ marker: `fx0-image-${nonce}-${index}`, url }))
  if (!images.length) return { html, images }
  const markers = new Map(images.map(({ marker, url }) => [url, marker]))
  return { html: rewriteRemoteImages(html, (url: string) => markers.get(url) ?? BLANK_IMAGE), images }
}
