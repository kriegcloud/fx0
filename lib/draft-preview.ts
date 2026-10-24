const DRAFT_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; base-uri 'none'; form-action 'none'"
export const EMPTY_DRAFT_DOCUMENT = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${DRAFT_CSP}"><meta name="color-scheme" content="light dark"></head><body></body></html>`

// A template parses inertly but drops html/body wrappers. Capture their opening
// attributes separately, respecting quoted '>' and skipping raw script/style text.
function rootAttributes(html: string): Map<string, string> {
  const roots = new Map<string, string>()
  const lower = html.toLowerCase()
  const tags = /<!--[\s\S]*?(?:-->|$)|<([a-z][a-z0-9:-]*)\b/gi
  for (let match; (match = tags.exec(html));) {
    if (!match[1]) continue
    let end = tags.lastIndex
    let quote = ''
    for (; end < html.length; end++) {
      const char = html[end]
      if (quote) { if (char === quote) quote = '' }
      else if (char === '"' || char === "'") quote = char
      else if (char === '>') break
    }
    if (end === html.length) break
    const name = match[1].toLowerCase()
    if ((name === 'html' || name === 'body') && !roots.has(name)) roots.set(name, html.slice(tags.lastIndex, end))
    if (name === 'script' || name === 'style') {
      const closing = lower.indexOf(`</${name}`, end + 1)
      tags.lastIndex = closing < 0 ? html.length : closing
    } else tags.lastIndex = end + 1
  }
  return roots
}

// A remote image has no network in the draft; it shows this soft 16:9 block until the
// published design embeds the real one, never the browser's broken-image icon.
const DRAFT_IMAGE_PLACEHOLDER = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="100%" height="100%" fill="#808080" fill-opacity="0.15"/></svg>')}`

function clean(element: Element) {
  const image = element.localName === 'img'
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase()
    const value = attribute.value.trim()
    if (name.startsWith('on') || name === 'target' || name === 'srcdoc' || name === 'srcset' ||
      (['src', 'poster', 'background'].includes(name) && !/^data:/i.test(value)) ||
      ((name === 'href' || name === 'xlink:href') && !value.startsWith('#') && !(element.localName === 'image' && /^data:image\//i.test(value)))) {
      element.removeAttribute(attribute.name)
    }
  }
  if (image && !element.hasAttribute('src')) element.setAttribute('src', DRAFT_IMAGE_PLACEHOLDER)
}

/** Model markup cannot execute scripts or fetch resources while being cleaned. */
export function draftDocument(html: string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  for (const node of template.content.querySelectorAll('meta,base,script,noscript,iframe,frame,object,embed,form,animate,set,animateMotion,animateTransform')) node.remove()
  for (const node of template.content.querySelectorAll('*')) clean(node)
  const roots = rootAttributes(html)
  const attributes = (name: string) => {
    const wrapper = document.createElement('template')
    wrapper.innerHTML = `<div ${roots.get(name) ?? ''}></div>`
    const element = wrapper.content.firstElementChild!
    clean(element)
    return [...element.attributes].map(attribute => ` ${attribute.name}="${attribute.value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}"`).join('')
  }
  return `<!doctype html><html${attributes('html')}><head><meta http-equiv="Content-Security-Policy" content="${DRAFT_CSP}"><meta name="color-scheme" content="light dark"></head><body${attributes('body')}>${template.innerHTML}</body></html>`
}

function sameNode(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false
  if (a.nodeType !== 1) return true
  const left = a as Element, right = b as Element
  return left.namespaceURI === right.namespaceURI && left.localName === right.localName && left.id === right.id
}

function patchNode(target: Node, source: Node) {
  if (target.nodeType !== 1) {
    if (target.nodeValue !== source.nodeValue) target.nodeValue = source.nodeValue
    return
  }
  const element = target as Element, next = source as Element
  for (const attr of [...element.attributes]) {
    if (!next.hasAttributeNS(attr.namespaceURI, attr.localName)) element.removeAttributeNS(attr.namespaceURI, attr.localName)
  }
  for (const attr of [...next.attributes]) {
    if (element.getAttributeNS(attr.namespaceURI, attr.localName) !== attr.value) {
      element.setAttributeNS(attr.namespaceURI, attr.name, attr.value)
    }
  }
  const keyed = new Map([...element.children].filter(child => child.id).map(child => [child.id, child]))
  let current = target.firstChild
  for (const desired of [...source.childNodes]) {
    if (!current || !sameNode(current, desired)) {
      const match = desired.nodeType === 1 ? keyed.get((desired as Element).id) : undefined
      if (match?.parentNode === target && sameNode(match, desired)) {
        target.insertBefore(match, current)
        current = match
      } else {
        target.insertBefore(target.ownerDocument!.importNode(desired, true), current)
        continue
      }
    }
    patchNode(current, desired)
    current = current.nextSibling
  }
  while (current) {
    const removed = current
    current = current.nextSibling
    target.removeChild(removed)
  }
}

// Only sanitized, scriptless markup enters the existing sandboxed document.
// Unchanged elements, styles, scroll position and the browsing context survive.
export function patchDraftDocument(target: Document, html: string): void {
  const source = new DOMParser().parseFromString(draftDocument(html), 'text/html')
  patchNode(target.documentElement, source.documentElement)
}
