// @ts-expect-error Node strip-types tests require the source extension.
import { CAPTURE_LIBRARY_MS, CAPTURE_REPLY, CAPTURE_REQUEST, MAX_CAPTURE_BYTES, MAX_CAPTURE_TILES } from './capture-protocol.ts'
// @ts-expect-error Node strip-types tests require the source extension.
import { FAST_HTML_TO_IMAGE } from './vendor/fast-html-to-image.ts'

// The frame side of the screenshot protocol (lib/capture-protocol.ts). The capture library
// runs inside the design's own frame, under the CSP that gives the design no network, so
// it cannot fetch anything the design names either: the photo shows what the screen shows.
// The design's scripts share that realm and can tamper with their own photo; that only
// misleads the model about its own work, and /api/capture still checks the bytes.

/** The library and its message handler, injected into every prepared design. */
export function designCaptureScript(readyToken: string): string {
  // Encodes at once: canvas.toBlob waits for an idle moment a busy page never has. WebP is
  // about half the bytes of a JPEG at the same quality, which the upload feels most; a
  // browser that cannot write WebP (Safari) returns a PNG for it, and gets JPEG instead.
  // Nothing runs until the first capture, so a preview that is never photographed pays
  // only for parsing the library.
  const handler = `(() => {
  const token = ${JSON.stringify(readyToken)}, maxBytes = ${MAX_CAPTURE_BYTES}, maxTiles = ${MAX_CAPTURE_TILES};
  let type = null;
  const encode = (canvas, quality) => {
    if (!type) {
      const probe = document.createElement("canvas");
      probe.width = probe.height = 1;
      type = probe.toDataURL("image/webp").startsWith("data:image/webp") ? "image/webp" : "image/jpeg";
    }
    const url = canvas.toDataURL(type, quality), binary = atob(url.slice(url.indexOf(",") + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type });
  };
  const total = (blobs) => blobs.reduce((sum, blob) => sum + blob.size, 0);
  // A remainder under 15% of a viewport joins the last tile instead of becoming its own.
  const slack = () => Math.round(innerHeight * 0.15);
  // The page, cut into viewport-high tiles from the top.
  const tiles = (page) => {
    const height = innerHeight, count = Math.min(maxTiles, Math.max(1, Math.ceil((page.height - slack()) / height)));
    return Array.from({ length: count }, (_, i) => {
      const tile = document.createElement("canvas");
      tile.width = page.width;
      tile.height = i === count - 1 ? Math.min(page.height - i * height, height + slack()) : height;
      tile.getContext("2d").drawImage(page, 0, i * height, page.width, tile.height, 0, 0, page.width, tile.height);
      return tile;
    });
  };
  addEventListener("message", async (event) => {
    if (event.source !== parent || event.data?.type !== "capture" || typeof event.data.cid !== "string") return;
    const { cid, full } = event.data;
    const reply = (data) => parent.postMessage({ type: "captured", token, cid, ...data }, "*");
    try {
      const t0 = performance.now();
      await document.fonts.ready;
      const t1 = performance.now();
      const options = { pixelRatio: 1, backgroundColor: "#ffffff", timeoutMs: ${CAPTURE_LIBRARY_MS} };
      // A full page is the document from its top, as tall as its content (which can overflow
      // an html{height:100%} box) but no taller than the tiles can carry.
      const root = document.documentElement, pageHeight = Math.max(root.scrollHeight, document.body?.scrollHeight ?? 0);
      const region = full
        ? { x: 0, y: root.getBoundingClientRect().top, width: innerWidth, height: Math.min(pageHeight, maxTiles * innerHeight + slack()) }
        : { x: 0, y: 0, width: innerWidth, height: innerHeight };
      // Hot updates edit CSSOM declarations without changing the style element. An empty
      // stylesheet mutation invalidates the fork's style caches without replacing app sheets.
      const invalidation = document.createElement("style");
      document.head.append(invalidation);
      invalidation.remove();
      const page = await (await FastHtmlToImage.captureRegion(region, options)).toCanvas();
      const t2 = performance.now();
      const parts = full ? tiles(page) : [page];
      // One pass at a good quality; over the limit, one more at the quality the size suggests.
      let blobs = parts.map((part) => encode(part, 0.85));
      if (total(blobs) > maxBytes) {
        const quality = Math.min(0.75, Math.max(0.3, 0.85 * (maxBytes / total(blobs)) * 0.9));
        blobs = parts.map((part) => encode(part, quality));
      }
      const t3 = performance.now();
      if (total(blobs) > maxBytes) return reply({ error: "too-large" });
      const covered = parts.reduce((sum, part) => sum + part.height, 0);
      reply({
        blobs, width: page.width, height: page.height, truncated: full && covered < pageHeight,
        timing: { fontsMs: t1 - t0, libraryMs: t2 - t1, encodeMs: t3 - t2 },
      });
    } catch {
      reply({ error: "capture-failed" });
    }
  });
})()`
  return `<script>${FAST_HTML_TO_IMAGE}</script><script>${handler}</script>`
}

// Added to the wrapper's script (designFrameHtml), where `frame`, `token` and `holdUntil`
// are in scope. Only the app may ask for a photo, and only the design's reply is passed
// on. A large page can block its own heartbeat while it is photographed, so the wrapper
// holds off restoring it until the reply or the library's time limit.
export const DESIGN_CAPTURE_RELAY = `addEventListener('message',event=>{
  const data=event.data;
  if(event.source===parent&&event.origin===location.origin&&data?.type===${JSON.stringify(CAPTURE_REQUEST)}&&typeof data.cid==='string'){
    holdUntil=Date.now()+${CAPTURE_LIBRARY_MS};
    frame.contentWindow?.postMessage({type:'capture',cid:data.cid,full:data.full===true},'*');
  }else if(event.source===frame.contentWindow&&data?.token===token&&data.type==='captured'&&typeof data.cid==='string'){
    holdUntil=0;
    const blobs=Array.isArray(data.blobs)?data.blobs.filter(blob=>blob instanceof Blob):[];
    const error=typeof data.error==='string'?data.error:undefined;
    parent.postMessage({type:${JSON.stringify(CAPTURE_REPLY)},cid:data.cid,blobs,error,width:data.width,height:data.height,truncated:data.truncated===true,timing:data.timing},location.origin);
  }
});
`
