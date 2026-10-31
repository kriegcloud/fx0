# Component and state contracts

These are proposed design contracts, not exports already present in the code. Prefer a small reusable family over independent mockups that diverge. The implementation remains Vue 3 / TypeScript / Pinia with existing PrimeVue and imperative viewer modules, built by Vite into ComfyUI-served assets. fx0's HTML is a design prototype, not a production framework migration.

## Shared component inventory

| ID / component | Essential inputs | Outputs/actions | Variants and states | Implementation entry points |
| --- | --- | --- | --- | --- |
| C01 WorkspaceShell | active surface, host width, connection, activity | navigate, resize, reveal secondary panels | docked sidebar, wide mode, detached review; connected/disconnected | `ui/features/runtime/entryUiRegistration.ts`, `ui/features/panel/panelRuntime.ts` |
| C02 SourceNavigator | scope, roots, selected path, root availability, watched target | choose scope/path, up/back, pin, manage roots | output/input/custom/collection; offline/read-only/unindexed | `scopeController.ts`, `CustomRootsPopover.vue`, `PinnedFoldersPopover.vue` |
| C03 SearchAndFilters | query, filter values, scope, sort, result count | query/change/clear, choose calendar, choose similarity | default, active chips, lexical/semantic, loading, zero results | `SearchBar.vue`, `FilterPopover.vue`, `SortPopover.vue`, `AgendaCalendar.ts` |
| C04 MediaCard | stable asset identity, kind, thumbnail, file facts, badges, selected/active | select, open, rate, menu, drag | image/video/audio/3D, missing thumbnail, pending metadata, errored, stack cover | `AssetCardInner.vue`, `FolderCard.vue`, `VirtualAssetGridHost.vue` |
| C05 SelectionActionBar | selected IDs, allowed actions, counts, pending operation | compare, add to collection, export, clear, delete | one/many, mixed-kind, partial permission, working, partial success | `GridSelectionManager.ts`, `GridContextMenu.ts` |
| C06 MetadataInspector | asset, parsed/raw metadata, availability, workflow payload | copy, edit rating/tags, open workflow, inspect graph, refresh | no selection, loading, partial, unsupported metadata, missing file | `AssetSidebarContent.vue`, `SidebarGenerationSection.vue`, `ViewerMetadataBlock.vue` |
| C07 MediaViewport | media kind/source, fit/zoom/pan, playback, display tools | navigate, change view, capture, fullscreen, focus | image, video, audio, 3D; decoding/loading/error | `ViewerCanvas.ts`, `mediaFactory.ts`, `model3dSupport.ts`, `audioVisualizer.ts` |
| C08 PlayerControls | duration, time, rate, volume, in/out, loop, supported actions | play/pause, seek, frame-step, set range | idle/playing/buffering/ended, unknown duration, unavailable frame stepping | `ui/components/VideoControls.ts`, `playerBarManager.ts` |
| C09 CompareWorkbench | 2–4 slots, pinned references, compare mode, sync | assign/unpin/swap, wipe/blend, sync, navigate | A/B, side-by-side, four-up; empty slot, mixed media, duration mismatch | `abCompare.ts`, `sideBySide.ts`, `videoSync.ts`, `floatingViewerUi.ts` |
| C10 AnalysisDrawer | channel, EV/gamma, overlays, probe, scope modes | adjust/reset, choose overlay, copy color | view-only, default/modified, unsupported, processing | `toolbarControls.ts`, `scopes.ts`, `probe.ts`, `loupe.ts` |
| C11 CollectionPicker/Detail | collections, counts, selected assets, optional ideas/groups | create, add, remove membership, delete collection | empty, mixed roots, skipped existing, suggestion review | `CollectionsPopover.vue`, `AddToCollectionMenu.vue` |
| C12 WorkflowCard/Inspector | document path, summary, usage, favorite, thumbnail, validation/revisions | inspect/load/save/duplicate/category/edit thumbnail | valid, partial, missing nodes/models, invalid JSON, dirty-canvas conflict | `SidebarWorkflowSection.vue`, `WorkflowInfoDialog.vue`, `WorkflowSaveInfoDialog.vue` |
| C13 GraphInspector | graph, selected node, nested subgraphs, host compatibility | pan/zoom, select, copy/import/transfer | inspection-only, no graph, large graph, unsupported host action | `WorkflowGraphMapPanel.ts`, `workflowGraphMapActions.ts` |
| C14 LiveSourceControls | follow-output/node/sampler modes, node support, queue/progress | choose follow source, pin, Run, Stop, popout | idle/running/final, unsupported node, disconnected, popup blocked | `LiveStreamTracker.ts`, `NodeStreamController.ts`, `sidebarRunButton.ts` |
| C15 OperationStatus | operation type/scope, progress if known, result/error | inspect, retry, dismiss; cancel only if supported | queued/running/completed/partial/failed; determinate/indeterminate | `StatusDot.ts`, status/runtime APIs |
| C16 RootEditor | real path, label, availability, registration, current watcher | browse/select/add/remove/scan/watch | invalid, unavailable, unwritable, mounted, not watched | `CustomRootsPopover.vue`, `custom_roots.py`, `watcher_scope.py` |
| C17 ExportSheet | selected assets, export purpose, eligible formats, destination | original/clean/ZIP/Collect Files | unsupported format, preparing, partial archive, fallback destination | `frameExport.ts`, `DragOut.ts`, `batch_zip.py`, `collect_files.py` |
| C18 DuplicateReview | duplicate group, keeper, metadata differences, permissions | merge tags, confirm removal | exact duplicates, no groups, analysis pending, partial delete | `panelContextMenuExtraActions.ts`, `duplicates.py` |
| C19 SettingsSection | setting value/default/scope, capability, save mode | change/apply/reset where supported | local/server/host, invalid, read-only, apply failed | `ui/app/settings/*`, `mjr_am_backend/settings.py` |
| C20 Confirmation/Feedback | action, affected objects/count, destination, consequences | confirm/cancel/retry | ordinary write, destructive, conflict, partial success | existing dialogs/toasts and backend Result envelopes |

Paths without a directory above are searchable filenames within the source root; exact paths and commit links are in the capability map and `source-inventory.json`.

## Normalized design data — adapter proposal

Use these conceptual shapes for the prototype. They are **not** exact HTTP response schemas. Existing `ui/types/asset.d.ts` deliberately allows missing/unknown fields; production adapters must normalize actual payloads and preserve identity.

```ts
type MediaKind = 'image' | 'video' | 'audio' | 'model3d';
type Availability = 'ready' | 'loading' | 'missing' | 'unsupported' | 'error';
type AssetView = {
  key: string; indexedId?: number;
  kind: MediaKind; name: string; sourceId: string; relativePath: string;
  width?: number; height?: number; durationSeconds?: number; sizeBytes?: number;
  rating: 0|1|2|3|4|5; tags: string[];
  preview: Availability;
  workflow: 'ui-graph' | 'api-graph' | 'absent' | 'unknown';
  metadata: 'ready' | 'partial' | 'loading' | 'error';
  enrichment: 'disabled' | 'not-indexed' | 'indexing' | 'ready' | 'degraded';
  stackId?: string;
};
type ActionAvailability = { allowed: boolean; reason?: string };
type ResultView = {
  state: 'idle'|'running'|'succeeded'|'partial'|'failed';
  affected: number; succeeded?: number; failed?: number;
  destination?: string; message?: string;
};
```

Do not represent unknown values as zero. A 0-star asset differs from unknown rating. A missing duration differs from a zero-second clip. If a model is enabled but not loaded, show readiness separately from the preference switch.

## Required action distinctions

| Action | Correct scope/behavior | Failure/edge state |
| --- | --- | --- |
| Open media | Viewer state only | Unsupported codec, missing source, unavailable dependent model resources |
| Open workflow from media | New host tab; UI graph or API import; no execution | No workflow, malformed payload, missing host importer, layout unavailable for API-only data |
| Load saved workflow | Host import with dirty-canvas handling | Cancel, unavailable importer, validation warnings |
| Inspect graph | Read saved graph without replacing active graph | Missing/large/partial graph |
| Transfer parameters | Explicit compatible destination in host graph | No target, incompatible widgets, stale node |
| Run / Stop | Queue active workflow / interrupt generation | Host disconnected, queue state changed, rejected prompt |
| Remove from collection | Remove logical membership | Missing collection, partial membership update |
| Delete asset/folder | Remove real files under existing permissions | Read-only source, denied write, some files failed; no invented undo |
| Register source | Add root configuration | Invalid directory, offline drive, path restriction |
| Remove source | Remove registration | Explain effect on visibility; not file deletion |
| Scan / vector backfill | Index filesystem metadata / compute embeddings | Busy, partial coverage, missing tools/models, permission denied |
| Clean export / Collect Files | Strip supported metadata / assemble reproduction bundle | Unsupported format, incomplete inputs, output fallback location |

## State matrix for design review

Every component needs default, focus-visible, hover where applicable, disabled with reason, busy and failure. The following cross-component states require composed examples:

1. Empty new library with a clear Add source/Scan path.
2. No matches with active filters retained and a reset action.
3. Unplugged external source with previous context retained.
4. Asset preview ready while metadata is still loading.
5. Missing workflow; API-only workflow; complete UI workflow.
6. Selection across mixed file types, with only compatible actions enabled.
7. Multi-file operation partially succeeds; identify successful and failed counts.
8. AI enabled but dependencies/model unavailable; text search still works.
9. Read-only source/write authorization blocked; viewing still works.
10. Video/3D decoding or resource failure with original download fallback.
11. Live preview becomes a saved result without losing pinned references.
12. Popup blocked; floating in-host viewer remains usable.
13. Missing workflow nodes/models and dirty current canvas are separate warnings.
14. Scan and vector enrichment progress differ; do not fake a shared completion percentage.
15. Backup restore or reset identifies affected index state and consequences.
16. Long filenames, deep paths, long tags and localized labels remain navigable.

## Design tokens and engineering handoff required from Kimi

Kimi must define actual token values for color/surface/text/accent/status, font family/size/weight/line-height, spacing, radius, elevation, borders, density, focus ring and motion. Use system/inline assets that work in fx0. Include card/player/dialog variants; container-width behavior; minimum hit targets; keyboard/focus rules; truncation; loading/error copy; and reduced-motion behavior. Explain any departure from the proposed pages.

For production, map tokens to existing ComfyUI/Majoor CSS variables with a clear namespace. Avoid global element selectors that restyle ComfyUI. Preserve Vue/Pinia state and existing service calls behind small adapters. Use the current tested `dist` build/install process; do not replace working controllers wholesale merely to match a prototype's DOM.
