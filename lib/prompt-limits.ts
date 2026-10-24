// One prompt's text, checked in the composer and again by /api/prompt. With the
// 3 MiB of images, their previews and a DESIGN.md, a full prompt still fits in
// one function request body (4.5 MB) and far inside libfx's 8 MiB durable input.
export const PROMPT_TEXT_MAX_BYTES = 256 * 1024

export const PROMPT_TEXT_LIMIT_ERROR = 'prompt text must be 256 KB or smaller.'

export function promptTextBytes(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

// A prompt's images, checked in the composer and again by /api/prompt. Their base64
// stays within 3 MiB so the whole prompt fits one function request body.
export const PROMPT_IMAGE_MAX_COUNT = 8
export const PROMPT_IMAGES_MAX_BASE64 = 3 * 1024 * 1024
export const PROMPT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
