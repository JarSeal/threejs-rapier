---
name: run-aekasha-js
description: Start, build, and drive the aekasha-js WebGPU/Three.js app (Vite dev server). Use when asked to run the app, start the dev server, take a screenshot of the scene, compare debug vs. production rendering, or check for WebGPU/console errors.
---

This is a Vite dev server serving a WebGPU/Three.js canvas. This skill ships its own minimal Playwright driver at `.claude/skills/run-aekasha-js/driver.mjs`: point it at a running dev-server URL and it navigates, waits for the scene to settle, captures console/page errors, and saves a screenshot.

All paths below are relative to the repo root.

## Checking every scene: use the scene runner, not this driver

To check that scenes still load without errors, render the same and simulate the same (after a refactor, before a PR), use the project's scene runner instead: `yarn verify:scenes` (see root `CLAUDE.md`, Commands). It grew from this driver: it starts its own dev server (port 8092), loads every scene (or `--only <sceneId|glob>`) through the dev-only test bridge (`?aekTest=true`, a real "scene ready" signal instead of a fixed wait), compares console errors, determinism hashes and snapshots with the last good run, and uses the WebGL fallback on WSL2 by itself. It runs for minutes to an hour: start it in the background and give the user `cd <repo root> && tail -f .cache/verify/progress.log` (root `CLAUDE.md`, Workflow: "Watching a long run"). `--config quick --only <id>` is the short loop. This driver stays the tool for a one-off screenshot or a look at one URL.

The project's `playwright-core` (a devDependency, for the runner) is pinned to this skill's version, so both use the Chromium this skill's setup downloaded.

## Setup (one-time per machine)

```bash
cd .claude/skills/run-aekasha-js
npm install
```

This installs `playwright-core` into this skill directory only (excluded from git via the repo's existing `**/node_modules` gitignore rule) - it does not touch the project's own `package.json`/`yarn.lock`.

## Build / start the dev server

```bash
yarn dev &
timeout 30 bash -c 'until curl -sf http://localhost:8080 >/dev/null; do sleep 1; done'
```

Don't `sleep N` - poll the port. Stop it with `lsof -ti:8080 -sTCP:LISTEN | xargs -r kill` before relaunching, or the next `yarn dev` hits the "port in use" fallback below and you'll drive the wrong port. The user could be running their own `yarn dev` which means that port is in use (see Gotchas).

## Run (agent path)

```bash
node .claude/skills/run-aekasha-js/driver.mjs <baseUrl> [urlSuffix] [outFile] [waitMs] [viewport WxH]
```

```bash
# Default (production-like) view
node .claude/skills/run-aekasha-js/driver.mjs http://localhost:8080 "" /tmp/scene.png

# Debug HUD/gizmos view - useful for comparing debug vs. production rendering
node .claude/skills/run-aekasha-js/driver.mjs http://localhost:8080 "?isDebug=true" /tmp/scene-debug.png

# Different aspect ratios (e.g. verifying camera/resize behavior) - viewport defaults to 1000x700
node .claude/skills/run-aekasha-js/driver.mjs http://localhost:8080 "" /tmp/portrait.png 6000 675x1200
```

The driver prints `[DRIVER] ...` progress lines followed by every browser console/page error it captured - **read that output, not just the screenshot.** This is a WebGPU app: a failed GPU init can render a blank canvas while the page itself "loads successfully," so a clean screenshot with no console errors is the actual bar, not just "the command exited 0."

Other query-param modes worth knowing about (see root `CLAUDE.md`): `?isDebug=true` (full debug tooling/HUD/gizmos) and `?isProdTest=true` (production-build behavior served from the dev server). Screenshotting the bare URL alongside `?isDebug=true` is a useful pattern for diagnosing bugs that only reproduce in one mode - that's literally how a real camera bug was found and fixed in this repo (debug mode created an extra camera entity first, shifting entity IDs and masking the bug).

When done:

```bash
lsof -ti:8080 -sTCP:LISTEN | xargs -r kill
```

## Run (human path)

```bash
yarn dev   # -> opens on http://localhost:8080 (or next free port). Ctrl-C to stop.
```

Append `?isDebug=true` or `?isProdTest=true` in the browser URL bar for the other modes.

## Build (production)

```bash
yarn build   # type-checks (tsc) + outputs to dist/
```

Not driven/verified by this skill - `driver.mjs` targets a dev-server URL. To screenshot a production build, serve `dist/` (e.g. `npx serve dist`) and point the driver at that URL instead.

## Gotchas

- **Port 8080 already in use -> Vite silently moves to 8081+.** If another `yarn dev` is already running (including one a human started outside this session), a second one prints `Port 8080 is in use, trying another one...` and serves from 8081 instead. Check the actual `Local: http://localhost:PORT` line in the server's output before assuming 8080 - don't hardcode it.
- **No "scene fully loaded" signal in this driver.** Physics init, asset loading, and WebGPU pipeline compilation all happen after `domcontentloaded`. The test bridge's `window.__AEK_TEST__.whenSceneReady()` (`?aekTest=true` with `?isDebug=true` or `?isProdTest=true`) is that signal, which the scene runner uses; this driver doesn't, and uses a fixed wait (default 6000ms, override with the 4th CLI arg) as an approximation - if a screenshot shows the loading overlay, increase it.
- **Editing a `*.camera.json`/`*.scene.json`/etc. asset file and immediately screenshotting can catch a transient `[plugin:vite-plugin-scene-gatherer] Consolidation Failed` HMR error overlay.** This clears itself on the next successful regeneration a moment later - it's a race between the file write and the dev server's own `sceneGathererPlugin` watcher, not a real bug. Wait 2-3s after saving an asset JSON file before driving/screenshotting, or just retry once.
- **WebGPU needs explicit Chrome flags.** Without `--enable-unsafe-webgpu --enable-features=Vulkan`, Chrome stable on macOS silently fails WebGPU init and the canvas stays blank with no thrown error - it just never paints. The driver already passes these. If you still get a blank canvas on Linux/WSL2, try adding `--use-angle=vulkan`, or as a software-rendering fallback (slow, no real GPU needed) `--use-gl=swiftshader --use-angle=swiftshader`.
- **`playwright-core` (not `playwright`) is intentional** - it's a much smaller install because it doesn't bundle browser binaries; the driver points it at the machine's already-installed Chrome/Edge instead (see Troubleshooting if none is found).
- **WSL2: headless WebGPU can't render - use `DRIVER_WEBGL=1`.** Verified on WSL2 (Ubuntu, playwright-managed Chromium): with the default flags every frame is black with hundreds of `createBuffer failed, size (...) is too large for the implementation` / `Instance dropped in popErrorScope` page errors, and with a SwiftShader WebGPU adapter (`--use-webgpu-adapter=swiftshader`) the frame stays white with no errors at all - both on an unmodified `main` too, so it's the environment, not the app. `DRIVER_WEBGL=1 node .claude/skills/run-aekasha-js/driver.mjs ...` hides `navigator.gpu` so the engine falls back to WebGL2, rendered by SwiftShader, which works (use a 30000ms+ wait, software rendering is slow). It compiles the same TSL node graphs to GLSL instead of WGSL, so it verifies materials/scenes but not WebGPU-specific behavior - have a human check that in a real browser. Browser detection found no system Chrome on WSL2 and fell back to playwright-managed Chromium, which worked.

## Troubleshooting

- **`[DRIVER] no system browser found for this platform, falling back to playwright-managed Chromium` followed by a launch error**: `playwright-core` only drives browsers, it can't download them. Fix: `npm install playwright` (the full package, in this same skill directory) instead of `playwright-core`, then run `npx playwright install chromium` once, and change the driver's `import { chromium } from 'playwright-core'` to `'playwright'`.
- **`EADDRINUSE` / driver connects to the wrong scene state**: a stale `yarn dev` is still running on the port you expect. `lsof -ti:8080 -sTCP:LISTEN | xargs -r kill` before starting a new one.
