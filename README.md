# fx0

fx0 is an open-source, lightweight design agent built with [libfx](https://www.npmjs.com/package/libfx). You describe a page and an agent writes it as one HTML file.

fx0 is also a working example of an app built on libfx. [One `createFxAgent()` call](#durability) gives it the agent loop, streaming, tool calls, retries and durable sessions, and `createFxEngine()` runs each subagent.

Try it at [fx0.vercel.dev](https://fx0.vercel.dev), or clone it and make it your own.

## Run on this workstation with CLIProxyAPI

Install dependencies with `bun install`, then run:

```sh
bun run dev:local
```

To build and run the production server locally with the same CLIProxyAPI and
local data setup, stop the development launcher, then run:

```sh
bun run build
bun run start:local
```

Both launchers use the same `.local/` data and cannot run against it at the same
time. `start:local` serves the compiled build with `next start` on loopback.

### Response limits and large designs

Direct Kimi routes declare their per-model context and output limits to libfx,
using the installed CLIProxyAPI 8.0.47 catalog. K2/K2 Thinking/K2.5 request up to
32,768 output tokens; the remaining listed Kimi routes request up to 65,536.
This makes the outgoing `max_tokens` explicit instead of relying on an upstream
default. Catalog limits do not establish subscription access or guarantee that
every request will fit; reasoning and generated tool arguments consume output.

Large designs should publish a complete initial preview and grow through bounded
`edit_design` calls (about 12 KiB per call), retaining the existing 512 KiB artifact
limit. Truncated responses are shown as failures with a **Continue in smaller
steps** action. It sends a normal continuation in the same conversation; it does
not automatically retry tools or discard the last published preview. Historical
`OutputTruncated` errors also receive the explanation and recovery action.

After `bun run build`, `bun run test:output:browser` tests this flow in headless
Chrome with a synthetic streaming provider, a separate local app process, and
temporary data. It checks preview preservation, recovery after reload, incremental
edits, and the rendered result. Set `CHROME_PATH` if Chrome is not at
`/usr/bin/google-chrome-stable`, or `FX0_TEST_APP_ROOT` to test another built
checkout. This test makes no upstream inference requests.

### KDE desktop app

On this workstation, run `bun run install:desktop` once to add **fx0** to KDE
application search and the desktop. Clicking it builds the current local checkout,
starts the production server, waits for readiness, and opens Chrome in a standalone
app window with a dedicated fx0 browser profile. Search for **fx0**, **Beep**, or
**Kimi**. No browser extension, root access, or remote deployment is needed.

Repeated clicks during a build are coalesced. If a chat is generating, the launcher
opens the current app and skips rebuilding to preserve the turn. A failed build or
server readiness check restores the previous build when available. KDE notifications
show progress and failures. This builds local files; it does not pull or install updates.

The server runs as the on-demand user service `fx0-local.service`, retains `.local/`
chat data, and stays running after the app window closes. It does not start at login.
Stop it with `systemctl --user stop fx0-local.service`. The desktop service uses
the launcher's normal `FX0_REFERENCE_ROOTS` configuration, including `.env.local`
overrides; it does not retain the synthetic validation run's empty-root override.
Its logs are `~/.local/state/fx0/desktop.log` and `server.log`.
The browser profile lives in `~/.local/share/fx0/browser`; CLIProxyAPI credentials
remain server-side. Re-run the installer after moving the checkout or Node runtime.

Open **http://127.0.0.1:3000**. This explicit, single-user local mode uses your
existing CLIProxyAPI subscriptions without Vercel sign-in, Neon, or Upstash.
`redis-server` (Valkey is compatible) must be on PATH. The launcher checks the
proxy before starting the app and binds Next.js and the Redis HTTP adapter to
loopback. Keep using the `127.0.0.1` URL, including its port.

The default proxy is `http://127.0.0.1:8317/v1`. The launcher reads its client
API key from `~/.cli-proxy-api/client-token` in memory; it never prints the key
or puts it into browser code. If that default token file is absent, it uses the
legacy `~/.cli-proxy-api/config.yaml` `api-keys` list. Explicit key, token-file,
and config overrides remain server-only. CLIProxyAPI must already be running and signed
into the subscriptions you want to use. Its existing service and configuration
are managed separately from fx0.

New chats default to **gpt-6.1-sol with medium reasoning**. The picker lists the
proxy's Claude, GPT, Grok, and supported direct Kimi language models and excludes dedicated image, video, and speech
generation models. GPT reasoning choices are sent as OpenAI `reasoning_effort`; libfx's
custom provider does not advertise them itself. Fast mode and Gateway's
provider-executed web search are unavailable in local mode. The agent can still
fetch public pages and publish/edit designs. Other advertised models depend on
your proxy's current account access and quotas.

Search **Kimi** in the model picker, or choose the featured **Kimi K3.1 Pro**.
Image attachments and visual `screenshot_design` results are enabled for K2.5,
K2.6, K2.7 Code (including Highspeed), K2.8/Code, K3/256K, and K3.1 Pro
(including Highspeed), following the installed proxy catalog's image-input
capabilities. K2 and K2 Thinking remain text-only. libfx requires these explicit
vision flags even when the proxy itself accepts images; model discovery alone
does not enable image input. This does not add video uploads to fx0.
The supported direct IDs are `kimi-k2`, `kimi-k2-thinking`, `kimi-k2.5`,
`kimi-k2.6`, `kimi-k2.7-code`, `kimi-k2.7-code-highspeed`, `kimi-k2.8`,
`kimi-k2.8-code`, `kimi-k3`, `kimi-k3-256k`, `kimi-k3.1-pro`, and
`kimi-k3.1-pro-highspeed`. Only IDs present in the live authenticated proxy
catalog appear. These are distinct from `venice/kimi-*` routes; fx0 sends the
entire ID unchanged through libfx's existing OpenAI Chat Completions adapter.
CLIProxyAPI owns OAuth and upstream name translation; no additional login is needed.

Kimi uses the normal streaming agent and design tools. Its current `/v1/models`
entries do not advertise reasoning controls, so fx0 leaves reasoning at the
proxy/model default and does not inject GPT's `reasoning_effort`. Highspeed
entries are separate model choices, not fx0's Gateway fast toggle. fx0 does not
infer vision support, context limits, or identical capabilities from the Kimi
name. Catalog presence alone does not establish subscription access. Live UI checks on 2026-10-29 verified image attachments and preview screenshots
with `kimi-k3` and `kimi-k3.1-pro`; other entries require account-specific
validation before relying on them.

Chat ownership/history use PGlite (local Postgres), and the existing journal runs
against a dedicated Redis/Valkey child through an authenticated local HTTP
adapter. Data, encrypted turn identity records, the session encryption secret,
and libfx sessions live in the gitignored `.local/` directory. Attached images
are stored privately in `.local/assets/` (or under `FX0_LOCAL_DATA_DIR`) and
require no Vercel Blob credentials. Deleting a chat removes its stored images.
Redis uses an append-only log with one-second syncing. Ctrl-C stops this launcher's app and
Redis process; rerunning the command reopens the saved chats.

Optional settings, supplied as environment variables or in `.env.local`:

| Setting | Default |
| --- | --- |
| `FX0_PROXY_BASE_URL` | `http://127.0.0.1:8317/v1` (loopback HTTP only) |
| `FX0_PROXY_TOKEN_FILE` | `~/.cli-proxy-api/client-token`; an explicit file must exist and be nonempty |
| `FX0_PROXY_CONFIG` | `~/.cli-proxy-api/config.yaml` fallback; an explicit config takes precedence over the default token path |
| `FX0_PROXY_API_KEY` | Optional server-only override; otherwise token file, then config |
| `FX0_MODEL` | `gpt-6.1-sol` |
| `FX0_EFFORT` | `medium` |
| `FX0_LOCAL_PORT` | `3000` |
| `FX0_LOCAL_DATA_DIR` | `.local` |
| `FX0_WORKSTATION_TOOLS` | `1` in the local launcher; `0` selects read-only reference mode |
| `FX0_WORKING_DIRECTORY` | This checkout |
| `FX0_MCP_CONFIG` | Existing Codex/Claude and project MCP configuration |
| `FX0_REFERENCE_ROOTS` | Home directory in read-only reference mode |

Local mode is for one trusted workstation user. It rejects foreign request
hosts/origins and cannot be enabled on Vercel. The ordinary `bun run dev` and
hosted deployment continue to use the Vercel setup below.

For a synthetic provider check with local reference-file access disabled, use
`FX0_WORKSTATION_TOOLS=0 FX0_REFERENCE_ROOTS='[]' bun run dev:local`. This changes the reference tools for
that launch only. Select Kimi K3.1 Pro and request a tiny self-contained page
using `publish_design`, then confirm the stream finishes and the preview works.
`bun run test:local` covers catalog filtering, credential loading, and local
boundaries; `bun run test:auth` also covers transport errors and cancellation.

## Workstation agent tools

`dev:local`, `start:local`, and the KDE launcher enable full workstation tools
for the local agent and its subagents. The agent runs with the current OS user's
permissions; the design preview remains a credentialless, isolated iframe.
libfx supplies the agent loop, not the CLI's built-in shell/filesystem tools, so
fx0 registers these host tools explicitly:

- `workstation_context`: working directory, home and skill locations.
- `read_file`, `list_files`, `search_files`: local source, handoffs, skills and
  directory discovery, including hidden files and paths outside reference roots.
- `write_file`, `edit_file`: real file creation and edits; overwrite is explicit
  and exact edits reject missing or ambiguous matches.
- `exec_command`, `write_stdin`: shell commands, git, builds, tests, installed
  CLIs, network clients, process polling/input/termination, and optional real PTYs.
  Commands have a default two-minute timeout, configurable up to one hour.
  Cancelling the turn terminates its running command groups. Process handles are
  scoped to the owning agent session and do not survive a server restart.
- `view_image`: local image inspection and import as an `fx0-asset:` handle.
  Whether the selected model accepts images still depends on provider metadata.
- `list_mcp_servers`, `list_mcp_tools`, `call_mcp_tool`, `mcp_resources`: on-demand
  MCP discovery, tool invocation and resources through existing configuration.

The agent is instructed to inspect applicable `AGENTS.md`/`CLAUDE.md` and requested
skills, preserve unrelated edits, honor the task's scope, and use the workstation's
YubiKey and agent 1Password routes. Shell tools remove application and token/secret
environment variables from child environments; configured MCP credentials are
passed only to their server transports. Tool output is sent to the selected model
and stored in the chat, just as other agent tool results are.

MCP configuration is read server-side from `~/.claude.json`,
`~/.codex/config.toml`, then the working directory's `.mcp.json` (later entries
win on duplicate names). `FX0_MCP_CONFIG` selects one explicit JSON/TOML file
instead. Enabled/disabled tool selections are preserved. Stdio, Streamable HTTP,
and explicitly configured legacy SSE are supported. Existing environment/header
authentication works where available; CLI-private OAuth stores and browser cookies
are not copied. Discovery exposes names and schemas, never configuration secrets.
A listed connection may still be unavailable or require its own authentication.

The default working directory is this checkout; set `FX0_WORKING_DIRECTORY` to
another project if desired. Tools accept absolute paths and `~/`. For example:

> Read the handoff and capability documents at these local paths, then build a
> self-contained prototype with synthetic fixture data. Do not modify the source project.

Set `FX0_WORKSTATION_TOOLS=0` to use the older read-only reference tools instead.
Only in that mode, `FX0_REFERENCE_ROOTS` controls the permitted directories;
`[]` disables those reference tools. By default those roots contain the home
directory, with credential stores and escaping symlinks excluded. Full workstation
mode uses ordinary OS permissions, not that reference-root filter.

Local assets must still be embedded or imported as `fx0-asset:` handles for the
preview; artifact JavaScript cannot read files, run shell commands, or invoke MCP.

## Features

- Sign in with Vercel to bill model calls through [AI Gateway](https://vercel.com/docs/ai-gateway) to your own team.
- Optionally offer five free Opus 5.5 Fast prompts per IP without sign-in or a card. [BotID](https://vercel.com/docs/botid) protects the trial; a server-only Gateway key funds its admitted prompts.
- A chat survives the function dying mid-reply: the turn continues where it stopped. See [Durability](#durability).
- Every turn keeps its version of the design. You can reopen any of them and copy or download the HTML.
- Pick each chat's model, with its reasoning effort and fast mode. New chats start on fast Claude Opus 5.5, or on `FX0_MODEL` when it's set.
- The agent can search the web and fetch pages for reference.
- Ask the agent to inspect its result: `screenshot_design` returns images of the published preview to the model, either the visible viewport or the full page in tiles.
- Start from one of ten `design.md` styles, or upload your own. The ten styles, and the one-line descriptions in the picker, come from VoltAgent's [awesome-design-md](https://github.com/VoltAgent/awesome-design-md), which you can browse at [getdesign.md](https://getdesign.md). Thanks to VoltAgent for publishing them.
- Type a message before you sign in. The draft, images included, waits in the tab for 15 minutes while you sign in.
- A turn stops after 64 model steps, its subagents' included, which keeps an agent stuck in a loop from running up a bill.
- In paid-only chats, a text message sent while the agent works steers it, as in the fx CLI. Trial chats run each input as its own turn so free and paid funding stay separate.

## How fx0 uses libfx

fx0 is the app. libfx is the agent inside it. Vercel keeps the agent's work safe while it runs.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/pieces-dark.svg">
  <img alt="fx0's chat and API routes keep chats in Redis and accounts and history in Neon. The routes hand each message to the libfx agent, which calls AI Gateway, saves every step to Workflow World, and is restarted by Vercel Queues after a crash." src="docs/diagrams/pieces-light.svg" width="720">
</picture>

- **fx0** owns what you see and what's yours: the chat and live preview, sign-in, the design tools the agent calls, and the chat history in Redis and Neon.
- **libfx** runs every turn, meaning one message and everything the agent does to answer it: the model loop, tool calls, retries and steering. fx0 creates one agent with `createFxAgent()` and passes each chat's messages to it.
- **Workflow World**, the store behind Vercel Workflow, is where libfx saves each turn as it runs: the prompt before it's accepted, then every step.
- **Vercel Queues** keeps a backup of each prompt. When the function running a turn crashes or reaches its time limit, the queue wakes a new one at `/api/libfx`, and libfx continues from the last saved step.
- **AI Gateway** receives every model call. Paid turns use the sender's OAuth token and team; explicitly sponsored turns use the server's trial key.

## Durability

fx0 runs one durable libfx agent per server. libfx keeps each chat's conversation as a session and backs every turn with Vercel Queues, so a turn finishes even when the function running it dies. fx0 has no code of its own to recover a turn. Durability takes three pieces.

**The agent.** fx0 passes no durability option, so `createFxAgent()` uses libfx's default: on Vercel, libfx keeps its sessions in Vercel's World, the store behind Vercel Workflow, and uses Vercel Queues. libfx bundles both clients, so fx0 neither writes workflows nor calls Vercel Queues itself. A prompt runs its turn in the request that sent it, so the reply starts without a queue hop, and Vercel Queues keeps the prompt as a backstop until just after that request's 800-second limit. fx0 sends a message as a prompt when the chat is idle. One sent while a turn runs or waits to start is a steer instead, which libfx delivers through Vercel Queues to the running turn.

```ts
// lib/libfx-agent.ts, simplified
const agent = createFxAgent({
  // No durability option: Vercel's World and Queues on Vercel, local files elsewhere.
  apiKey: 'session-authenticated',
  fetch: chatFetch,
  tools,
})

// lib/agent.ts, simplified: a chat gets a libfx session on its first message,
// and each message is one turn of it
const libfxSessionId = await agent.newSessionId()
const session = agent.session(libfxSessionId, { model, instructions, context: { chatId, turnId } })
session.prompt(`[${author}] ${text}`, { messageId: `m${turnId}` })
```

**The route.** Vercel Queues delivers the turns no request runs itself to [`app/api/libfx`](app/api/libfx/route.ts): the rest of a turn that outlasted its prompt request, and a prompt's backstop when that request died. libfx's handler runs them:

```ts
// app/api/libfx/route.ts
export const maxDuration = 800
export const POST = agent().wakeHandler()
```

**The trigger.** One entry in [`vercel.json`](vercel.json) subscribes that route to libfx's queue topic:

```json
{
  "functions": {
    "app/api/libfx/route.ts": {
      "experimentalTriggers": [{ "type": "queue/v2beta", "topic": "__libfx_wkf_workflow_session", "retryAfterSeconds": 5 }]
    }
  }
}
```

fx0 keeps the transcript, designs and settings in Redis. Here is one message from send to reply. The numbers match the steps below:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/message-dark.svg">
  <img alt="1. fx0 saves your message. 2. fx0 seals your token, so your own team pays. 3. libfx runs the turn, saving every step as it goes. 4. You see the reply as it's written. 5. If the function crashes, Vercel Queues starts a new function that picks up at the last saved step, so the reply comes later and nothing is lost." src="docs/diagrams/message-light.svg" width="440">
</picture>

**1. Save the message before answering.** `POST /api/prompt` adds the message to the transcript in one Redis script, then hands it to libfx with its message id. libfx stores it before acknowledging, so a message that shows as sent can't be lost, and a retried request reaches the same turn.

**2. Keep the turn's funding.** A queue delivery has no browser cookie, so the prompt route seals its funding in Redis. Every message records the funding of the turn it starts: either the admitted sponsorship or its paid sender's OAuth grant and team. Fresh SDK diagnostics and the journal's restore hook identify the executing turn after a crash. Refresh tokens stay in the cookie, and the server trial key stays out of every stored credential. Missing or expired trial funding never falls back to a customer's paid grant.

**3. libfx runs the turn.** One worker holds a session at a time, and libfx fences out any other. The prompt request runs the turn first; it and each delivery to `/api/libfx` can run for 800 seconds, their `maxDuration`. libfx stops a turn 30 seconds before that limit, keeping what it has done so far, and a delivery to `/api/libfx` continues it, so a long turn spans several invocations.

**4. Copy the stream into the transcript.** Any route following the chat, the prompt's own response or an open tab, copies libfx's stream into the transcript. A cursor check makes each line land once, however many follow. The same Redis script marks a turn running when its start lands, and when its end lands it leaves the turn's history to write, with the design the turn left. The copy then writes that history and design version to Neon, and a write that fails waits in Redis for the next copy to retry.

**5. Pick up where it stopped.** On Vercel, libfx can't tell a crashed function from a slow one, so the request running a turn holds its session until its time limit. The prompt's backstop comes due 5 seconds after that limit: if the request died, the backstop takes the session over and the turn continues where its records end. In a delivery to `/api/libfx`, a process that exits has its delivery run again about a second later, and a function that stops without exiting holds its message until the queue's hold runs out, up to five minutes. The model is told the turn was interrupted, so it can check what happened before going on. A function that only stalled and wakes after that stops at its next write, so two never write at once.

A tool call the crash cut off runs again only if it's safe to repeat. libfx refuses a tool that doesn't say which it is, and fx0 marks its tools in [`lib/libfx-agent.ts`](lib/libfx-agent.ts): reading the design, publishing it, fetching a page, paging through a tool result and searching the tools run again. Edits, questions and subagents don't, so the model is told those calls may have run and decides what to do. The reads start as soon as the model asks for them, while libfx saves the call.

A subagent is an in-memory `createFxEngine()` inside its tool call, billed to the same chat. It has the same design tools, except that it can't start a subagent of its own. Its model requests count toward the parent turn's 64 steps, in a count kept in Redis ([`lib/turn-budget.ts`](lib/turn-budget.ts)), so subagents can't multiply what one turn spends. A retried or recovered request counts once.

TL;DR:

- A crash delays the reply, by up to about 13 minutes, but never loses the chat or the reply in progress.
- The turn continues instead of starting over, so finished model calls aren't paid for twice.
- Each turn keeps its authorized funding after a crash too.

You can watch this happen. Open session diagnostics from the header to see the chat's libfx session, its running turn and how far the transcript has copied libfx's stream.

## Limits

- If a prompt request crashes while it runs its turn, for example by running out of memory, the turn continues about 13 minutes after the send, however early the crash came. On Vercel, libfx can't tell a crashed function from a slow one, so a crashed request still holds the session until its 800-second limit, and the prompt's backstop takes over 5 seconds later. The page keeps showing the reply as running meanwhile. A turn that only runs long isn't affected: libfx stops it 30 seconds before the limit and queues the rest at once for a delivery to `/api/libfx`.
- A text message sent while a tool runs, such as while a design is being written, waits for that tool before the model sees it. A message with images runs as its own turn, after any running turn finishes.
- Every turn bills the login and team that sent the message that started it; a later message cannot change an earlier turn's funding. A text message that joins a running turn is billed to that turn. Token renewal from the same login keeps the turn's billing team.
- Free prompts start in a new design on Opus 5.5 Fast with low effort. Existing paid-only chats keep their own billing. The allowance is five per IP across chats and browsers, with no periodic refill; clearing cookies does not reset it. After it is used, sign in to continue with your own team.
- Published previews update compatible stylesheets, inline styles on uniquely identified elements, and identified leaf text without restarting their scripts. Unedited inputs, listeners, and runtime state stay in place. Changes to scripts, structure, unsupported fields, or conflicting runtime values reload the preview instead. A published design stays visible while its next revision is prepared.
- A design being written streams through a bounded, expiring Redis channel, so viewers on other instances can see it too. Reconnecting resumes from the full prefix; generation IDs and offsets prevent duplicated bytes. The provisional preview strips active markup and runs without scripts. Publishing or ending a turn closes its draft before it can replace the finished preview.
- Deleting a chat removes fx0's records and credential. libfx's session data expires with the World's retention.
- When no route follows a chat, its transcript catches up the next time someone opens it.
- Transcripts are never trimmed, so very long chats get slower to open.
- Design screenshots need an fx0 tab open and visible. With no responding tab the tool reports that capture is unavailable. Full-page captures return at most eight tiles within a shared 600 KiB image budget.

## Where things are

| Path | What's there |
|---|---|
| [`lib/agent.ts`](lib/agent.ts) | Each chat's prompts, questions, cancel, deletion and sign-out |
| [`lib/libfx-agent.ts`](lib/libfx-agent.ts) | The durable agent, its per-chat `fetch` and its tools |
| [`lib/projector.ts`](lib/projector.ts) | Copies a chat's libfx stream into its transcript |
| [`lib/turn-credential.ts`](lib/turn-credential.ts) | The sealed credential each chat's turns bill |
| [`lib/trial.ts`](lib/trial.ts) | Guest identities and the atomic per-IP trial allowance |
| [`lib/journal.ts`](lib/journal.ts) | The Redis journal. Every write is a single Lua script, so it's atomic. |
| [`app/api/libfx/`](app/api/libfx) | Where Vercel Queues delivers libfx's turns |
| [`lib/tools.ts`](lib/tools.ts) | The agent's tools: read, publish and edit the design, fetch a URL, ask a question, page through a long tool result, search the available tools and start a subagent. AI Gateway's web search runs beside them. |
| [`lib/design-artifact.ts`](lib/design-artifact.ts) | Checks that a design is one HTML file of at most 512 KB, with no external assets |
| [`app/api/`](app/api) | Route handlers. Chat routes check sign-in and ownership before anything else. |
| [`components/`](components) | The chat, composer, preview and diagnostics panel |

Neon Postgres holds accounts, who owns each chat, finished turns and every design version ([`migrations/`](migrations)).

## Run it locally

You'll need Node.js 24 and three services:

1. A [Sign in with Vercel](https://vercel.com/docs/sign-in-with-vercel) app with the scopes `openid profile email offline_access` and the permissions AI Gateway: Use and Team: Read Only. Add `http://localhost:3000/api/auth/callback` as a callback URL. Don't leave out `offline_access`: without it, Vercel sends no refresh token and sign-in fails.
2. A Neon Postgres database. Use a separate branch for local work.
3. An Upstash Redis database.

Copy `.env.example` to `.env.local` and fill it in. `SESSION_SECRET` has to be a random string of at least 32 characters. If your local app shares Redis with a deployment, set `FX0_REDIS_PREFIX` (for example `fx0:local`) to keep the chats apart. `FX0_MODEL` changes the model new chats start on.

```sh
npm ci
npm run db:migrate
npm run dev
```

`db:migrate` applies the files in `migrations/` in order. Each one is idempotent, so running it twice is fine. The app never migrates on its own.

## Deploy

Set the same variables on Vercel. The Neon and Upstash integrations in the Vercel Marketplace fill in `DATABASE_URL`, `KV_REST_API_URL` and `KV_REST_API_TOKEN` for you. Set `APP_URL` to your production URL and add `<APP_URL>/api/auth/callback` to your Sign in with Vercel app.

OAuth redirects never trust the request's Host header. They go to `APP_URL`, or, on a preview deployment without one, to that deployment's own Vercel URLs.

To enable the free trial, apply the migrations, set `FX0_FREE_PROMPTS=1` and a server-only `AI_GATEWAY_API_KEY`, then rebuild and deploy. BotID's client protection and server verification are included. Production uses Vercel's trusted client IP; local development shares one local allowance. Keep local Redis prefixes separate from production.

## Test

```sh
npm run typecheck                 # generates the route types, then runs tsc
npm run test:core
npm run test:auth
npm run build
npm run test:smoke                # runs the production build with fake sessions
npm run test:journal:integration  # needs KV_REST_API_URL/TOKEN, writes under its own prefix
npm run test:trial:integration    # needs local redis-server/redis-cli; no remote services
npm run test:artifact:browser     # needs local Chrome (or CHROME_PATH); checks design CSP enforcement
npm run test:budget:integration   # needs local redis-server/redis-cli; no remote services
npm run test:turns:integration    # needs local redis-server/redis-cli; no remote services
```

The auth and route tests mock Vercel, AI Gateway and both databases, so check a real sign-in and real billing on a deployment.

## Safety

Generated pages run in a sandboxed iframe on an opaque origin. Published designs can create interactive popout windows with `await beep.openPopout(html, { title: "Panel", width: 900, height: 650 })` directly from a user click handler. Pass self-contained HTML with inline styles and scripts; the returned handle supports `focus()` and `close()`. Catch rejected promises to show popup-blocking feedback. Each popout contains an isolated iframe with the same sandbox and Content Security Policy. Native `window.open` remains unavailable inside the credentialless design frame. Exported HTML includes a standalone implementation of the same helper. Browser popup blocking still applies; streamed drafts remain scriptless until published. They can't read the app's cookies, storage or credentials, and their Content Security Policy blocks network requests (`connect-src 'none'`). It's still the browser enforcing all of this, though, not a sealed VM.

Paid model requests carry the sender's OAuth token only to AI Gateway. Between requests it stays sealed in Redis and expires with the token. Sponsored requests require a recorded trial admission; the server key is never sent to a browser, cookie, journal or model prompt. Signing out deletes that login's stored credentials and revokes its token. A running turn it funded stops at its next model request; another login's turns keep running. Treat the session cookie and `SESSION_SECRET` as credentials.

## License

[Apache-2.0](LICENSE). The `design.md` styles in [`lib/design-md/`](lib/design-md) come from [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md), under the [MIT license](lib/design-md/LICENSE).
