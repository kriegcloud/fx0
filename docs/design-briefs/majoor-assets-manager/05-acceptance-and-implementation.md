# Design acceptance and implementation bridge

This is a review checklist for the future design and implementation. It is not a claim that a design has already been produced or that all source features have been exercised in the running UI.

## Design acceptance

| Criterion | Concrete review exercise | Pass condition |
| --- | --- | --- |
| Media first | Open Library and Review at wide and narrow sizes | Media occupies the useful area; routine actions are visible; metadata and maintenance do not overwhelm it. |
| Findability | Search, add filters, change source, open/close review | Query/filter/source context remains visible and survives return; zero-match state explains how to recover. |
| Selection scope | Select two images, then a mixed selection | Active inspector asset and selected set are distinguishable; action labels/counts match affected files. |
| Curating | Rate/tag/add to collection, then remove membership | Changes are reflected consistently; membership removal does not imply source deletion. |
| Comparison | Select two, pin one, switch A/B and side-by-side | Slot identity, navigation, active mode and reset are clear; empty/mixed-type slots work. |
| Workflow semantics | Try UI-graph, API-only and missing-workflow assets | New-tab/no-run behavior is explicit; API-only layout limitation and missing workflow have honest states. |
| Saved workflows | Inspect, validate, load against dirty canvas | Inspection is non-destructive; loading has dirty-canvas handling; missing models/nodes do not become silent install promises. |
| External roots | Add two fictional GENERATIONS roots; take one offline | Concrete paths, scan progress, offline state and single-watch-scope constraint are correctly represented. |
| Live monitoring | Simulate idle → sampling preview → completed output | Temporary preview/final asset are distinct; pinned reference survives; Run/Stop are explicit host actions. |
| AI degradation | Enable AI with missing model/index | Preference, readiness and coverage remain distinct; normal browsing/search remain usable. |
| Export intent | Choose original, clean, ZIP, Collect Files | Each purpose and consequence is understandable; incomplete inputs and fallback destination appear. |
| Risky operations | Partial delete, duplicate tag merge, backup restore | Affected objects and partial outcome are explicit; no invented undo; database backup is not media backup. |
| Accessibility | Keyboard-only navigation, dialogs, long text, reduced motion | Focus visible/returned; labels accessible; no host shortcut leakage; statuses not color-only. |
| Consistency | Compare Library, Feed, Collections and search results | Shared asset cards, selection language, metadata, rating/tag and feedback behavior. |
| Completeness | Inspect feature coverage keyed by all catalog IDs | Every capability has a designed home or explicit deferral; backend/docs-only/GAP items are labeled correctly. |
| fx0 delivery | Publish and interact with artifact offline | One HTML ≤512 KiB; no network/CDN dependencies; no private media; no fake production API calls. |

## Deliverables expected from the design agent

- One coherent prototype with the primary journeys interactive.
- Page/surface map and the reasoning behind navigation choices.
- Component catalog with names, props/conceptual inputs, emitted actions and variants.
- Token sheet with actual values and semantic names, including density and focus/motion.
- State and responsive specifications, including loading, error, empty, partial, unavailable, read-only and host-dependent cases.
- Capability coverage table using all IDs in `capability-map.json`, plus explicitly deferred or proposed features.
- Implementation notes that distinguish visual/state changes from backend work and host integration.

Do not require an identical pixel layout across all widths. Require an intentional hierarchy and preserved task completion.

## Production implementation slices

These are recommendations for the later implementation agent, not authorization to start coding now.

1. **Foundation and adapters:** add scoped semantic tokens and reusable primitives; normalize existing payloads; keep host routing and write guards. Verify normal sidebar and host CSS remain intact.
2. **Library and curator loop:** shared cards, source/search/filter controls, selection, ratings/tags, collections and feedback. Preserve virtualization and stable IDs. Test filter/selection persistence, partial writes and long paths with fixtures.
3. **Review and reuse:** unified media review chrome, comparison, metadata and Open workflow. Preserve existing codecs/players and imperative viewer lifecycle. Verify UI graph/API graph/no-workflow cases and that reopening never queues.
4. **Workflows and live review:** saved workflow library, validation, Graph Map, parameter context, streams, execution and popout. Test dirty canvas, unsupported nodes, preview-vs-final, blocked popout and host disconnect.
5. **Sources and operations:** roots, watcher, scans, AI coverage, duplicate review, backups and preferences. Keep multi-root watching as a separate backend change. Test disconnected drives and read-only paths without using private media.
6. **Coverage and polish:** reconcile every feature ID, keyboard/accessibility, narrow/wide/detached layouts, localization, performance and production bundle integration.

Use a reviewed synthetic fixture for runtime UI validation. Image viewing still requires the user's approval under the hub rules. Build the frontend, verify served bytes and coordinate any Python restart around active jobs. The source commit is a snapshot; check the fork's current state before implementation and preserve unrelated changes.

## Integration boundaries

- Current production source: `/home/elpresidank/ai/ComfyUI/custom_nodes/ComfyUI-Majoor-AssetsManager`.
- Audited commit: `1830902ce8084bc13b39b8934eb417575b3ba86f`; maintained branch `feat/open-media-workflow`.
- Host: local ComfyUI; the extension's backend uses `/mjr/am/*` plus host APIs. `source-inventory.json` indexes actual registrations and source lines. Use source contracts, not conceptual prototype types, for production requests.
- Frontend: Vue 3, TypeScript, Pinia, PrimeVue and existing imperative viewer/graph/drag modules. Vite emits `dist`; ComfyUI serves it.
- Endpoint mutation calls must retain existing Result envelopes, authorization, CSRF checks, path restrictions and partial error handling.
- Do not change the active generation destination, watcher scope, model pins or stored user preferences as a side effect of visual redesign.
- Retain explicit fork behavior: media Open workflow → new tab → UI/API import → no execution.
- Source-of-truth map: `capability-map.json`; file/route/settings evidence: `source-inventory.json`; UI architecture is a proposal, not existing API structure.

## Specific uncertainty ledger

| Item | What is established | What remains unverified |
| --- | --- | --- |
| All feature behavior | Source and guides audited; inventory covers major surfaces and integration routes | End-to-end runtime behavior of every action, codec and optional model |
| False color / vectorscope | Advertised in viewer tutorial | No corresponding current viewer controls/render path found; MED10 is docs-only |
| Stack editing | Server routes for cover/name/merge/dissolve | Dedicated frontend interaction beyond group/member display |
| Library audit | Endpoint and client helper exist | Dedicated user-facing audit surface |
| Multiple external watches | Multiple roots can be registered; one scope selected by resolver | Simultaneous watcher support and wildcard auto-discovery require backend work |
| AI model readiness | Optional AI implementation and readiness APIs exist | Florence-2 previously failed locally; no fresh model-loading claim in this map |
| Workflow revisions | Sidebar invokes validate/version/diff routes | No implied Git history, universal rollback or dependency installation |
| Advanced viewer formats | Codec/model loaders and fallback paths exist | Every format, platform and auxiliary resource combination |
| fx0 Kimi route | Local README documents `kimi-k3.1-pro` and reference tools | Current provider entitlement/live generation; this task does not invoke the model |
