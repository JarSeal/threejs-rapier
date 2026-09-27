// Stub only, not imported anywhere yet (so it can't end up in any bundle).
// TODO: implement navigator.getGamepads() polling + connect/disconnect event wiring,
// per-frame button/axis diffing, and a deadzone-aware axis query API. No call site
// wires this in yet — a future plan should cover full implementation.
//
// Research notes: the Gamepad API has no "button pressed" event — getGamepads() must be
// polled once per frame (a natural fit for an APP_PRE_PHYSICS ECS system) and diffed
// against the previous frame's button/axis snapshot to synthesize press/release-style
// callbacks. `gamepadconnected`/`gamepaddisconnected` *are* real events and should gate
// when polling starts/stops. Analog sticks need per-axis deadzone handling before mapping
// to movement. Chrome only reports a gamepad via getGamepads()/fires `gamepadconnected`
// after the user presses a button on it at least once (privacy restriction) — relevant
// for any future "press a button to start" prompt.
export const pollGamepads = (): void => {
  // TODO
};
