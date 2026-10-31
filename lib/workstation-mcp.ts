import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { FxHostTool, FxToolContext } from 'libfx'
import type { ToolHost } from './tools'
// @ts-expect-error Node strip-types tests require the source extension.
import { workstationEnabled, commandEnvironment } from './workstation-tools.ts'

interface ServerConfig {
  command?: string; args?: string[]; cwd?: string; env?: Record<string, string>; env_vars?: string[];
  url?: string; type?: string; headers?: Record<string, string>; http_headers?: Record<string, string>;
  env_http_headers?: Record<string, string>; bearer_token_env_var?: string; enabled?: boolean;
  enabled_tools?: string[]; disabled_tools?: string[];
}
type Configured = { config: ServerConfig; source: string }

// Read only tool configuration. OAuth stores, browser cookies and CLI sign-in
// databases are not imported. Secrets never appear in discovery responses.
async function configured(): Promise<Map<string, Configured>> {
  const home = homedir(); const root = process.env.FX0_WORKING_DIRECTORY || process.cwd()
  const files = process.env.FX0_MCP_CONFIG ? [process.env.FX0_MCP_CONFIG] : [
    path.join(home, '.claude.json'), path.join(home, '.codex/config.toml'), path.join(root, '.mcp.json'),
  ]
  const servers = new Map<string, Configured>()
  for (const file of files) {
    let source
    try { source = await readFile(file, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !process.env.FX0_MCP_CONFIG) continue; throw new Error('Unable to read MCP configuration') }
    let data
    try { data = file.endsWith('.toml') ? parseToml(source) : JSON.parse(source) }
    catch { throw new Error('Unable to parse MCP configuration; source text is withheld because it may contain credentials') }
    const candidates = { ...(data.mcpServers ?? data.mcp_servers ?? {}), ...(data.projects?.[root]?.mcpServers ?? {}) }
    for (const [name, config] of Object.entries(candidates)) {
      if (config && typeof config === 'object') servers.set(name, { config: config as ServerConfig, source: path.basename(file) })
    }
  }
  return servers
}
const pools = new Map<string, { client: Client; timer: ReturnType<typeof setTimeout> }>()
export async function closeWorkstationMcp(): Promise<void> {
  const entries = [...pools.values()]; pools.clear()
  for (const entry of entries) { clearTimeout(entry.timer); await entry.client.close().catch(() => {}) }
}
function expand(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, key) => {
    if (!process.env[key]) throw new Error('An MCP environment credential is unavailable to the fx0 service')
    return process.env[key]!
  })
}
async function connection(name: string, ctx: FxToolContext) {
  const item = (await configured()).get(name)
  if (!item || item.config.enabled === false) throw new Error('MCP server is unknown or disabled')
  const config = item.config
  const key = `${ctx.sessionId}:${name}:${createHash('sha256').update(JSON.stringify(config)).digest('hex')}`
  const cached = pools.get(key)
  if (cached) { cached.timer.refresh(); return { client: cached.client, config } }
  const headers = Object.fromEntries(Object.entries(config.http_headers ?? config.headers ?? {}).map(([key, value]) => [key, expand(value)]))
  for (const [header, variable] of Object.entries(config.env_http_headers ?? {})) {
    if (!process.env[variable]) throw new Error('An MCP header credential is unavailable to the fx0 service')
    headers[header] = process.env[variable]!
  }
  if (config.bearer_token_env_var) {
    const token = process.env[config.bearer_token_env_var]
    if (!token) throw new Error('An MCP bearer credential is unavailable to the fx0 service')
    headers.authorization = `Bearer ${token}`
  }
  const client = new Client({ name: 'fx0-workstation', version: '1.0.0' })
  const env = Object.fromEntries(Object.entries(commandEnvironment()).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  for (const variable of config.env_vars ?? []) if (process.env[variable]) env[variable] = process.env[variable]!
  for (const [variable, value] of Object.entries(config.env ?? {})) env[variable] = expand(value)
  let transport
  if (config.command) transport = new StdioClientTransport({ command: config.command, args: config.args?.map(expand), env, cwd: config.cwd || process.env.FX0_WORKING_DIRECTORY || process.cwd(), stderr: 'ignore' })
  else if (config.url) {
    const url = new URL(expand(config.url))
    transport = config.type === 'sse'
      ? new SSEClientTransport(url, { requestInit: { headers }, eventSourceInit: { fetch: (input, init) => fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), ...headers } }) } })
      : new StreamableHTTPClientTransport(url, { requestInit: { headers } })
  } else throw new Error('MCP server has no supported transport')
  try { await client.connect(transport, { signal: ctx.signal, timeout: 15000 }) }
  catch { await client.close().catch(() => {}); throw new Error(`MCP server ${name} could not connect with its configured authentication. No new login or credential copying was attempted.`) }
  const timer = setTimeout(() => { pools.delete(key); void client.close().catch(() => {}) }, 10 * 60_000)
  timer.unref(); pools.set(key, { client, timer })
  return { client, config }
}
function allowed(config: ServerConfig, name: string): boolean {
  return (!config.enabled_tools || config.enabled_tools.includes(name)) && !config.disabled_tools?.includes(name)
}
function scrub(value: unknown, config: ServerConfig): string {
  let result = JSON.stringify(value)
  const values = [...Object.values(config.env ?? {}), ...Object.values(config.http_headers ?? config.headers ?? {}),
    ...Object.values(config.env_http_headers ?? {}).map(key => process.env[key] || ''),
    ...(config.bearer_token_env_var ? [process.env[config.bearer_token_env_var] || ''] : [])]
  for (const value of values) if (value.length > 3) result = result.replaceAll(expand(value), '[redacted]')
  return result
}
const string = { type: 'string' as const }
const schema = (properties: Record<string, object>, required: string[] = []) => ({ type: 'object' as const, properties, required, additionalProperties: false })

export function workstationMcpTools(host: ToolHost): FxHostTool[] {
  if (!workstationEnabled()) return []
  const tools: FxHostTool[] = [
    { name: 'list_mcp_servers', description: 'Discover existing enabled MCP connections from workstation Codex/Claude configuration and project .mcp.json. Returns names and transport only, never credentials. Connections open on demand; CLI-specific OAuth sessions may require separate supported authentication.',
      inputSchema: schema({}), idempotent: true,
      execute: async () => ({ servers: [...await configured()].map(([name, { config, source }]) => ({ name, source, enabled: config.enabled !== false, transport: config.command ? 'stdio' : config.type === 'sse' ? 'sse' : 'http' })) }) },
    { name: 'list_mcp_tools', description: 'Discover tools and their input schemas on a configured MCP server. Supports keyword filtering and pagination. Use the returned exact tool name and schema with call_mcp_tool.',
      inputSchema: schema({ server: string, query: string, cursor: string }, ['server']), idempotent: true,
      async execute(input: { server: string; query?: string; cursor?: string }, ctx) {
        const { client, config } = await connection(input.server, ctx)
        const result = await client.listTools({ cursor: input.cursor }, { signal: ctx.signal, timeout: 20000 })
        return JSON.parse(scrub({ tools: result.tools.filter(tool => allowed(config, tool.name) && (!input.query || `${tool.name} ${tool.description}`.toLowerCase().includes(input.query.toLowerCase()))), nextCursor: result.nextCursor }, config))
      } },
    { name: 'call_mcp_tool', description: 'Call a discovered MCP tool using its exact schema. Remote side effects require the user task to authorize them. Calls are never automatically replayed. Authentication remains server-side; cancellation is forwarded.',
      inputSchema: schema({ server: string, tool: string, arguments: { type: 'object', additionalProperties: true } }, ['server', 'tool', 'arguments']), idempotent: false, writes: true,
      async execute(input: { server: string; tool: string; arguments: Record<string, unknown> }, ctx) {
        const { client, config } = await connection(input.server, ctx)
        if (!allowed(config, input.tool)) throw new Error('This MCP tool is disabled in the existing configuration')
        const result = await client.callTool({ name: input.tool, arguments: input.arguments }, undefined, { signal: ctx.signal, timeout: 180000 })
        const content = Array.isArray(result.content) ? result.content : []
        const images = content.filter(item => item.type === 'image' && typeof item.mimeType === 'string' && typeof item.data === 'string')
          .slice(0, 8).map(item => ({ type: 'image' as const, mimeType: String(item.mimeType), data: String(item.data) }))
        const summary = { ...result, content: content.map(item => item.type === 'image' ? { type: 'image', mimeType: item.mimeType, note: 'Image delivered separately' } : item) }
        // Keep tool errors as errors in libfx rather than reporting success.
        return { type: 'libfx.tool-result', text: scrub(summary, config), images, isError: result.isError === true }
      } },
    { name: 'mcp_resources', description: 'List or read resources from an existing MCP server. Omit uri to list, or supply an exact resource URI returned by that server. Supports list pagination.',
      inputSchema: schema({ server: string, uri: string, cursor: string }, ['server']), idempotent: true,
      async execute(input: { server: string; uri?: string; cursor?: string }, ctx) {
        const { client, config } = await connection(input.server, ctx)
        return JSON.parse(scrub(input.uri ? await client.readResource({ uri: input.uri }, { signal: ctx.signal, timeout: 30000 }) : await client.listResources({ cursor: input.cursor }, { signal: ctx.signal, timeout: 20000 }), config))
      } },
  ]
  return tools.map(tool => ({ ...tool, writes: tool.writes ?? false, async execute(input, ctx) {
    if (!workstationEnabled()) throw new Error('MCP tools are available only in explicitly enabled local workstation mode')
    ctx.signal.throwIfAborted(); const id = host.reportInvocation(tool.name)
    let result
    try { result = await tool.execute(input, ctx) }
    catch { ctx.signal.throwIfAborted(); throw new Error('MCP request failed or authentication is unavailable. Check the selected server and its existing configuration; secret diagnostics are withheld.') }
    const full = result && typeof result === 'object' && 'type' in result && 'text' in result ? String(result.text) : JSON.stringify(result)
    host.storeResult(id, full)
    if (full.length <= 32000) return result
    const paged = JSON.stringify({ call_id: id, output: full.slice(0, 32000), truncated: true, note: 'Page the rest with read_tool_result' })
    return result && typeof result === 'object' && 'type' in result && result.type === 'libfx.tool-result'
      ? { ...result, text: paged } : JSON.parse(paged)
  } }))
}
