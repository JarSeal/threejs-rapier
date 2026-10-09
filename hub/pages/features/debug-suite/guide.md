## Two debug modes

Both work in development and test builds only (`yarn dev`, `yarn build:test`), never in a
production build:

- `?isDebug=true`: every tool.
- `?isProdTest=true`: the app as it runs in production, plus a few tools: play and stop (`F5`),
  the loop switches (`F6`, `F7`), and the profiler (`F8`) when you enable it there.

Next to either, `?startScene=<scene id>` picks the first scene.

## The drawer

`h` opens the drawer. Its tabs cover the engine: stats, the main loop, the sky box, the debug
tools, physics, the renderer, assets, PostFX, ray casting, lights, cameras, characters, the ECS,
the spatial index and levels of detail. The drawer remembers its tab and each tab's settings in
localStorage.

Scenes and features add tabs of their own with one call,
[`createDebuggerTab`](api:createDebuggerTab): its content is declarative (Tweakpane bindings,
folders, buttons and lists), its settings can be kept over reloads, and a tab with a `sceneId`
exists only while its scene is loaded. The [debug tab example](hub:examples/debug-tab) builds one.

From the drawer, an entity opens in an edit window: lights, cameras, ECS worlds, PostFX passes,
physics entities, assets and characters. Several can be open at once, and they're kept over
reloads and scene changes.

## Keys

| Key          | Does                                                     |
| ------------ | -------------------------------------------------------- |
| `h`          | Opens and closes the drawer.                             |
| `u` / `i`    | The key shortcuts dialog: the app's keys / the engine's. |
| `o` / `p`    | Opens the camera list / the scene list.                  |
| `F1`         | Switches to the debug fly camera and back.               |
| `F5`         | Plays the scene in production test mode.                 |
| `F6` / `F7`  | Stops and starts the main loop / pauses the app.         |
| `F8`         | Opens the profiler.                                      |
| `F9` / `F10` | Shows the environment ball / the axes gizmo.             |
| `Ctrl/⌘ + Z` | Undo (with `Shift`: redo).                               |

`AppConfig.debugKeys` in `src/CONFIG.ts` rebinds them and adds your own.

## Profiler and GPU memory

`F8` (or the speedometer at the top of the screen) opens the profiler window:

- **Overview**: frame, GPU, physics and memory figures.
- **Objects**: what's in view and in total, with the heaviest objects.
- **GPU memory**: memory by category and by owner (each scene's assets), draw calls, a budget,
  and snapshots whose difference names what a scene visit left behind.
- **Settings**: among them, whether the profiler also loads in `?isProdTest=true`.

A closed profiler measures nothing. Your own figures join it with
[`registerStatsSource`](api:registerStatsSource), and your own GPU resources (a render target,
an instance buffer) get a name in the GPU memory tab with
[`registerGPUMemorySource`](api:registerGPUMemorySource).

## Undo and redo

Changes made in the debugger can be undone, from the buttons at the top of the screen or with
`Ctrl/⌘ + Z`. A tool of yours records its own actions with
[`recordUndoRedoAction`](api:recordUndoRedoAction) and applies them in the handler it registers
with [`registerUndoRedoActionHandler`](api:registerUndoRedoActionHandler).

## Editor views

The buttons at the top left switch the whole canvas to an editor view (see
[Viewports and views](hub:features/viewports#views)), with its own scene, camera and drawers. The game scene is suspended meanwhile (no systems, no physics) and goes on
exactly where it was when you switch back, so a visit to an editor keeps it deterministic.

The first editor is the **material editor**: every `*.material.json` material on a preview
ball, picked from a list, with its params and TSL inputs edited live. Each material's edits,
the stage and the camera are kept over reloads.

## Dev file server

While `yarn dev` runs, debug tools can write files into the repo: the LOD tab exports
impostors, and each example scene's Hub tab saves its Hub image. A tool can also add a scene's
overrides to an asset JSON's `__saveData`, stamped with the versions. A write is like saving the
file in your editor: the scene data is gathered again and the page reloads.

- [`writeDevFiles`](api:writeDevFiles) writes a batch, all or nothing.
  [`readDevFile`](api:readDevFile) reads one, and
  [`getDevFilesStatus`](api:getDevFilesStatus) tells whether this page can write.
- It writes only JSON and images, only under `src/app/`, `src/toolkit/` and `src/public/`, and a
  JSON of a known type is checked against its schema first.
- Only the server's own machine can write, with a token the server gives its page.
  `AEK_DEV_FILES_LAN=true` lets a phone on your network write too, and `AEK_DEV_FILES=false`
  turns it off.

::: dev-only

## Test bridge

`?aekTest=true`, next to `?isDebug=true` or `?isProdTest=true`, installs `window.__AEK_TEST__`, the
page side of `yarn verify:scenes`: it tells when the first scene is ready, waits for the
determinism probe, freezes the loops and takes a snapshot. It also runs a test clock, every frame
1/60 s, so what a page shows depends on how many frames ran, not on how fast the machine is. See
the [Quick start](hub:examples/quick-start#check-your-changes) for the commands.
:::

## Physics and characters

- Collider wireframes coloured by body state and simulation tier, ray helpers, and live body
  counts, in the Physics API tab.
- The determinism probe (see [Physics](hub:features/physics#deterministic-scene-loads)).
- A state window per character, with its live data, its configuration edited live, and in-world
  gizmos for what its controller measures (see
  [Characters](hub:features/characters#debugging-characters)).

## About and bug reports

The Æ button at the top left opens the About dialog: the engine, toolkit and app versions, the
build, the renderer and GPU, and the physics backend and thread. Its "Copy info" button copies
it all for a bug report.

## Key APIs

- [`createDebuggerTab`](api:createDebuggerTab), [`openDebuggerTab`](api:openDebuggerTab) and
  [`updateDebuggerTab`](api:updateDebuggerTab).
- [`addDebugToast`](api:addDebugToast): a short message on screen.
- [`toggleProfilerWindow`](api:toggleProfilerWindow),
  [`registerStatsSource`](api:registerStatsSource) and
  [`registerGPUMemorySource`](api:registerGPUMemorySource).
- [`recordUndoRedoAction`](api:recordUndoRedoAction) and
  [`registerUndoRedoActionHandler`](api:registerUndoRedoActionHandler).
- [`writeDevFiles`](api:writeDevFiles), [`readDevFile`](api:readDevFile) and
  [`getDevFilesStatus`](api:getDevFilesStatus).

## Read more

- The [debug tab example](hub:examples/debug-tab).
- The API reference: [debug](hub:documentation/engine/debug), the public entry points of the
  debug tools.

::: claude-md
:::
