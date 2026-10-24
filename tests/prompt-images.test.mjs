import assert from 'node:assert/strict'
import test from 'node:test'
import { imageDimensions } from '../lib/image-sniff.ts'
import { validatePromptImages, validatePromptPreviews } from '../lib/prompt-images.ts'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const u16 = (n) => [n >> 8, n & 255]
const jpeg = (frame, width, height) => Buffer.from([0xff, 0xd8,
  0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
  0xff, frame, 0, 17, 8, ...u16(height), ...u16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9])
const riff = (chunk, body) => {
  const payload = Buffer.concat([Buffer.from(chunk), Buffer.from([body.length, 0, 0, 0]), Buffer.from(body)])
  return Buffer.concat([Buffer.from('RIFF'), Buffer.from([payload.length + 4, 0, 0, 0]), Buffer.from('WEBP'), payload])
}
const webpLossy = (width, height) => riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, width & 255, width >> 8, height & 255, height >> 8])
const webpLossless = (width, height) => {
  const w = width - 1, h = height - 1
  return riff('VP8L', [0x2f, w & 255, ((w >> 8) & 0x3f) | ((h & 3) << 6), (h >> 2) & 255, (h >> 10) & 0x0f])
}
const webpExtended = (width, height) => {
  const w = width - 1, h = height - 1
  return riff('VP8X', [0, 0, 0, 0, w & 255, (w >> 8) & 255, w >> 16, h & 255, (h >> 8) & 255, h >> 16])
}
const image = (bytes, mimeType) => ({ type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType })

test('dimensions come from every supported header, including progressive JPEG and each WebP layout', () => {
  assert.deepEqual(imageDimensions(PNG, 'image/png'), { width: 1, height: 1 })
  assert.deepEqual(imageDimensions(GIF, 'image/gif'), { width: 1, height: 1 })
  assert.deepEqual(imageDimensions(jpeg(0xc0, 640, 480), 'image/jpeg'), { width: 640, height: 480 })
  assert.deepEqual(imageDimensions(jpeg(0xc2, 1920, 1080), 'image/jpeg'), { width: 1920, height: 1080 })
  assert.deepEqual(imageDimensions(webpLossy(800, 600), 'image/webp'), { width: 800, height: 600 })
  assert.deepEqual(imageDimensions(webpLossless(2048, 1365), 'image/webp'), { width: 2048, height: 1365 })
  assert.deepEqual(imageDimensions(webpExtended(4000, 3000), 'image/webp'), { width: 4000, height: 3000 })
  assert.equal(imageDimensions(jpeg(0xc0, 640, 480).subarray(0, 24), 'image/jpeg'), null, 'truncated before the frame')
  assert.equal(imageDimensions(PNG.subarray(0, 20), 'image/png'), null)
})

test('valid images pass unchanged', () => {
  const images = [image(PNG, 'image/png'), image(GIF, 'image/gif'), image(jpeg(0xc2, 1920, 1080), 'image/jpeg'), image(webpLossless(2048, 1365), 'image/webp')]
  assert.deepEqual(validatePromptImages(images), { images })
  assert.deepEqual(validatePromptImages(undefined), { images: [] })
})

test('anything malformed, mislabeled, oversized or unsupported is refused with the image it is about', () => {
  const refuse = (images, error) => assert.deepEqual(validatePromptImages(images), { error })
  refuse('nope', 'images must be a list')
  refuse([image(PNG, 'image/png'), { type: 'image', data: 1, mimeType: 'image/png' }], 'image 2 is invalid')
  refuse([image(PNG, 'image/svg+xml')], 'image 1 must be PNG, JPEG, GIF or WebP')
  refuse([image(PNG, 'image/heic')], 'image 1 must be PNG, JPEG, GIF or WebP')
  refuse([{ ...image(PNG, 'image/png'), data: PNG.toString('base64').replace(/=+$/, '') }], 'image 1 is not valid base64')
  refuse([{ ...image(PNG, 'image/png'), data: ` ${PNG.toString('base64').slice(1)}` }], 'image 1 is not valid base64')
  // Non-zero padding bits decode to the same bytes but are not the canonical encoding.
  assert.ok(PNG.toString('base64').endsWith('g=='))
  refuse([{ type: 'image', data: PNG.toString('base64').replace(/g==$/, 'h=='), mimeType: 'image/png' }], 'image 1 is not valid base64')
  refuse([image(PNG, 'image/jpeg')], 'image 1 is not the JPEG it claims to be')
  refuse([image(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/png')], 'image 1 is not the PNG it claims to be')
  refuse([image(jpeg(0xc0, 640, 480).subarray(0, 24), 'image/jpeg')], 'image 1 is damaged or truncated')
  refuse([image(webpExtended(9000, 100), 'image/webp')], 'image 1 is larger than 8000 px on a side')
  refuse(Array.from({ length: 9 }, () => image(PNG, 'image/png')), 'prompt cannot contain more than 8 images')
  const big = Buffer.concat([PNG.subarray(0, 24), Buffer.alloc(1.2 * 1024 * 1024)])
  refuse([image(big, 'image/png'), image(big, 'image/png')], 'prompt images exceed the 3 MiB limit')
})

test('thumbnails are kept only when every image has one, so none lands on the wrong image', () => {
  const thumb = `data:image/jpeg;base64,${PNG.toString('base64')}`
  assert.deepEqual(validatePromptPreviews([thumb, thumb], 2), [thumb, thumb])
  assert.deepEqual(validatePromptPreviews([thumb], 2), [])
  assert.deepEqual(validatePromptPreviews([thumb, 'javascript:alert(1)'], 2), [])
  assert.deepEqual(validatePromptPreviews([thumb, `data:image/jpeg;base64,${'A'.repeat(96 * 1024)}`], 2), [])
  assert.deepEqual(validatePromptPreviews('x', 0), [])
})
