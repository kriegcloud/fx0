# Copy-ready prompt for Kimi K3.1 Pro in fx0

Select **Kimi K3.1 Pro** in fx0. The local implementation recognizes the exact model ID `kimi-k3.1-pro`; catalog presence and account access remain runtime concerns. This handoff does not change fx0's model configuration or start a model run.

Paste the block below. The file locations work with fx0's local read-only reference tools when the current home-directory reference root is enabled. If access is denied, report the missing root; do not substitute guessed product behavior.

---

Design a new **Majoor Assets Manager for ComfyUI** interface from first principles. We own a fork and will implement your design there. The user dislikes the current appearance and explicitly wants a **media-first professional workspace**: quiet chrome, strong typography, large previews and advanced controls revealed when needed.

First use your local reference tools to read:

`/home/elpresidank/YeeBois/workstation-apps/fx0/docs/design-briefs/majoor-assets-manager/README.md`

Read the other files in its prescribed order. If that mirror is unavailable, use:

`/home/elpresidank/ai/reports/majoor-product-map-2026-10-29/README.md`

The folder contains a pinned-source feature map, a proposed information architecture, component/state contracts, synthetic fixture data, an acceptance checklist, and machine-readable capability/source inventories. Use `list_reference_roots`, `list_reference_files`, `read_reference_file` and bounded text search as needed. Reference reads are paged; continue through the required documents instead of stopping after the first excerpt. No filesystem write or terminal tools are needed to design.

## Objective

Produce a coherent, interactive design prototype and engineering handoff for the fork. Optimize these loops:

1. Find media → inspect → compare variants → rate/tag/collect → reopen its workflow.
2. Add an external generation folder → scan → browse → understand which source is watched.
3. Monitor a generation → pin a reference → compare completed results → explicitly rerun/stop.
4. Browse saved workflows → inspect graph/validation → load safely without losing current work.

Design from user intent. The existing toolbar organization and page names are not binding. Preserve capability coverage, semantics and host integration. This is a desktop creative tool integrated with ComfyUI, including narrow sidebar, wide workspace, bottom feed and detached viewer contexts.

## Product truth

Read `01-capability-map.md` and `capability-map.json`. Feature statuses matter:

- `existing`, `fork`, `host`, `optional` are implemented capabilities with stated constraints.
- `backend` means a service capability whose dedicated UI is not established; mark new UI wiring as implementation work.
- `docs-only` is not a verified working feature. The guide's false-color/vectorscope claims were not found in current viewer controls/rendering.
- GAP items are proposals or non-goals, not current behavior.

The current watcher handles output OR one selected custom root. It does not simultaneously watch all `characters/<trigger>/GENERATIONS` folders. A custom root is a real directory, not a glob. Do not show all roots as “Watching” unless clearly labeled as a future backend proposal.

“Open workflow” from media is our fork feature: reopen the embedded UI workflow or API execution graph in a **new ComfyUI tab**, preserving current work and **without running it**. Keep this separate from “Load saved workflow,” “Inspect graph,” “Load Asset” and “Run.”

Keep physical files, indexed records, logical collections, execution stacks and saved workflow documents distinct. Collection removal is not file deletion; similar media is not an exact duplicate; AI captions are not original prompts. Exposure/gamma are viewing adjustments, not a general editor. There is no established cloud sync/team-account/marketplace requirement.

## Design and prototype deliverables

1. Briefly state your design thesis and navigation rationale, including what stays prominent and what moves behind disclosure.
2. Publish one self-contained interactive HTML prototype with coherent navigation among the proposed surfaces (or your justified replacement): Library, contextual Review/Compare, Collections, Live review, Workflows, Sources & Health, Preferences. Use shared components and consistent state; do not create unrelated static screenshots.
3. Fully implement the primary journey: search/filter synthetic assets → select two → compare → rate/add to collection → Open workflow simulation → return with library context intact.
4. Make the source-registration journey, workflow dirty-canvas decision and live-preview-to-completed-result transition interactive. Remaining rare operations may use an explicit simulated result, with no real filesystem or host effects.
5. Include a discreet prototype state switcher for empty, filtered-empty, offline source, missing/API-only workflow, read-only, AI degraded, partial operation and running-generation states. Keep these test controls separate from the proposed production UI.
6. Provide a component/token handoff and a feature coverage table keyed by the capability IDs. For each capability: designed location, prototype depth (interactive/static/deferred), implementation dependency and any intentional deferral. No silent drops.
7. Explain how the design adapts at approximately 1440px and 1024px workspace widths, a 360–480px ComfyUI sidebar, and a detached review window. Widths are evaluation scenarios; choose the actual breakpoints/tokens.

## fx0 runtime constraints

The local fx0 preview accepts a single HTML artifact, at most 512 KiB, with inline CSS/JS and no external resources or network requests. Use system fonts, inline SVG/CSS icons and synthetic illustrative media; read `fixture-data.json` for fictional asset labels and states. Do not inspect or copy private media, prompts, workflows or credentials from the real library. Do not call ComfyUI mutation endpoints. All actions in the prototype are local in-memory simulations and labeled as such when results are shown.

Use fx0's `publish_design` and edit tools. Scripted interactions run in the published artifact, not necessarily the streaming draft. If showing a popout, use `await beep.openPopout(html, { title: "Majoor review", width: 900, height: 650 })` from a direct user click, with a blocked-popup fallback. Native `window.open` is unavailable in the preview. A popout is optional; a well-designed in-host fallback is required.

The production fork is Vue 3 + TypeScript + Pinia, with PrimeVue and imperative viewer modules. Your prototype can use plain HTML/CSS/JS; do not prescribe migrating the extension to React/Next.js because fx0 itself uses that stack. Express component contracts and token semantics that can be implemented in the existing fork.

## Quality bar

Use deliberate composition, typography and spacing; a neutral surround that lets media colors dominate; meaningful hierarchy; readable labels; and restrained status treatment. Avoid a dashboard of unrelated cards, decorative metrics, excessive gradients, an icon-only mystery toolbar, and a giant settings form on the default screen. Do not interpret “simple” as removing professional functions.

Every action must either work in the simulation, show a specific unavailable state, or be clearly designated as a future proposal. Include visible focus, semantic controls, sensible keyboard ownership, reduced motion, long-name behavior, dialogs with focus return and clear partial-error copy. Never rely solely on color to convey status.

Finish by checking `05-acceptance-and-implementation.md` and reporting what is fully designed versus deferred. Do not change the fork or fx0 application code. The requested outcome is the reviewable design artifact plus implementation handoff.

---

## Suggested follow-up sequence

After reviewing the first coherent prototype, request focused refinement in this order:

1. Library and selection hierarchy; compare/review and narrow sidebar.
2. Workflow inspector/Graph Map and live monitoring, with exact host-action semantics.
3. Sources, optional AI, operation feedback and maintenance edge states.
4. Token/component extraction, coverage audit and implementation-ready responsive/state specs.

Keep one coherent system. Follow-up turns should amend the existing design instead of introducing a fresh style for each page.
