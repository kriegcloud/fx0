// @ts-expect-error Node strip-types tests require the source extension.
import { referenceTools } from './reference-tools.ts'
import type { FxHostTool } from 'libfx'
// @ts-expect-error Node strip-types tests require the source extension.
import { fetchPublicText } from './public-fetch.ts'

const MAX_TOOL_OUTPUT = 32 * 1024

export interface ToolHost {
  /** Copies a validated local image into this chat and returns its immutable asset reference. */
  importReferenceImage(image: import('./prompt-images').PromptImage): Promise<string>
  /** Registers an invocation; returns its call id for result paging. */
  reportInvocation(name: string): number
  storeResult(callId: number, text: string): void
  readResult(callId: number): string | undefined
  askUser(questions: AskQuestion[], signal: AbortSignal): Promise<Record<string, string>>
  log(event: string, detail?: Record<string, unknown>): void
  spawnSubagent(task: string, signal: AbortSignal): Promise<string>
  capabilitySearch(query: string): { name: string; kind: string; description: string }[]
  readDesign(): Promise<{ html: string | null; artifactRevision: number }>
  publishDesign(
    html: string,
  ): Promise<{ ok: true; revision: number; changed: boolean } | { ok: false; reason: string; error: string }>
  editDesign(
    edits: { oldString: string; newString: string }[],
  ): Promise<{ ok: true; revision: number; changed: boolean } | { ok: false; reason: string; error: string }>
}

export interface AskQuestion {
  question: string
  options: { label: string; description?: string }[]
}

export function tail(text: string | undefined | null, max = MAX_TOOL_OUTPUT): string {
  if (!text) return ''
  if (text.length <= max) return text
  return (
    text.slice(0, 1024) +
    `\n… [${text.length - max} bytes truncated — full output paged via read_tool_result] …\n` +
    text.slice(-max)
  )
}

/** HTML work tools plus the common research and coordination tools. */
export function createTools(host: ToolHost, opts: { allowSubagent?: boolean } = {}): FxHostTool[] {
  const { allowSubagent = true } = opts

  const readDesign: FxHostTool = {
    name: 'read_design',
    description:
      'Read the authoritative design HTML for this session. Returns null before the first publish; large documents are truncated and can be paged with read_tool_result.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      const callId = host.reportInvocation('read_design')
      const result = await host.readDesign()
      const stored = JSON.stringify(result)
      host.storeResult(callId, stored)
      if (result.html == null || result.html.length <= MAX_TOOL_OUTPUT) return result
      return {
        artifactRevision: result.artifactRevision,
        html: tail(result.html),
        callId,
        truncated: true,
      }
    },
  }

  const publishDesign: FxHostTool = {
    name: 'publish_design',
    description:
      'Publish one complete self-contained HTML document as the authoritative design. Inline CSS and JavaScript, Canvas, animation, event handlers, and user-click popout windows are supported inside the secure preview iframe. For popouts, call await beep.openPopout(html, {title: "Panel", width: 900, height: 650}) directly in a click handler and catch popup-blocking errors. Pass inline self-contained HTML; the returned handle has focus() and close(). Use this helper because native window.open is blocked by the credentialless preview. Use once for the first design or for a broad rewrite; keep normal drafts under 12 KiB. It must include doctype, html, head, and body; keep scripts inline; use only accepted data: assets, local fragments, or <a href="https://..."> links (they open in a new tab); and do not add HTML comments, external assets, forms, navigation of the preview or parent page, or nested frames. Self-contained beep.openPopout windows are allowed. Use edit_design instead for localized follow-ups.',
    inputSchema: {
      type: 'object',
      properties: {
        html: { type: 'string', description: 'The complete self-contained HTML document.' },
      },
      required: ['html'],
      additionalProperties: false,
    },
    async execute(input: { html: string }) {
      host.reportInvocation('publish_design')
      return host.publishDesign(input.html)
    },
  }

  const editDesign: FxHostTool = {
    name: 'edit_design',
    description:
      'Apply one or more exact replacements to the current design in a single call, without republishing the whole document. Put every change a request needs into one call: they apply in order and publish once, atomically, as one version. Each old_string must match exactly once in the document as it stands after the edits before it.',
    inputSchema: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          description: 'Replacements, applied in order.',
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string', description: 'Exact current HTML, CSS, or JavaScript text to replace once.' },
              new_string: { type: 'string', description: 'Replacement text.' },
            },
            required: ['old_string', 'new_string'],
            additionalProperties: false,
          },
        },
      },
      required: ['edits'],
      additionalProperties: false,
    },
    async execute(input: { edits: { old_string: string; new_string: string }[] }) {
      host.reportInvocation('edit_design')
      const edits = Array.isArray(input?.edits) ? input.edits : []
      return host.editDesign(edits.map((edit) => ({ oldString: edit.old_string, newString: edit.new_string })))
    },
  }

  const webFetch: FxHostTool = {
    name: 'web_fetch',
    description:
      'Fetch a public http(s) URL and return its text content (scripts/styles stripped, truncated). Use for reading docs and pages.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Public http(s) URL to fetch.' } },
      required: ['url'],
      additionalProperties: false,
    },
    async execute(input: { url: string }, { signal }) {
      const callId = host.reportInvocation('web_fetch')
      if (!/^https?:\/\//.test(input.url)) return { error: 'only http(s) URLs are supported' }
      const t0 = Date.now()
      host.log('tool:web_fetch:start', { url: input.url.slice(0, 160) })
      try {
        // One 20s budget covers DNS, every redirect and the body, so a slow server
        // can't trickle-hang the turn.
        const { status, url, raw } = await fetchPublicText(input.url,
          AbortSignal.any([signal, AbortSignal.timeout(20_000)]))
        const text = raw
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
        host.log('tool:web_fetch:done', { ms: Date.now() - t0, status, bytes: raw.length })
        const result = { status, url, content: tail(text, 100 * 1024) }
        host.storeResult(callId, JSON.stringify(result))
        return result
      } catch (error) {
        host.log('tool:web_fetch:error', { ms: Date.now() - t0, error: 'public page fetch failed' })
        return { error: 'public page fetch failed' }
      }
    },
  }

  const askUser: FxHostTool = {
    name: 'ask_user_question',
    description:
      'Ask the user 1-4 multiple-choice questions when a concrete decision blocks progress. Each question needs 2-6 options. Do not use for facts you can inspect yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' },
                  },
                  required: ['label'],
                },
              },
            },
            required: ['question', 'options'],
          },
        },
      },
      required: ['questions'],
      additionalProperties: false,
    },
    async execute(input: { questions: AskQuestion[] }, { signal }) {
      host.reportInvocation('ask_user_question')
      const answers = await host.askUser(input.questions, signal)
      return { answers }
    },
  }

  const readToolResult: FxHostTool = {
    name: 'read_tool_result',
    description:
      'Page through the full stored output of a previous tool call by its call id (shown in the call log). Use when output was truncated.',
    inputSchema: {
      type: 'object',
      properties: {
        call_id: { type: 'number', description: 'The call id from the invocation log.' },
        offset: { type: 'number', description: 'Byte offset to start from. Defaults to 0.' },
        limit: { type: 'number', description: 'Max bytes to return. Defaults to 8192.' },
      },
      required: ['call_id'],
      additionalProperties: false,
    },
    async execute(input: { call_id: number; offset?: number; limit?: number }) {
      host.reportInvocation('read_tool_result')
      const stored = host.readResult(input.call_id)
      if (stored === undefined) return { error: `no stored result for call ${input.call_id}` }
      const offset = Math.max(0, input.offset ?? 0)
      const limit = Math.min(Math.max(input.limit ?? 8192, 256), 64 * 1024)
      return {
        call_id: input.call_id,
        total_bytes: stored.length,
        offset,
        content: stored.slice(offset, offset + limit),
        truncated: offset + limit < stored.length,
      }
    },
  }

  const capabilitySearch: FxHostTool = {
    name: 'capability_search',
    description:
      'Search the tools available on this host by keyword. Use before claiming a capability is missing.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
    async execute(input: { query: string }) {
      host.reportInvocation('capability_search')
      return { matches: host.capabilitySearch(input.query) }
    },
  }

  const tools: FxHostTool[] = [readDesign, publishDesign, editDesign, webFetch, askUser, readToolResult, capabilitySearch, ...referenceTools(host)]

  if (allowSubagent) {
    tools.push({
      name: 'subagent',
      description: 'Delegate a focused design or research subtask to a nested agent with the same design and configured read-only reference tools. No shell or filesystem writes.',
      inputSchema: {
        type: 'object',
        properties: { task: { type: 'string', description: 'Complete instructions for the subagent.' } },
        required: ['task'],
        additionalProperties: false,
      },
      async execute(input: { task: string }, { signal }) {
        const callId = host.reportInvocation('subagent')
        const result = await host.spawnSubagent(input.task, signal)
        host.storeResult(callId, result)
        return { result: tail(result) }
      },
    })
  }

  return tools
}
