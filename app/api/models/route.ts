import { localMode, proxyBaseUrl } from '../../../lib/local-mode'
import { connection } from 'next/server.js'
import { featuredModels } from '../../../lib/featured-models'
import { DEFAULT_MODEL } from '../../../lib/session'

export const maxDuration = 60

export interface ModelCatalog {
  models: string[]
  defaultModel: string
  efforts: Record<string, string[]>
  fast: string[]
  // What the picker opens on, after the selected model.
  featured: string[]
}

// libfx's own catalog (/coding-agent/v1/models), as on main: /v1/models also lists
// image models libfx cannot run. It is public and rejects user OAuth tokens, so it
// is fetched without credentials and shared by guests and accounts alike. A
// failure here is never an auth failure: it must not flip the UI to signed out.
let cache: { at: number; catalog: Omit<ModelCatalog, 'defaultModel'> } | null = null

// The same for everyone, so the CDN serves it. This public route skips session
// auth and never sets session cookies. Failures are never cached.
const SHARED = { headers: { 'cache-control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400' } }
const FAILED = { status: 502, headers: { 'cache-control': 'no-store' } }

export async function GET() {
  await connection()
  const defaultModel = process.env.FX0_MODEL ?? DEFAULT_MODEL
  if (cache && Date.now() - cache.at < 5 * 60_000) {
    return Response.json({ ...cache.catalog, defaultModel }, SHARED)
  }
  try {
    const response = await fetch(localMode() ? `${proxyBaseUrl()}/models` : 'https://ai-gateway.vercel.sh/coding-agent/v1/models', {
      ...(localMode() ? { headers: { authorization: `Bearer ${process.env.FX0_PROXY_API_KEY || ''}` } } : {}),
      cache: 'no-store', signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      return Response.json({ error: 'Unable to load model catalog', models: [], defaultModel, efforts: {}, fast: [], featured: [] }, FAILED)
    }
    const payload = await response.json() as {
      data?: { id?: string; type?: string; released?: number; tags?: string[]; reasoning_options?: { type?: string; values?: string[] }[] }[]
    }
    const catalog = { models: [] as string[], efforts: {} as Record<string, string[]>, fast: [] as string[], featured: [] as string[] }
    const entries: { id: string; released?: number }[] = []
    for (const model of payload.data ?? []) {
      if (typeof model.id !== 'string' || (typeof model.type === 'string' && model.type.toLowerCase() !== 'language')) continue
      if (localMode() && (!/^(gpt-|claude-|grok-)/.test(model.id) || /image|video|tts|voice/.test(model.id))) continue
      if (localMode() && model.id.startsWith('gpt-')) catalog.efforts[model.id] = ['low', 'medium', 'high']
      entries.push({ id: model.id, released: typeof model.released === 'number' && Number.isFinite(model.released) ? model.released : undefined })
      const values = model.reasoning_options?.find((option) => option.type === 'effort')?.values
      if (values?.length) catalog.efforts[model.id] = values
      if (model.tags?.includes('fast')) catalog.fast.push(model.id)
    }
    // Search preserves this order among equally relevant matches: newest releases first.
    // Models without release metadata follow dated ones; ties are deterministic.
    catalog.models = [...new Set(entries
      .sort((a, b) => (b.released ?? 0) - (a.released ?? 0) || a.id.localeCompare(b.id))
      .map(({ id }) => id))]
    catalog.fast = [...new Set(catalog.fast)]
    catalog.featured = localMode() ? ['gpt-6.1-sol', 'claude-opus-5-5', 'claude-sonnet-5-5', 'grok-4.7'].filter(id => catalog.models.includes(id)) : featuredModels(entries)
    cache = { at: Date.now(), catalog }
    return Response.json({ ...catalog, defaultModel }, SHARED)
  } catch {
    return Response.json({ error: 'Unable to load model catalog', models: [], defaultModel, efforts: {}, fast: [], featured: [] }, FAILED)
  }
}
