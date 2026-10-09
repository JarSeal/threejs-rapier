## A character

[`createDynamicCharacter`](api:createDynamicCharacter) turns a visual (a mesh or a group) into a
character. The app's top-down test scene makes its player like this:

<<< src/app/scene_topDownTest.ts#dynamic-character

- `charData` tunes it: the `_` keys are its configuration (size, speeds, jump, slope limits), and
  the rest is its live state.
- `body` is its body plan: the colliders and how they're sized. The humanoid capsule is built in
  (`HUMANOID_CAPSULE`), with a crouching collider and the sensors the controller reads.
- `input` gives it keys. The bindings are the character's, and they're deleted with it.
- It resolves with the character, its live data and its intent. Deleting the character's entity,
  any way, deletes the character.

## Input schemes

| Scheme            | The keys                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `TANK`            | Turn left and right, and move along the facing.                                           |
| `WORLD_FIXED`     | Move north, south, west and east (8 directions with diagonals); it turns toward its move. |
| `CAMERA_RELATIVE` | Like `WORLD_FIXED`, with forward along the camera's view on the ground.                   |

Every scheme also has `jump`, `run` and `crouch`. `runMode` and `crouchMode` choose whether their
keys toggle or must be held.

## Driving it from code

The controller moves the character only by its intent, read once per physics step. Keys write
it; so can an AI, a cutscene or a network message, from an `APP_PHYSICS_STEP` system:

```ts
const { intent } = await createDynamicCharacter({ id: 'guard', visual: guardMesh });

world.addSystem(ECSSystemStage.APP_PHYSICS_STEP, 'guardBrain', () => {
  intent.moveForward = 1; // A move and a turn last one step: write them every step
  intent.turn = 0.5; // -1..1, positive turns left
  if (shouldJump) intent.jump = true;
});
```

`moveX` / `moveZ` move in world directions, `moveForward` and `turn` relative to the facing,
`faceYaw` turns it to face a direction, and `run` and `crouch` stay set until you change them.

## Its state

The controller reports what the character is doing as a locomotion state: `IDLE`, `WALK`,
`RUN`, `CROUCH`, `CROUCH_WALK`, `JUMP`, `FALL`, `SLIDE`, `TUMBLE` or `GET_UP`, for animations
and sounds. Listen with `onLocomotionStateChange` (an option of `createDynamicCharacter`) or
[`onLocomotionStateChange`](api:onLocomotionStateChange) by id.

[`setControlMode`](api:setControlMode) with `PHYSICS_ONLY` hands the body to physics, for a
ragdoll or a knock-back, and `CONTROLLED` takes it back.

## Debugging characters

The drawer's Characters tab lists them. A character's state window shows its live data, grouped
and formatted, with freeze and copy. Its configuration can be edited live, with undo, and is kept
over reloads per scene. Its gizmos draw what the controller decides from (velocity, facing, the
ground normal, the floor ray, the wall cast, a trail), and can be pinned to stay after the window
closes.

::: warning Not deterministic yet
Characters use the wall clock and random numbers, and in `WORKER_THREAD` mode asynchronous shape
casts, so a scene with characters doesn't simulate the same way on every visit (see
[Physics](hub:features/physics#deterministic-scene-loads)).
:::

The app's `thirdPersonGymScene` (an obstacle course with moving platforms, a player and a
character driven by code) and `topDownTestScene` (a `WORLD_FIXED` player among hills and props)
are the ones to try: open them with `?isDebug=true&startScene=<id>`.

## Key APIs

- [`createDynamicCharacter`](api:createDynamicCharacter) and
  [`deleteCharacter`](api:deleteCharacter).
- [`getCharacterById`](api:getCharacterById) and [`getCharacters`](api:getCharacters).
- [`setControlMode`](api:setControlMode) and
  [`onLocomotionStateChange`](api:onLocomotionStateChange).
- [`createCharacter`](api:createCharacter): the base a controller builds on, for writing your own.

## Read more

- [Physics](hub:features/physics), which characters are built on.
- The API reference: [Character](hub:documentation/engine/core/Character).
