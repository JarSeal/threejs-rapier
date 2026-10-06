Status: draft | not-implemented
Category: Merging, Debug, Editor
Epic: p370_static-mesh-merging-and-texture-atlas-systems.md (Tier 1.3)
Blocked by: p372_mesh-merge-groups.md
Related: \_DONE_p083_editor-creator-view.md (the editor epic; future select/transform tools build on D4), p150_current-entity-data-source-info-on-edit-windows.md (source info on edit windows), \_DONE_p345_gpu-memory-and-draw-call-debugger.md (draw counts), \_DONE_p094_refactor-draggable-windows-and-dialogs.md

# Merge Debugging & Member Editing

Makes merging visible and editable in debug mode:

- a **"Merging" drawer tab** listing groups and their members, with what each group saves;
- **group and member windows**, with links between them;
- an **overlay** showing which meshes a group is made of, and an A/B toggle that draws a group
  unmerged;
- an **edit-session API**: a member is detached from its group while it's being moved, then merged
  back. The member window's transform fields use it now; the select/transform tools (not planned
  yet) will use it later.

---

## 1. Grounding

- **No Meshes tab or mesh edit window exists** (`DEFAULT_DEBUG_DRAWER_TAB_ORDER`,
  `core/Config.ts:22-37`). The Lights tab is the pattern for an entity list with edit windows:
  `core/Debug/Light/_dbg__LightGUI.ts` builds rows with `debuggerListCMP` (`:1127`) and registers
  its edit window kind with `registerDraggableWindowKind` (`:1146`).
- **Drawer tabs**: `createDebuggerTab({ id, title, icon, content, refreshIntervalMs, onOpen, ... })`
  (`debug/DebuggerGUI.ts`); `updateDebuggerTab` is a no-op unless the tab is visible.
- **Managed entities**: `_registerManagerDebugInfo(manager, { label, icon, tabId })` and
  `_getEntityManagerInfo` (`core/Debug/_dbg__ManagedEntities.ts:20,26`). A managed entity's window
  is read-only with a link to its manager's tab (the sky box's lights do this).
- **Debug helpers** added to the root scene are marked with `markDebugHelper(obj)`
  (`debug/Profiler.ts:189`), so the profiler census counts them in their own row.
- **Undo** (`core/Debug/_dbg__UndoRedo.ts`): per-scene action buckets; actions are registered by
  type with do/undo handlers.
- **Lines** (`core/Lines/`): the line system the LOD overlay (p348 §6) also uses.
- p372 gives `MERGE_GROUP`, `MERGE_MEMBER`, `TAG_MERGED`, `updateMergeMember` and the part table;
  group entities are `MANAGED_BY` `MERGE`.

## 2. Design

### D1 — "Merging" drawer tab (`core/Debug/_dbg__MergeGroups.ts`)

Public entry `debug/MergeGroups.ts`, loaded with the usual `_dbg__` dynamic import; a new id in
`DEFAULT_DEBUG_DRAWER_TAB_ORDER` and an icon.

- **Summary pane:** groups, members, merged vertices, draws now vs. draws if unmerged (members +
  groups, main pass; × shadow casters for the shadow passes), wasted vertices, rebuilds and
  in-place updates last second, build time.
- **Group list** (`debuggerListCMP`): one row per group (id, `AUTO` cell, material, members,
  vertices); row toggles for "highlight" (D3) and "show unmerged" (D3); click opens the group
  window.
- **Refusals:** a collapsible list of entities that asked for `merge` and were refused (p372 §5),
  with the reason.
- `refreshIntervalMs: 500` while visible.

### D2 — Windows

Two draggable window kinds (`registerDraggableWindowKind`), opened with `toggleDraggableWindow`:

- **Group window** (`mergeGroup`): settings, stats, member list (click opens the member window),
  buttons: rebuild, compact, dissolve (undoable: re-creates the group with the same members).
- **Member window** (`mergeMember`): entity id and app id, geometry and material ids, its part
  range, "Merged into <group>" (link to the group window), transform fields (D4), "remove from
  group" (undoable).
- `_registerManagerDebugInfo('MERGE', { label: 'Merge group', icon, tabId })`, so anything that
  shows a managed entity (the profiler's Objects tab via `registerEntityWindowOpener`) links to
  the group window.
- A future Meshes tab (not planned) opens the member window for merged meshes.

### D3 — Overlay and A/B

- **Highlight:** member bounding boxes drawn with the line system in one colour per group (a
  stable hash of the group id), only for groups in view; marked with `markDebugHelper`. "Highlight
  all" in the summary pane.
- **Show unmerged** per group: hides the group mesh and shows its members' own meshes (removes
  `TAG_MERGED` visibility without leaving the group), for an A/B of image and draw count. Runtime
  only, cleared on scene exit.
- **Colour by member** (open question): a debug-only vertex colour attribute on the group mesh.

### D4 — Edit sessions and picking

```ts
beginMergeMemberEdit(entityId: number, world?): void;
endMergeMemberEdit(entityId: number, world?): void; // in-place rewrite via updateMergeMember
cancelMergeMemberEdit(entityId: number, world?): void; // restores the transform at begin
getMergeMemberAtFace(groupEntityId: number, faceIndex: number, world?): number | undefined;
```

- **Begin** collapses the member's range in the group (like a disable) and shows its own mesh, so
  moving it costs nothing per frame in the group. **End** writes the new transform into its range
  once. A physics member's body is moved with the same transform (`world.setTransform`), since a
  static body doesn't follow its mesh.
- **Picking:** a binary search over the group's part table by `faceIndex × 3` (index start). The
  future select tool raycasts as usual and resolves a group hit to the member.
- **Undo:** one `merge.memberTransform` action per session (transform before and after); undo
  and redo go through `updateMergeMember`.
- **First user:** the member window's position / rotation / scale fields (D2) open a session on
  the first change and end it when the window closes or after 500 ms without changes.
- **Persistence:** none here. Writing an edited transform back to the scene JSON is the editor
  epic's save plan (p083 "Future plans").

## 3. Phases

### Phase 1 — Tab and windows (D1, D2)

**Exit:** largeWorld's groups are listed with correct counts; group and member windows open from
rows and link to each other; the profiler's Objects tab links a group entity to its window.

### Phase 2 — Overlay and A/B (D3)

**Exit:** highlighting a group outlines its members; "show unmerged" changes the draw count by the
member count and leaves the image unchanged.

### Phase 3 — Edit sessions, picking, undo (D4)

**Exit:** moving a merged member from its window moves it smoothly, merges it back without a
rebuild (rebuild count unchanged), and undo restores it; `getMergeMemberAtFace` returns the right
member for raycasts on 3 members of one group.

### Phase 4 — Docs and versioning

1. `CLAUDE.md` debug system section (the tab, windows, edit sessions).
2. Engine minor; `CHANGELOG.md`.

## 4. Versioning

Engine minor (debug tab, public edit-session API).

## 5. Risks

| Risk                                                                              | Mitigation                                                                |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| A session left open (window closed mid-drag, scene exit) leaves a member detached | Sessions end on window close and are cancelled on scene exit              |
| Overlay lines for thousands of members cost more than what they show              | Only groups in view, only toggled groups, capped line count with a notice |
| Moving a physics member's mesh without its body                                   | `endMergeMemberEdit` moves both (D4)                                      |

## 6. Open questions

1. "Colour by member" (D3): worth a debug-only attribute, or is the bounding-box overlay enough?
2. Should a member window exist for unmerged meshes too, as the start of a Meshes tab? Out of scope
   here; it would fit p150.
