import { createHmac, timingSafeEqual } from 'node:crypto'
// @ts-expect-error Node strip-types tests require the source extension.
import { assetReference, remoteImageUrl } from './design-artifact.ts'

// The wrapper loads a design's images from /api/artifact-image. The route serves only the
// chat's owner, and only a URL artifact-frame signed for that chat, so it cannot be used
// to fetch arbitrary addresses. The URL is stable per chat and image, so the browser
// keeps the image across revisions.

export const ARTIFACT_IMAGE_PATH = '/api/artifact-image'

function signature(sessionId: string, url: string): Buffer {
  const secret = process.env.SESSION_SECRET
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters')
  const key = createHmac('sha256', secret).update('fx0 artifact-image key v1').digest()
  return createHmac('sha256', key).update(`${sessionId}\n${url}`).digest()
}

/** The same-origin path the wrapper fetches `url` from, for this chat. */
export function artifactImageSrc(sessionId: string, url: string): string {
  const params = new URLSearchParams({ session: sessionId, u: url, sig: signature(sessionId, url).toString('base64url') })
  return `${ARTIFACT_IMAGE_PATH}?${params}`
}

/** The remote image or attached-image reference a request may load for this chat, or null. */
export function verifyArtifactImage(sessionId: string, value: string | null, sig: string | null): string | null {
  const url = value == null ? null : assetReference(value) ?? remoteImageUrl(value)
  if (!url || url !== value || !sig || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return null
  const given = Buffer.from(sig, 'base64url')
  const expected = signature(sessionId, url)
  return given.length === expected.length && timingSafeEqual(given, expected) ? url : null
}
