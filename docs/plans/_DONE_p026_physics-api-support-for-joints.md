Status: implemented
Category: Physics
Epic: https://trello.com/c/8ROzNdXe/161-make-a-possibility-to-run-the-physics-engine-in-a-thread-threading-architecture-for-all-upcoming-thread-implemantations-not-just

# Physics API Support for Joints — Plan

Adds Rapier impulse-joint support (all 7 geometry types: fixed, revolute, prismatic, spherical,
rope, spring, generic) to the engine-agnostic Physics API, following the exact
facade/backend/protocol/worker-switchboard pattern already used for rigid bodies and colliders.
Also enlarges the physics test scene, adds ambient + shadow-casting directional lighting to it,
and adds one worked example per joint type so the new API is exercised and visually verifiable.

## Context (grounded in code)

- **Rapier already has everything needed on the engine side.** `@dimforge/rapier3d-compat`
  (`package.json`, version `0.19.3`) exposes `RAPIER.JointData.fixed/spring/rope/generic/spherical/prismatic/revolute`
  static factories, a `JointType`/`MotorModel`/`JointAxesMask` enum set, `RAPIER.World.createImpulseJoint(params, parent1, parent2, wakeUp)`/`removeImpulseJoint(joint, wakeUp)`,
  `ImpulseJointSet` (`createJoint`, `remove`, `get`, `contains`, `forEach`,
  `forEachJointHandleAttachedToRigidBody`), and joint instance classes `ImpulseJoint` (base:
  `isValid()`, `body1()`/`body2()`, `anchor1()`/`anchor2()`, `setAnchor1()`/`setAnchor2()`,
  `contactsEnabled()`/`setContactsEnabled()`) and `UnitImpulseJoint` (Revolute/Prismatic only:
  `limitsEnabled()`, `limitsMin()`/`limitsMax()`, `setLimits()`, `configureMotorModel()`,
  `configureMotorVelocity()`, `configureMotorPosition()`, `configureMotor()`).
- **The engine already has an unfinished stub for this.** `src/_engine/core/Physics/PhysicsAPITypes.ts:1341-1394`
  has commented-out `createImpulseJoint`/`createMultibodyJoint`/`getImpulseJoint`/`getMultibodyJoint`/
  `removeImpulseJoint`/`removeMultibodyJoint` declarations on the `WorldAPI` type, lifted directly
  from Rapier's own doc comments (raw `RigidBody`/`ImpulseJoint` Rapier types, not our id-based
  API shape) — these should **not** be uncommented as-is (see Design decision 1); they're
  confirmation the gap was scoped out deliberately, not missed.
  `docs/plans/_DONE_p021_make-new-physics-api-work-in-a-thread-mvp.md` §5 lists "Joints and the
  character-controller section of `PhysicsAPITypes.ts` — untouched" as an explicit non-goal of
  that MVP.
- **Zero real joint code exists anywhere in `src/`.** Confirmed via repo-wide grep — no ECS
  component, no protocol message, no worker switch case, no `EngineRapier.ts` function.
- **The rigid-body/collider CRUD pattern is the template to replicate**, end to end:
  - `src/_engine/core/PhysicsAPI.ts` — facade. Every create/delete op (e.g. `createRigidBody`/
    `createRigidBodySync`, `createCollider`/`createColliderSync`, lines ~456-909) branches on
    `physicsState.workerTarget`: `MAIN_THREAD` calls `engAPI` directly and stores the result in a
    local registry Map (`rigidBodies`/`colliders`, keyed by running `id`); `WORKER_THREAD` calls
    `messageWorkerAsync<Response>({ type: PhysicsProtocolType.X, ... })` and wraps the reply in a
    lightweight proxy class (`RigidBodyProxyAPI`/`ColliderProxyAPI`) that forwards further calls
    over the wire. `*Sync` variants throw in worker mode.
  - `src/_engine/core/Physics/EngineRapier.ts` — Rapier backend, thread-agnostic (same module
    instantiated on main thread or inside the worker). Maintains its own running-integer
    `id → Rapier handle` maps (`rigidBodies`, `colliders`) plus `id → API wrapper instance` maps
    (`rigidBodyAPIs`, `colliderAPIs`), separate from Rapier's own internal handles. `createCollider`
    resolves an optional `parentId: number` to a real `RigidBody` via `getRigidBody(parentId)`
    (line ~410) — the same id-to-object resolution a joint's `body1Id`/`body2Id` will need.
  - `src/_engine/core/Physics/PhysicsAPITypes.ts` — shared protocol. `PhysicsUpProtocol`/
    `PhysicsDownProtocol` are big discriminated unions on a `PhysicsProtocolType` numeric enum,
    with a **numeric-range-per-domain** convention: `ENGINE` (0-4, 100-102), `WORLD` (200-399,
    used up to 305), `RIGID` (400-599, used up to 471), `COLLIDER` (600-799, used up to 636).
    **800-999 is free** for a new `JOINT` domain.
  - `src/_engine/workers/physicsWorker.ts` — routes incoming messages by numeric range via
    `getSubType()` to `physicsSwitchWorld.ts`/`physicsSwitchRigid.ts`/`physicsSwitchColl.ts`. Each
    switch file resolves the target API object from an id in the message, then a flat
    `switch (type)` per protocol member. A `physicsSwitchJoint.ts` fits this exactly.
  - `src/_engine/core/PhysicsManager.ts`'s `createPhysicsEntity` (async, line 37) is the ECS entry
    point apps use — it returns an ECS `entityId`, not a `RigidBodyAPI`. To get a rigid body's
    `RigidBodyAPI.id` (needed for a joint's `body1Id`/`body2Id`) from an entity created this way,
    fetch the `BODY_DYNAMIC_VISUAL`/`BODY_DYNAMIC_HEADLESS`/`BODY_STATIC` component off that
    entity (`world.getComponent(entityId, ComponentType.BODY_DYNAMIC_VISUAL)`, etc.) and read its
    `.id`.
  - Rapier auto-removes a body's attached joints internally when the body is removed
    (`RigidBodySet.remove` doc comment), but this engine's **own shadow registries do not know
    about that** — `EngineRapier.ts`'s `deleteRigidBody` (lines ~426-521) already walks
    `rb.numColliders()`/`rb.collider(i)` to reap collider ids from its local maps before calling
    `physicsWorld.removeRigidBody(rb)`, and `DeleteRigidBodyResponse` already carries
    `colliderIds: number[]` back so `PhysicsAPI.ts`'s `deleteRigidBody` (lines ~588-592) can clean
    its own `colliders` Map. Joints need the identical treatment (`jointIds: number[]`), using
    `physicsWorld.impulseJoints.forEachJointHandleAttachedToRigidBody(rb.handle, ...)` to find
    attached joint handles before the body is removed.
- **The physics test scene** (`src/app/physicsTest.scene.json`, `src/app/physicsTest.ts`,
  `src/app/cameras/physicsTestCamera.camera.json`, `src/app/lights/physicsTestAmbient.light.json`):
  - Scene JSON references one light (`physicsTestAmbient`, `AMBIENT`, intensity `0.8`) and no
    skybox. `physicsTest.ts` spawns three bodies imperatively via `createMeshEntity`/
    `PhysicsManager.createPhysicsEntity` (not JSON — physics objects remain code-only per
    `.claude/CLAUDE.md`): a `10×0.5×10` fixed ground box, a dynamic ball, a dynamic box — all
    using `'BASIC'` (unlit `MeshBasicMaterial`) materials and no `castShadow`/`receiveShadow`.
  - Camera (`physicsTestCamera.camera.json`): perspective, `fov 60`, `near 0.1`, `far 100`,
    position `(0, 6, 15)`, `lookAtPoint (0, 2, 0)` — tightly tuned to the current small scene.
  - `src/_engine/schemas/lightSchema.ts` already supports `DIRECTIONAL` lights with full shadow
    config (`castShadow`, `shadowPreset` (`LOW`/`MEDIUM`/`HIGH`/`ULTRA`), `shadowBias`,
    `shadowMapSize`, `shadowCameraNearFar`, `shadowCameraFrustum`, `shadowIntensity`, etc.) — no
    schema change needed.
  - `src/app/largeWorld.scene.json` + `src/app/lights/largeWorldAmbient.light.json` +
    `src/app/lights/largeWorldSun.light.json` are a working in-repo reference for exactly this
    ambient+shadow-directional pairing, including a documented gotcha: size the directional
    light's `shadowCameraFrustum` to the actual play area, not the whole ground, or shadow
    resolution degrades everywhere (`largeWorldSun.light.json`'s own `debugData.description`).
  - Shadow mapping is already enabled globally (`src/index.ts`: `createRenderer({ enableShadows: true, shadowMapType: THREE.VSMShadowMap, ... })`)
    — only per-light `castShadow` and per-mesh `castShadow`/`receiveShadow` opt-ins are needed,
    no renderer change.
  - Mesh-level shadow flags: `MeshPropsSchema` (`src/_engine/schemas/meshSchema.ts`) and
    `MeshManager.ts`'s `createMeshEntity` both support `castShadow?`/`receiveShadow?` (default
    `false`) — this is why the current three bodies produce no shadows today.
  - `MeshBasicMaterial` (`'BASIC'`) ignores lighting entirely — for the new directional light to
    be visually meaningful, the demo materials need to switch to a lit material type (confirm the
    exact identifier, e.g. `'STANDARD'`, in `src/_engine/schemas/materialSchema.ts` during
    implementation).

## Design decisions

1. **New id-based `createJoint`/`deleteJoint` API, not literal uncommenting of the existing
   stubs.** The commented-out `WorldAPI` stubs take raw Rapier `RigidBody`/`ImpulseJoint` types
   and return raw `ImpulseJoint` objects — that shape can't cross the worker postMessage
   boundary and doesn't match how `createRigidBody`/`createCollider` already avoid leaking Rapier
   types (they take/return plain params objects and our own `RigidBodyAPI`/`ColliderAPI`
   wrappers, referenced by running `id`, not Rapier handles). Replace the stubs with an id-based
   `createJoint(params: JointParams): Promise<JointAPI>` / `createJointSync` pair on `WorldAPI`,
   matching `createRigidBody`/`createCollider`'s signature style exactly.
2. **Impulse joints only; all 7 `JointData` geometry types.** Per user decision: `FIXED`,
   `REVOLUTE`, `PRISMATIC`, `SPHERICAL`, `ROPE`, `SPRING`, `GENERIC`, all via
   `World.createImpulseJoint`/`ImpulseJointSet`. Rapier's separate `MultibodyJointSet` (rigid
   articulated chains, no motor support at the JS level) is out of scope here — tracked in
   `docs/plans/p250_physics-api-support-for-multibody-joints.md` instead.
3. **`JointParams` is a discriminated union on `type`**, mirroring `ColliderParams`'s existing
   shape/style (`ColliderParams`, `PhysicsAPITypes.ts:865-963`) and `RigidBodyParams`'s use of
   string-literal unions (e.g. `physicsTest.ts`'s `rigidType: 'FIXED'`/`'DYNAMIC'`) rather than
   numeric Rapier enums:
   ```ts
   export type JointParams =
     | {
         type: 'FIXED';
         body1Id: number;
         body2Id: number;
         anchor1: PhysVector;
         frame1: PhysRotation;
         anchor2: PhysVector;
         frame2: PhysRotation;
         wakeUp?: boolean;
         userData?: unknown;
       }
     | {
         type: 'REVOLUTE';
         body1Id: number;
         body2Id: number;
         anchor1: PhysVector;
         anchor2: PhysVector;
         axis: PhysVector;
         wakeUp?: boolean;
         userData?: unknown;
       }
     | {
         type: 'PRISMATIC';
         body1Id: number;
         body2Id: number;
         anchor1: PhysVector;
         anchor2: PhysVector;
         axis: PhysVector;
         wakeUp?: boolean;
         userData?: unknown;
       }
     | {
         type: 'SPHERICAL';
         body1Id: number;
         body2Id: number;
         anchor1: PhysVector;
         anchor2: PhysVector;
         wakeUp?: boolean;
         userData?: unknown;
       }
     | {
         type: 'ROPE';
         body1Id: number;
         body2Id: number;
         length: number;
         anchor1: PhysVector;
         anchor2: PhysVector;
         wakeUp?: boolean;
         userData?: unknown;
       }
     | {
         type: 'SPRING';
         body1Id: number;
         body2Id: number;
         restLength: number;
         stiffness: number;
         damping: number;
         anchor1: PhysVector;
         anchor2: PhysVector;
         wakeUp?: boolean;
         userData?: unknown;
       }
     | {
         type: 'GENERIC';
         body1Id: number;
         body2Id: number;
         anchor1: PhysVector;
         anchor2: PhysVector;
         axis: PhysVector;
         axesMask: number;
         wakeUp?: boolean;
         userData?: unknown;
       };
   ```
   `PhysVector` is the existing vector type already used for e.g. `translation()` return values;
   `PhysRotation` should reuse whatever type `RigidBodyParams`' rotation field already uses
   (confirm exact name in `PhysicsAPITypes.ts` during implementation). `axesMask` is a plain
   bitmask `number`; define a local `JointAxesMask` enum mirroring Rapier's bit values (confirm
   exact values from `node_modules/@dimforge/rapier3d-compat/dynamics/impulse_joint.d.ts` during
   implementation) rather than importing `RAPIER.JointAxesMask` into app-facing code — consistent
   with how `RigidBodyTypeAPI` already decouples app code from raw Rapier enums.
4. **`JointAPI` covers creation, anchors, contacts, and (for Revolute/Prismatic only) limits and
   motor config** — not every method Rapier exposes (e.g. `frameX1()`/`frameX2()` orientation
   getters/setters are skipped as low-value for v1; see Non-goals). Representative shape (both
   `xSync()`/`x(): Promise<...>` variants throughout, matching `RigidBodyAPI`/`ColliderAPI`'s
   existing convention):
   ```ts
   export interface JointAPI {
     id: number;
     userData?: unknown;
     isValidSync(): boolean;
     isValid(): Promise<boolean>;
     body1IdSync(): number;
     body1Id(): Promise<number>;
     body2IdSync(): number;
     body2Id(): Promise<number>;
     anchor1Sync(): PhysVector;
     anchor1(): Promise<PhysVector>;
     anchor2Sync(): PhysVector;
     anchor2(): Promise<PhysVector>;
     setContactsEnabledSync(enabled: boolean): void;
     setContactsEnabled(enabled: boolean): Promise<void>;
     contactsEnabledSync(): boolean;
     contactsEnabled(): Promise<boolean>;
     // Revolute/Prismatic (UnitImpulseJoint) only — no-op/throw for other joint types:
     limitsEnabledSync(): boolean;
     limitsEnabled(): Promise<boolean>;
     setLimitsSync(min: number, max: number): void;
     setLimits(min: number, max: number): Promise<void>;
     configureMotorModelSync(model: JointMotorModel): void;
     configureMotorModel(model: JointMotorModel): Promise<void>;
     configureMotorVelocitySync(targetVel: number, factor: number): void;
     configureMotorVelocity(targetVel: number, factor: number): Promise<void>;
     configureMotorPositionSync(targetPos: number, stiffness: number, damping: number): void;
     configureMotorPosition(targetPos: number, stiffness: number, damping: number): Promise<void>;
     configureMotorSync(
       targetPos: number,
       targetVel: number,
       stiffness: number,
       damping: number
     ): void;
     configureMotor(
       targetPos: number,
       targetVel: number,
       stiffness: number,
       damping: number
     ): Promise<void>;
   }
   ```
   `JointMotorModel` mirrors Rapier's `MotorModel` enum as a local string union
   (`'ACCELERATION_BASED' | 'FORCE_BASED'`), same style as decision 3's `JointAxesMask` approach.
5. **New `PhysicsProtocolType.JOINT` numeric range: 800-999** (next free slot after `COLLIDER`'s
   600-799). Representative allocation (exact values may shift slightly during implementation,
   as long as they stay within range and don't collide with each other):
   `CREATE_JOINT = 800`, `CREATE_JOINTS = 801` (batch, mirrors `CREATE_RIGID_BODIES`/
   `CREATE_COLLIDERS`), `DELETE_JOINT = 802`, `DELETE_JOINTS = 803`, `JOINT_IS_VALID = 804`,
   `JOINT_BODY1_ID = 805`, `JOINT_BODY2_ID = 806`, `JOINT_ANCHOR1 = 807`, `JOINT_ANCHOR2 = 808`,
   `JOINT_SET_CONTACTS_ENABLED = 809`, `JOINT_CONTACTS_ENABLED = 810`,
   `JOINT_LIMITS_ENABLED = 811`, `JOINT_SET_LIMITS = 812`, `JOINT_CONFIGURE_MOTOR_MODEL = 813`,
   `JOINT_CONFIGURE_MOTOR_VELOCITY = 814`, `JOINT_CONFIGURE_MOTOR_POSITION = 815`,
   `JOINT_CONFIGURE_MOTOR = 816`, `JOINT_GET_USERDATA = 817`, `JOINT_SET_USERDATA = 818`. Add a
   `'JOINT'` branch to `physicsWorker.ts`'s `getSubType()` (`>= 800 && < 1000`) and a new
   `workers/physics/physicsSwitchJoint.ts`, following `physicsSwitchColl.ts`'s exact shape
   (resolve `jointAPI` from `data.jointId` via a new `engAPI.getJointAPIWithId(id)`, then one
   `case` per protocol member).
6. **`DeleteRigidBodyResponse` gains `jointIds: number[]`**, alongside the existing
   `colliderIds: number[]`, so `PhysicsAPI.ts`'s `deleteRigidBody`/`deleteRigidBodySync` can clean
   their local `joints` Map the same way they already clean `colliders`. `EngineRapier.ts`'s
   `deleteRigidBody` gathers these via a new `getJointAPI(jointOrHandle?: ImpulseJoint | number)`
   helper (mirroring the existing `getColliderAPI` handle-reverse-lookup helper) fed by
   `physicsWorld.impulseJoints.forEachJointHandleAttachedToRigidBody(rb.handle, ...)`, called
   before `physicsWorld.removeRigidBody(rb)`.
7. **No ECS component for joints.** Unlike colliders (owned 1:1 by a single entity, so they live
   as `ComponentType.COLLIDER` data on that entity), a joint connects two potentially-unrelated
   rigid bodies/entities, so it doesn't fit the existing "component on the owning entity" model
   cleanly. Joints are a pure `PhysicsAPI`-level object: app code calls `createJoint(params)` and
   holds onto the returned `JointAPI` itself, exactly like it already does for `RigidBodyAPI`/
   `ColliderAPI` before `PhysicsManager.createPhysicsEntity` wraps them for ECS convenience.
   `PhysicsManager.ts` needs no changes. (A `JointAPI` held across its rigid body's ECS-triggered
   deletion becomes stale — same expected behavior as a stale `ColliderAPI` today.)
8. **Physics test scene gets a wider ground plane, repositioned camera, ambient + shadow
   directional light, and lit+shadow-enabled materials**, following the `largeWorld` scene's
   proven pattern exactly (see Phase 2 below) — needed so the 7 new joint demos have room and are
   visually legible (shadows make swinging/sliding motion much easier to read than flat unlit
   shapes).

## Engine-side gaps to close first (Phase 1, additive/non-breaking)

- `Physics/PhysicsAPITypes.ts`: add `JointParams`, `JointAPI`, `JointAxesMask`, `JointMotorModel`
  types (decisions 3-4); extend `PhysicsProtocolType` with the `JOINT` range (decision 5); add
  `CreateJointResponse`/`DeleteJointResponse`/etc. via the existing `PhysicsResponse<T>` derivation
  pattern; add `jointIds: number[]` to `DeleteRigidBodyResponse` (decision 6); replace the
  commented-out `WorldAPI` joint stubs with real `createJoint`/`createJointSync`/`deleteJoint`/
  `deleteJointSync`/`getJoint`/`getAllJointEntries` declarations (decision 1).
- `Physics/EngineRapier.ts`: add `nextJointId` counter, `joints`/`jointAPIs` maps, `getJointAPI`
  helper (decision 6), `createJoint`/`deleteJoint`/`getJointAPIWithId`/`getAllJointIds` functions,
  an `EngineJointProxyAPI` class implementing `JointAPI` directly against the real Rapier
  `ImpulseJoint`; extend `deleteRigidBody` to reap attached joint ids before removal; extend
  `deleteWorld`/world-reset paths to clear the new maps too.
- `PhysicsAPI.ts`: add `joints` registry Map, `createJoint`/`createJointSync`/`deleteJoint`/
  `deleteJointSync`/`getJoint`/`getAllJointEntries` exports (`MAIN_THREAD`/`WORKER_THREAD`
  branching, mirroring `createCollider`/`deleteCollider` exactly), a `JointProxyAPI` class
  alongside `RigidBodyProxyAPI`/`ColliderProxyAPI`, and extend `deleteRigidBody`/
  `deleteRigidBodySync` to also clean the local `joints` Map from the response's new `jointIds`.
- `workers/physics/physicsSwitchJoint.ts` (new file): worker-side dispatch for the `JOINT` range,
  following `physicsSwitchColl.ts`'s template.
- `workers/physicsWorker.ts`: add `'JOINT'` to `getSubType()`'s range check and dispatch to
  `physicsSwitchJoint`.

Manual verification: with `?isDebug=true`, open the browser console and manually call
`createRigidBody`/`createJoint` for a couple of joint types via the exposed debug/global API (or
temporary test code), confirming creation succeeds and returns a `JointAPI` with a sane `id` in
both `MAIN_THREAD` and `WORKER_THREAD` (`AppConfig.physics.workerTarget`) modes, and that deleting
one of the two connected rigid bodies afterward doesn't throw and correctly drops the joint from
the local registry (verify via `getAllJointEntries()` before/after).

## Phases

**Phase 1 — Engine API additions.** Per "Engine-side gaps to close first" above. Purely additive;
no scene/behavior change yet, no existing consumer affected.

**Phase 2 — Physics test scene environment upgrade.** Non-breaking visual/content-only change to
`src/app/physicsTest.*`:

- Enlarge the ground box from `10×0.5×10` to roughly `50×0.5×50` (half-extents `hx=25, hy=0.25,
hz=25`) in both the mesh geometry and the matching `BOX` collider in `physicsTest.ts`.
- Add `src/app/lights/physicsTestSun.light.json` — `DIRECTIONAL`, `castShadow: true`,
  `shadowPreset: 'HIGH'` (or `'MEDIUM'`), position/target/`shadowCameraFrustum` sized to the new
  50×50 ground (e.g. position `(20, 30, 15)`, `targetPos (0, 0, 0)`,
  `shadowCameraFrustum [-30, 30, 30, -30]`, `shadowCameraNearFar [1, 80]`), directly modeled on
  `src/app/lights/largeWorldSun.light.json`. Tune `physicsTestAmbient.light.json`'s intensity down
  a bit (e.g. `0.8 → 0.4`) so the new directional light reads clearly, following `largeWorld`'s
  ambient/sun intensity ratio (`0.3`/`3`) as a rough reference.
- Add `"physicsTestSun"` to `physicsTest.scene.json`'s `lights` array.
- Switch the three existing bodies' materials in `physicsTest.ts` from `'BASIC'` to a lit material
  type (confirm exact identifier, e.g. `'STANDARD'`, in `materialSchema.ts`) and set
  `castShadow: true, receiveShadow: true` on their `createMeshEntity` calls, following
  `largeWorld.ts`'s existing `castShadow: true, receiveShadow: true` convention.
- Reposition `physicsTestCamera.camera.json` to frame the larger scene (e.g. position
  `(0, 18, 40)`, `lookAtPoint (0, 2, -6)`, `fov 65`, `far 120`) — adjust visually during manual
  verification.

Manual verification: `?isDebug=true`, load the physics test scene, confirm the ground is visibly
larger, the ball/box still fall and land correctly on it, the directional light casts a visible
shadow from both dynamic bodies onto the ground with no console/WebGPU errors, and the camera
frames the whole enlarged ground plane.

**Phase 3 — Joint showcase examples.** Add one worked example per joint type to `physicsTest.ts`,
using `PhysicsManager.createPhysicsEntity` for each body (so their transforms sync into ECS/
Three.js every frame per `APP_POST_PHYSICS`/`physicsToTransformSystem`) and reading each body's
`RigidBodyAPI.id` off its ECS component (per Context) to feed `createJoint`. Arrange the 7 demos
in a row (e.g. `z = -15`, `x` from `-21` to `21` in steps of `7`) on the enlarged ground, separate
from the original falling ball/box demo (shifted to e.g. `x = 0, z = 10` so it doesn't overlap):

- **FIXED** — a small static anchor body + a dynamic box rigidly locked to it (no relative
  motion).
- **REVOLUTE** — a static anchor + a dynamic box hinged on one axis, driven by
  `configureMotorVelocity` so the rotation is obviously visible (a spinning/swinging arm).
- **PRISMATIC** — a static anchor + a dynamic box constrained to slide along one axis, with
  `setLimits` bounding its travel (a sliding block oscillating between two limits under gravity).
- **SPHERICAL** — a static anchor + a dynamic ball/box swinging freely in multiple axes (visually
  distinct from Revolute's single-axis swing).
- **ROPE** — a static anchor + a dynamic ball connected by a `ROPE` joint with a fixed max length,
  demonstrating slack (distinct from the rigid Fixed/Spherical anchoring).
- **SPRING** — a static anchor + a dynamic body suspended by a `SPRING` joint, visibly oscillating
  (bouncing) due to `stiffness`/`damping`.
- **GENERIC** — a static anchor + a dynamic body with a `GENERIC` joint whose `axesMask` restricts
  motion to a deliberately different subset of axes than any of the above (e.g. free translation
  along one axis only, no rotation), to show the joint type most others are specializations of.

Manual verification: `?isDebug=true`, load the physics test scene, visually confirm each of the 7
demos behaves distinctly and as described (motor-driven spin, bounded slide, free swing, rope
slack, spring bounce, axis-restricted motion, rigid lock), with no console errors, in both
`MAIN_THREAD` and `WORKER_THREAD` `workerTarget` modes (and both `useSAB: true`/`false` under
`WORKER_THREAD`, per the existing convention of checking both transform-sync paths).

## Non-goals

- **Multibody joints** (Rapier's `MultibodyJointSet`/`createMultibodyJoint`) — tracked separately
  in `docs/plans/p250_physics-api-support-for-multibody-joints.md`.
- **ECS component representation for joints** — joints stay a pure `PhysicsAPI`-level object per
  Design decision 7; no `ComponentType.JOINT`.
- **Joint authoring via the scene/asset JSON pipeline** — physics objects (including joints)
  remain code-created only, consistent with the current state of rigid bodies/colliders
  (`.claude/CLAUDE.md`: "Physics objects are still created in code, not yet part of the
  scene/asset JSON schema").
- **Joint inspection/editing in the Physics debugger tab** (`_dbg__PhysicsAPI.ts`, tracked by
  `p022_physics-debugger-tab.md`) or debug-drawing of joints (`p025_debug-drawing-in-physics-api.md`)
  — natural future follow-ups once this API exists, out of scope here.
- **`frameX1`/`frameX2` orientation getters/setters** and other lesser-used `ImpulseJoint`
  methods beyond anchors/contacts/limits/motor — can be added later if a concrete need arises.
- **Any change to `AppConfig.physics` defaults or `workerTarget` behavior** — joints must work
  correctly under both `MAIN_THREAD` and `WORKER_THREAD` from day one, with no new config flags.

## Risks / open questions

| Risk / question                                                                                                   | Notes                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact `JointAxesMask`/`MotorModel` bit values/names                                                               | Mirror Rapier's `.d.ts` exactly during implementation; get this wrong and `GENERIC` joints silently misbehave. Low risk, easy to verify against `node_modules/@dimforge/rapier3d-compat`. |
| Reverse joint-handle→id lookup for rigid-body deletion cleanup                                                    | New `getJointAPI(jointOrHandle)` helper, same shape as the existing `getColliderAPI` helper — well-precedented, moderate implementation care needed.                                      |
| Exact lit-material identifier (`'STANDARD'` vs `'PHONG'` etc.)                                                    | Not yet confirmed by name; check `materialSchema.ts` at the start of Phase 2. Cosmetic risk only.                                                                                         |
| Visual layout/spacing of the 7 joint demos                                                                        | Cosmetic; adjust positions/anchors during Phase 3 manual verification, no functional risk.                                                                                                |
| WebGPU shadow shader pre-warm skip (`MeshManager.ts` `preWarm`) when no light has an initialized `shadow.map` yet | Noted by research as a pre-existing engine caveat (logs a warning, first real draw compiles instead) — shouldn't block correctness; confirm no new console errors appear in Phase 2.      |

## Verification

- Phase 1: manual console/API verification of joint create/delete in both thread modes (see
  Phase 1 above); `tsc --noEmit` and `yarn lint` clean.
- Phase 2: manual visual verification of the enlarged scene, shadows, and camera framing (see
  Phase 2 above); `tsc --noEmit` and `yarn lint` clean.
- Phase 3: manual visual verification of all 7 joint demos in both `MAIN_THREAD`/`WORKER_THREAD`
  modes (see Phase 3 above); `tsc --noEmit` and `yarn lint` clean.
- Per the repo's Stop hook, `tsc --noEmit`/`yarn lint` must stay clean after every phase.
