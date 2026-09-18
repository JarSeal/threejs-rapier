Status: draft | not-implemented | needs-replanning
Category: Physics
Blocked by: p026_physics-api-support-for-joints.md
Epic: https://trello.com/c/8ROzNdXe/161-make-a-possibility-to-run-the-physics-engine-in-a-thread-threading-architecture-for-all-upcoming-thread-implemantations-not-just

# Physics API Support for Multibody Joints — Plan

Adds Rapier **multibody-joint** support to the engine-agnostic Physics API, as a follow-up to
`p026_physics-api-support-for-joints.md`'s impulse-joint work. Split out because multibody joints
are a genuinely separate Rapier solver with different tradeoffs and a smaller JS-level surface —
bundling both into one plan would roughly double p026's scope for a feature most game-engine use
cases don't need immediately.

## Context (grounded in code)

- Rapier (`@dimforge/rapier3d-compat@0.19.3`) exposes multibody joints as a fully separate API
  from impulse joints: `RAPIER.World.createMultibodyJoint(params: JointData, parent1, parent2,
wakeUp): MultibodyJoint`, `RAPIER.World.multibodyJoints: MultibodyJointSet` (`createJoint`,
  `remove`, `get`, `contains`, `forEach`, `forEachJointHandleAttachedToRigidBody`), and joint
  classes `MultibodyJoint`/`UnitMultibodyJoint` plus concrete subclasses (`FixedMultibodyJoint`,
  `PrismaticMultibodyJoint`, `RevoluteMultibodyJoint`, `SphericalMultibodyJoint`). They reuse the
  same `RAPIER.JointData` static factories (`fixed`/`revolute`/`prismatic`/`spherical`) as impulse
  joints, but the resulting joint object exposes no motor configuration at the JS level (only
  `isValid()`, `body1()`/`body2()`, `setContactsEnabled()`/`contactsEnabled()` — no
  `configureMotor*`/`setLimits`, unlike `UnitImpulseJoint`). Multibody joints use Rapier's
  reduced-coordinate articulated-body solver — no drift between connected bodies, better suited to
  rigid chains (e.g. robot arms) than impulse joints' soft-constraint solver, at the cost of the
  missing motor/limit controls.
- This plan assumes `p026_physics-api-support-for-joints.md` has been implemented first: the
  `JointParams`/`JointAPI` shape, the `PhysicsProtocolType.JOINT` numeric range (800-999), the
  `physicsSwitchJoint.ts` worker file, and the `EngineRapier.ts`/`PhysicsAPI.ts` registries it
  introduces are the direct precedent this plan extends. **Do not start detailed design on this
  plan until p026 is implemented and its exact final shapes are known** — this document is a
  placeholder outlining the shape of the work, not a fully grounded implementation plan yet.

## Design decisions (draft — revisit once p026 lands)

1. **Separate id space and API surface from impulse joints**, not a `solver` flag on the existing
   `JointParams`/`JointAPI` — motor/limit methods don't apply to multibody joints, so folding them
   into one type would mean most `JointAPI` methods silently no-op/throw depending on solver type.
   Likely shape: `createMultibodyJoint(params: MultibodyJointParams): Promise<MultibodyJointAPI>`,
   a `MultibodyJointParams` union re-using the same per-type field shapes p026 defines for
   `FIXED`/`REVOLUTE`/`PRISMATIC`/`SPHERICAL` (multibody joints don't support `ROPE`/`SPRING`/
   `GENERIC` — Rapier only exposes the four listed concrete subclasses), and a
   `MultibodyJointAPI` with only the base `ImpulseJoint`-equivalent methods (no limits/motor).
2. **New protocol range**, e.g. `PhysicsProtocolType.MULTIBODY_JOINT` at `1000-1199` (next free
   slot after p026's `JOINT` range ends at 999), with a new `workers/physics/physicsSwitchMultibodyJoint.ts`
   following the same template p026 establishes for `physicsSwitchJoint.ts`.
3. **`EngineRapier.ts` gets a second, parallel set of maps** (`multibodyJoints`/
   `multibodyJointAPIs`, its own id counter) — mirroring, not reusing, the impulse-joint maps
   p026 adds, since Rapier itself tracks them in a fully separate `MultibodyJointSet`.
4. **`deleteRigidBody` must reap both joint sets** — extend the `jointIds`/cleanup logic p026
   adds with an equivalent pass over `physicsWorld.multibodyJoints.forEachJointHandleAttachedToRigidBody`,
   likely via a second `multibodyJointIds: number[]` field on `DeleteRigidBodyResponse`.
5. **Test scene example**: add one demo to the physics test scene (e.g. a short articulated chain
   of 3-4 links connected by multibody `REVOLUTE` joints) placed near p026's joint showcase row,
   ideally positioned so it can be visually compared against p026's impulse-joint `REVOLUTE`
   pendulum to show the drift/stability difference between the two solvers.

## Phases (draft)

**Phase 1 — Engine API additions.** `MultibodyJointParams`/`MultibodyJointAPI` types, protocol
range, `EngineRapier.ts` backend, `PhysicsAPI.ts` facade, worker switchboard — mirroring p026
Phase 1's engine-side gap list exactly, substituting `multibodyJoints`/`createMultibodyJoint` for
`joints`/`createJoint` throughout.

**Phase 2 — Test scene example.** Add the articulated-chain demo to the (by-then-already-enlarged,
by-then-already-lit) physics test scene from p026, near the joint showcase row.

Manual verification for both phases: same approach as p026 — `?isDebug=true`, visually confirm
correct behavior in both `MAIN_THREAD`/`WORKER_THREAD` modes; `tsc --noEmit`/`yarn lint` clean.

## Non-goals

- Motor/limit control for multibody joints — not exposed by Rapier at the JS level for this joint
  type; nothing to add.
- `ROPE`/`SPRING`/`GENERIC` multibody joints — Rapier doesn't expose multibody equivalents of
  these (only Fixed/Revolute/Prismatic/Spherical concrete subclasses exist).
- Unifying the impulse-joint and multibody-joint API surfaces into one type — see Design
  decision 1.

## Risks / open questions

| Risk / question                                                        | Notes                                                                                                                                  |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| p026's exact final `JointParams`/protocol shape isn't fixed yet        | This plan's design decisions must be revisited once p026 is actually implemented, since they're written to extend it by analogy today. |
| Whether a unified vs. separate API surface is the right call long-term | Worth a deliberate second look once both exist side by side and real usage patterns emerge — flagged here rather than decided.         |

## Verification

- `tsc --noEmit` and `yarn lint` clean after each phase, per the repo's Stop hook.
- Manual visual verification of the articulated-chain demo against p026's impulse-joint pendulum,
  in both `workerTarget` modes.
