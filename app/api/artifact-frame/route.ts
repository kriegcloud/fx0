import { ARTIFACT_IMAGE_PATH, artifactImageSrc } from '../../../lib/artifact-image'
import { DESIGN_ARTIFACT_EMBEDDED_CSP, designFrameCsp, designFrameHtml, prepareDesignArtifactHtml, remoteImagesEnabled } from '../../../lib/design-artifact'
import { markRemoteImages } from '../../../lib/remote-image'
import { readDesignArtifactAt } from '../../../lib/journal'
import { readGeneration } from '../../../lib/history'
import { withSessionRoute } from '../../../lib/route-auth'
import { log } from '../../../lib/session'

export const maxDuration = 30

export const GET = withSessionRoute(async (request, { id: sessionId, user }) => {
  // Without a revision this is the live design in Redis; with one, a past version from Neon.
  const params = new URL(request.url).searchParams
  const revision = Number(params.get('revision'))
  const past = Number.isSafeInteger(revision) && revision > 0
  const live = past ? null : await readDesignArtifactAt(sessionId)
  const artifact = past ? await readGeneration(user.id, sessionId, revision) : live!.html
  // ?v= names the revision the page expects. When it is the one live, the browser may
  // keep this response but must revalidate it: this route checks the session first,
  // so a reload costs a 304 and a signed-out browser gets nothing from its cache.
  const version = Number(params.get('v'))
  const cacheable = live?.html != null && Number.isSafeInteger(version) && version > 0 && version === live.revision
  const etag = cacheable ? `"${sessionId}:${live.revision}"` : null
  if (etag && request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { 'cache-control': 'private, no-cache', etag } })
  }
  const readyToken = crypto.randomUUID()
  // Remote images become markers here; the wrapper loads each from /api/artifact-image
  // and embeds it before the design runs, so the design has no network and the
  // browser keeps the images across revisions (lib/remote-image.ts).
  const marked = artifact != null
    ? markRemoteImages(artifact, crypto.randomUUID().replaceAll('-', ''), { remote: remoteImagesEnabled() })
    : { html: artifact, images: [] }
  const images = marked.images.map(({ marker, url }) => ({ marker, src: artifactImageSrc(sessionId, url) }))
  const prepared = marked.html == null ? null : prepareDesignArtifactHtml(marked.html, DESIGN_ARTIFACT_EMBEDDED_CSP, readyToken)
  // Every stored design passed validation, so this only guards against one that
  // somehow lacks a doctype: it is never shown without its CSP.
  if (artifact != null && prepared == null) log(sessionId, 'artifact:unrenderable', { revision: past ? revision : live!.revision })
  const preparedArtifact = prepared ??
    `<!doctype html><html><head><meta charset="utf-8"><title>No design artifact</title></head><body><p>${
      artifact != null ? 'This design could not be prepared for preview.'
        : past ? 'This version is not in the history.' : 'No design artifact has been published for this session.'
    }</p></body></html>`
  const html = designFrameHtml(preparedArtifact, readyToken, images)
  return new Response(html, {
    status: artifact == null ? 404 : 200,
    headers: {
      'cache-control': etag ? 'private, no-cache' : 'private, no-store',
      ...(etag ? { etag } : {}),
      'content-security-policy': designFrameCsp(images.length ? `${new URL(request.url).origin}${ARTIFACT_IMAGE_PATH}` : undefined),
      'content-type': 'text/html; charset=utf-8',
      'permissions-policy':
        'accelerometer=(), camera=(), clipboard-read=(), clipboard-write=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), usb=()',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  })
})
