import type { SessionData } from './secure-session'
// @ts-expect-error Node strip-types tests require the source extension.
import { KIMI_MODEL_LIMITS } from './local-model-limits.ts'

// Single-user workstation mode is deliberately opt-in and cannot run on Vercel.
export function localMode(): boolean {
  if (process.env.FX0_LOCAL !== '1') return false
  const url = new URL(process.env.APP_URL || 'http://127.0.0.1:3000')
  if (process.env.VERCEL || url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('FX0_LOCAL requires a loopback HTTP APP_URL outside Vercel')
  }
  return true
}

export function assertLocalRequest(request: Request): void {
  const origin = new URL(process.env.APP_URL!).origin
  const requestUrl = new URL(request.url)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(requestUrl.hostname) || requestUrl.port !== new URL(origin).port ||
      (request.headers.get('host') !== null && request.headers.get('host') !== new URL(origin).host) ||
      (request.headers.get('origin') !== null && request.headers.get('origin') !== origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new Error('Local requests must come from the workstation app origin')
  }
}

// This identity grants local ownership only. It is never a provider credential.
export function localSession(): SessionData {
  return {
    userId: 'local:workstation', name: 'Workstation', email: 'local@localhost',
    loginId: '00000000000000000000000000000001', loginAt: 1,
    accessToken: 'local-ownership-only', expiresAt: Date.now() + 24 * 3600_000,
    teamId: 'team_local', teamSlug: 'CLIProxyAPI subscriptions', isLoggedIn: true,
  }
}

export function proxyBaseUrl(): string {
  const url = new URL(process.env.FX0_PROXY_BASE_URL || 'http://127.0.0.1:8317/v1')
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error('FX0_PROXY_BASE_URL must be a loopback HTTP URL without credentials')
  }
  return url.href.replace(/\/$/, '')
}

export function proxyOptions() {
  return {
    provider: {
      name: 'cliproxy', baseUrl: proxyBaseUrl(),
      // Custom providers need explicit vision metadata: libfx cannot infer it
      // from the proxy's OpenAI model list. Include both Opus 5.5 ID spellings.
      models: {
        ...KIMI_MODEL_LIMITS,
        'claude-opus-5-5': { supportsVision: true },
        'claude-opus-5.5': { supportsVision: true },
      },
    },
    credentials: async () => ({ apiKey: process.env.FX0_PROXY_API_KEY || '' }),
  }
}
