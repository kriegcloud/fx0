# Majoor product map and fx0 design handoff

**Purpose:** give Kimi K3.1 Pro in fx0 enough product truth to design a new media-first Majoor UI, then hand that design back for implementation in our fork.

**User-selected direction:** media-first professional workspace: quiet chrome, strong typography, large previews and progressive disclosure of advanced controls.

**Snapshot:** 2026-10-29, fork commit `1830902ce8084bc13b39b8934eb417575b3ba86f`, branch `feat/open-media-workflow`. This is a source-based product audit, not a screenshot critique or a claim that every optional feature works in the local runtime.

## Start here

- Human orientation: open [the visual product map (/home/elpresidank/ai/reports/majoor-product-map-2026-10-29/index.html)](/home/elpresidank/ai/reports/majoor-product-map-2026-10-29/index.html), a searchable product map with feature statuses, proposed surfaces and source links. It is a documentation artifact, not the proposed asset-manager UI.
- To run the design task: select **Kimi K3.1 Pro** in fx0 and paste the prompt in [`04-kimi-fx0-prompt.md`](04-kimi-fx0-prompt.md).
- Design agent reading order: this file → [`02-experience-architecture.md`](02-experience-architecture.md) → [`01-capability-map.md`](01-capability-map.md) → [`03-component-contracts.md`](03-component-contracts.md) → [`05-acceptance-and-implementation.md`](05-acceptance-and-implementation.md) → [`fixture-data.json`](fixture-data.json).
- Machine-readable coverage: [`capability-map.json`](capability-map.json) contains stable capability IDs, availability statuses, constraints, proposed surfaces and commit-specific evidence. [`source-inventory.json`](source-inventory.json) contains routes, settings and Vue component entry points. Consult it as needed rather than loading every low-level record first.

## What is included

95 capability groups across browsing, search, organization, inspection, media tools, comparison, live generation, workflows, file reuse, optional AI, operations and preferences/integration. The evidence inventory contains 151 literal backend route registrations, 100 frontend endpoint constants, 99 setting-ID definitions and 41 Vue components. These are different units, not additive feature counts.

Seven proposed surfaces organize those capabilities: Library; Review/Compare; Collections; Live review; Workflows; Sources & Library Health; Preferences. Review can be contextual, and secondary destinations need not occupy permanent primary navigation. Twenty component contracts and six primary journeys explain how to preserve capability without preserving the current layout.

## Important boundaries

- Preserve our media **Open workflow** feature: new ComfyUI tab, original UI workflow when available or API graph fallback, no automatic run.
- Source directories, collections, execution stacks and workflow files are distinct objects.
- Current watcher scope is output **or one custom root**. Simultaneous watching of all character GENERATIONS folders and automatic glob discovery are proposed backend changes.
- Optional AI must have disabled/not-indexed/loading/degraded states. Do not equate enabled preferences with a usable loaded model.
- A guide advertises false color and vectorscope, but corresponding current viewer controls/rendering were not located. They are explicitly `docs-only`, not baseline working features.
- The fx0 prototype is standalone HTML; the production fork remains Vue/TypeScript/Pinia. No framework migration is requested.
- Fixtures are fictional and contain no personal media, real prompts, credentials or real library records. Do not inspect the user's media for design assets.

## File locations and scope

Canonical handoff: `/home/elpresidank/ai/reports/majoor-product-map-2026-10-29/`.

Identical delivery copy for fx0 references: `/home/elpresidank/YeeBois/workstation-apps/fx0/docs/design-briefs/majoor-assets-manager/`.

Majoor source: `/home/elpresidank/ai/ComfyUI/custom_nodes/ComfyUI-Majoor-AssetsManager`.

Maintained fork: <https://github.com/kriegcloud/ComfyUI-Majoor-AssetsManager>.

No design-agent run, real-media inspection, runtime setting changes, fork implementation, commit or push is part of this handoff creation. The fx0 README/implementation were inspected only to establish reference-file, HTML artifact, model-choice and popout constraints. Existing unrelated fx0 work was preserved.
