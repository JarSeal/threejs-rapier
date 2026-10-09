Status: stub — not-implemented
Category: Networking
Blocked by: p510_headless-simulation-runtime.md (a server to talk to), p614_review-physics.md (the transport interface in front of `postMessage`)
Blocks: p512_client-prediction-and-reconciliation.md
Related: \_DONE_p604_multiplayer-viability-study.md (§3.1, §4.4-§4.7, Phase 1.3 the bandwidth measurements), p612_review-ecs-loop-config-init.md (the `appId` → entity map), p425_game-events-missions-and-save-games.md (serializable components, shared with save games), \_DONE_p346_spatial-domains.md and \_DONE_p352_physics-simulation-tiers.md (interest management), \_DONE_p603_gameplay-architecture-contracts.md (C4 the network brain, C5 recorded actions)

# Network Transport and Replication — Stub

**This is a stub.** It records the goal, what p604 measured and the open questions so the real
plan can be written after p510. Nothing here is a final design.

## Goal

Clients and an authoritative server exchange intents and state: clients send their actions or
intents stamped with the step index, the server simulates (p510) and sends snapshots of the
replicated entities, and clients render them interpolated a little in the past. A remote player
is a network brain (p603 C4) on the server and an interpolated entity on other clients.

## Grounding (2026-10-09, from p604)

- **The physics protocol is the model:** `STEP` carries the steps and the per-sub-step commands,
  replies match by `requestId`, poses come back in one batch per step. All 2,580 messages of p604's
  recording were plain data, which is why a recording, a Node replay and a network can carry them
  (p604 §4.5 keeps it so). p614 puts a transport interface (`send`, `onMessage`) in front of
  `postMessage`; a WebSocket and a WebTransport channel are implementations of it.
- **Bandwidth** (`physicsTiers`, 687 bodies, p604 Phase 1.3): full snapshots cost 4-18 Mbit/s per
  client at 60 Hz, so they aren't an option. Only the changed bodies, quantized to 12 B (16-bit
  position at 1/64 m, smallest-three rotation in 32 bits), at 20 Hz: 45 kbit/s mean, 62 kbit/s
  p95; a join's full state is 8 kB. Only ~3 % of the bodies change per step there because the tier
  policy freezes and removes the far ones.
- **Identity:** entity ids are per world; `appId` is the stable id (p604 §4.4), and p612 replaces
  `getEntityIdByAppId`'s linear scan with a map.
- **Interest management** has bases: spatial domains (per-domain grids a server can query per
  client) and the simulation tiers.

## Open questions

1. **Transport:** WebSocket first (works everywhere, TCP head-of-line blocking), WebTransport
   datagrams later, or both from the start behind p614's interface.
2. **What is replicated:** components marked serializable (p604 §4.7, shared with p425's save
   games), per entity or per component, and who marks an entity networked (a required `appId`).
3. **Snapshot encoding:** delta against the last snapshot each client acknowledged, the
   quantization per component (p604 measured 12 B and 17 B pose encodings), and a schema version.
4. **Interest management:** per-client spatial queries on a domain, the tiers as a replication
   priority, and what a client sees of an entity that leaves its interest.
5. **Interpolation:** the delay (two snapshots at 20 Hz is ~100 ms), extrapolation from velocities
   when a snapshot is late, and how it fits the engine's existing physics interpolation
   (`interpolationMode`).
6. **Input upstream:** actions (p610) or intents per step, redundancy against loss, and the
   server's input buffer per client.
7. **Server events** (p603 C7's game events) to clients: reliable and ordered, next to the
   unreliable snapshots.
