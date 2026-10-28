import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

// Vercel bundles routes with the same function configuration into one function. The
// typing warm-up only helps if it runs on the instances that serve the prompt, so both
// routes must declare the same maxDuration.
const maxDuration = async route => {
  const source = await readFile(new URL(`../app/api/${route}/route.ts`, import.meta.url), 'utf8')
  const match = source.match(/^export const maxDuration = (\d+)$/m)
  assert.ok(match, `${route} declares maxDuration`)
  return Number(match[1])
}

test('the typing warm-up shares the prompt route\'s function configuration', async () => {
  assert.equal(await maxDuration('warm'), await maxDuration('prompt'))
})
