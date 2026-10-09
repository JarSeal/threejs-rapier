Status: stub — not-implemented
Category: Gameplay, Save games
Related: \_DONE_p603_gameplay-architecture-contracts.md (C7: events, missions, the save service), p604_multiplayer-viability-study.md (§4 rule 7: serializable components, shared with network replication), p500_restore-physics-snapshot.md (the physics part of a save), p420_npc-simulation-tiers.md (`ABSTRACT` NPC state is game state), p610_character-and-input-action-architecture.md (controllers and brains saved as `{ kind, params }`), p355_save-menu-and-file-server-settings.md (not this: it saves debug edits into asset JSONs)

# Game Events, Missions and Save Games — Stub

**This is a stub.** p603 left all three as a direction (C7): nothing implements them. This plan
decides their shapes.

## Goal

- **Game events:** a typed event bus in the simulation (`emitGameEvent`), delivered in a fixed
  order at a fixed stage, which missions, achievements, audio and UI subscribe to.
- **Missions and objectives:** state machines over game events, with their state in save data.
- **Save games:** components marked serializable, saved and loaded by one service, which mission
  state, p420's `ABSTRACT` NPCs and p604's snapshots share.

## The direction it starts from (p603 C7)

- Collision events already have a fixed delivery point: `flushPhysicsEvents`, once per sub-step,
  after the held keys and before `APP_PHYSICS_STEP`. The bus delivers there or right after.
- Event types are declared by declaration merging (like the actor `kind`), so the toolkit and the
  app add their own.
- Actors save their controller and brain as `{ kind, params }` (C1); the registries rebuild them.

## Grounding (2026-10-09)

- No event bus. The listener APIs are per feature with their own shapes: `onLocomotionStateChange`,
  per-collider collision callbacks, `onSkyBoxChange`, `registerOnSceneExit`, `onDevDataGathered`,
  `onGeometryDeleted`.
- No missions and no save games. `__saveData` is the debug tools' per-scene asset overrides, and
  p355 is about writing those into the repo.
- No ECS serializer. `takePhysicsSnapshot` / `restorePhysicsSnapshot` exist but don't rebind the
  cached proxies (p500 repairs them). Entity ids are per world (index + generation); `appId` is the
  stable id (p604 §4 rule 4).

## Open questions

1. **Which existing listeners move onto the bus:** gameplay ones (locomotion, collisions) or none,
   keeping the bus for game code.
2. **Delivery:** within the sub-step that emitted (re-entrant, ordered by emission) or queued to the
   next fixed point; and whether presentation code (UI, audio) gets its own frame-time delivery.
3. **Save format and storage:** JSON or binary, versioned per component; localStorage, IndexedDB,
   a file, or a backend; the slot UI belongs to the app.
4. **What a load restores:** a scene load plus component state, or a physics snapshot too (p500);
   bodies mid-flight need the second.
5. **Mission authoring:** code-first state machines or a data asset (`*.mission.json`), and the
   debug tab that shows and forces their state.
