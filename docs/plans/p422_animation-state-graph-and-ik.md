Status: stub — not-implemented
Category: Characters, Animation
Blocked by: p610_character-and-input-action-architecture.md (soft: the actor and controller contracts the graph reads)
Related: \_DONE_p603_gameplay-architecture-contracts.md (C6: this plan decides it), p421_kinematic-character-controller.md (both controllers report the same locomotion states), p250_physics-api-support-for-multibody-joints.md (ragdoll joints), p420_npc-simulation-tiers.md (cheaper animation per tier, `CROWD` vertex animation), \_DONE_p604_multiplayer-viability-study.md (root motion and determinism)

# Animation State Graph and IK — Stub

**This is a stub.** C6 in p603 is a direction, not a contract: it waits for the first animated
character. This plan is where it gets decided and built, against a real rigged model.

## Goal

An `ANIMATION` component with a state graph (states, transitions on the locomotion state and the
intent, blend spaces) driving three's `AnimationMixer`, then IK layers (foot placement on the floor
ray, look-at, hand targets). Ragdoll as a controller mode plus jointed bodies.

## The direction it starts from (p603 C6)

- Presentation side: runs at `APP_RENDER_SYNC`, in the `POSE_CONSUMERS` slot (after the
  interpolated pose, where the follow camera rig and the character gizmos are).
- It reads the simulation and never writes it. Root motion that moves the body is the exception
  this plan decides (§ Open questions 1).
- Ragdoll: `CharacterControlMode.PHYSICS_ONLY` exists with the getting-up path back; the jointed
  bodies are p250's.

## Grounding (2026-10-09)

- No `AnimationMixer` and no `SkinnedMesh` in engine, toolkit or app code (only the profiler census
  and the LOD window recognise skinned meshes).
- `LocomotionState` (10 states) is documented as "what a future animation-state system switches
  on", with `onLocomotionStateChange`; its listeners run inside the sub-step. A graph reads the
  state at `APP_RENDER_SYNC` instead.
- The character's visual can be any `Object3D`; the controller never reads it.
- LOD cross-fades skip skinned meshes (`_DONE_p351`), and impostors are static.

## Open questions

1. **Root motion and determinism** (p603 §7 risk 2): animation-driven movement in a deterministic
   simulation means the graph (or its root-motion track) runs per step in the simulation. Most
   networked games keep root motion off for remote actors.
2. **Authoring:** the graph as data (a `*.animGraph.json` asset type, gathered and validated) or as
   code first.
3. **IK:** three's `CCDIKSolver`, a two-bone solver of our own, or a library; how foot placement
   reads the floor ray (`CharacterController.probes`) without a cast of its own.
4. **Cost per tier** (p420): update rate by distance (Unreal's URO), and vertex animation textures
   for `CROWD`.
5. **Retargeting** between rigs, and the first rigged model the toolkit ships.
