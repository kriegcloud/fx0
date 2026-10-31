import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export function randomHandle(): string {
  return randomBytes(32).toString('base64url')
}

export function hashHandle(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

// Short one-way tag that links log lines for one user, login or refresh token.
export function logTag(value: string): string {
  return hashHandle(value).slice(0, 10)
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function equalSecret(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

// Strips anything bearer- or token-shaped from text bound for users or logs.
export function redactSecrets(text: string): string {
  return text.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/[A-Za-z0-9_\-.]{40,}/g, '[redacted]')
}
