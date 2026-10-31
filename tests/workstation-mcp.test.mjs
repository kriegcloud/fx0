import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { workstationMcpTools, closeWorkstationMcp } from '../lib/workstation-mcp.ts'

test('real stdio MCP discovery and calls preserve server-only auth, restrictions and tool errors', async (t) => {
  const previous = { ...process.env }
  const dir = await mkdtemp(path.join(tmpdir(), 'fx0-mcp-'))
  t.after(async () => { await closeWorkstationMcp(); process.env = previous; await rm(dir, { recursive: true, force: true }) })
  const server = path.join(dir, 'server.mjs')
  const sdk = path.resolve('node_modules/@modelcontextprotocol/sdk/dist/esm')
  await writeFile(server, `
import {Server} from ${JSON.stringify('file://' + sdk + '/server/index.js')};
import {StdioServerTransport} from ${JSON.stringify('file://' + sdk + '/server/stdio.js')};
import {ListToolsRequestSchema,CallToolRequestSchema} from ${JSON.stringify('file://' + sdk + '/types.js')};
const server=new Server({name:'fixture',version:'1.0'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'echo',description:'Echo fixture',inputSchema:{type:'object',properties:{text:{type:'string'}}}},{name:'disabled',description:'Disabled fixture',inputSchema:{type:'object'}}]}));
server.setRequestHandler(CallToolRequestSchema,async(request)=>({isError:request.params.arguments?.text==='fail',content:[{type:'text',text:JSON.stringify({text:request.params.arguments?.text,credential:process.env.FIXTURE_TOKEN})}]}));
await server.connect(new StdioServerTransport());
`)
  const config = path.join(dir, 'mcp.json')
  await writeFile(config, JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [server], env: { FIXTURE_TOKEN: 'synthetic-mcp-private-token' }, disabled_tools: ['disabled'] } } }))
  Object.assign(process.env, { FX0_LOCAL: '1', APP_URL: 'http://127.0.0.1:3000', FX0_WORKSTATION_TOOLS: '1', FX0_MCP_CONFIG: config })
  delete process.env.VERCEL
  const stored = []; const host = { reportInvocation: () => 1, storeResult: (_id, value) => stored.push(value) }
  const ctx = { sessionId: 'fixture-session', executionId: 'fixture-call', signal: AbortSignal.timeout(15000) }
  const tools = workstationMcpTools(host)
  const call = (name, input) => tools.find(tool => tool.name === name).execute(input, ctx)
  assert.deepEqual((await call('list_mcp_servers', {})).servers, [{ name: 'fixture', source: 'mcp.json', enabled: true, transport: 'stdio' }])
  const list = await call('list_mcp_tools', { server: 'fixture' })
  assert.deepEqual(list.tools.map(tool => tool.name), ['echo'])
  const result = await call('call_mcp_tool', { server: 'fixture', tool: 'echo', arguments: { text: 'synthetic OK' } })
  assert.equal(result.isError, false); assert.match(result.text, /synthetic OK/)
  assert.ok(!result.text.includes('synthetic-mcp-private-token'))
  const failure = await call('call_mcp_tool', { server: 'fixture', tool: 'echo', arguments: { text: 'fail' } })
  assert.equal(failure.isError, true)
  await assert.rejects(call('call_mcp_tool', { server: 'fixture', tool: 'disabled', arguments: {} }), /MCP request failed/)
  assert.ok(stored.every(value => !value.includes('synthetic-mcp-private-token')))
  process.env.FX0_LOCAL = '0'
  assert.deepEqual(workstationMcpTools(host), [])
})
