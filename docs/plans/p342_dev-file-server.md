Status: in progress | Phases 1-2 implemented
Category: Dev tooling, Debug
Blocks: p351_impostor-billboard-lod.md (Phase 4's export)
Related: p304_procedural-texture-baker.md (D5's PNG export), \_DONE_p085_material-editor-params-and-persistence.md (overrides that could go into the JSON), \_DONE_p069_character-live-config-editing.md, \_DONE_p300_asset-optimization-pipeline-plan.md (encodes what is written)

# Dev File Server

Lets debug tooling in the browser write files into the repo while `yarn dev` runs: an exported
impostor (its PNGs, `*.textureAtlas.json` and `*.impostor.json`), a baked texture, and later a
debug override saved into an asset JSON's `__saveData`. Today every such tool can only keep its
results in localStorage or download a file the developer then moves by hand.

The server is part of the Vite dev server (a dev-only plugin), not a separate process, and is
never in a build.

---

## 1. Grounding

- **The dev server is already a Node server we extend:** `sceneGathererPlugin`
  (`devTools/sceneGathererPlugin.ts`) and `crossOriginIsolationPlugin` (`vite.config.ts`) both hook
  `configureServer`. Nothing writes to the repo from the browser yet: there is no route under
  `server.middlewares` and no `__saveData` writer (the material editor's store is shaped so its
  overrides "can be written into the material JSON or its `__saveData` as it is",
  `_dbg__MaterialEditorStore.ts`).
- **Why not a separate server:** under `yarn dev:https` the page is `https://<LAN-ip>:8443`, so a
  second server would need its own certificate (mixed content otherwise) and CORS. It would also be
  a second process to start, and it couldn't coordinate with the gatherer (§2.5), which lives in
  Vite's process.
- **The dev server is on the LAN:** every `dev*` script runs `vite serve --host`.
- **Vite's host check doesn't cover our routes:** in Vite 6.4.3 a `configureServer` hook's own
  `middlewares.use` runs before Vite adds its CORS and host-check middlewares
  (`node_modules/vite/dist/node/chunks/dep-*.js`, `createServer`). So the plugin checks `Host`
  itself (§2.2), and its responses carry no CORS headers.
- **Writes set off the gatherer:** a file event on an asset JSON (`ASSET_JSON_SUFFIXES`) or a
  source an asset reads queues a pipeline run and a gather (debounced 100 ms, so a batch is one
  run). A gather ends in `server.hot.send({ type: 'full-reload' })`. Vite would reload anyway:
  `generatedAppData.json` is imported by `core/Scene.ts` and nothing accepts its update.
- **Schemas:** `gatherAppData.ts`'s `JSON_ENDING_SIGNATURES` maps suffixes to the Zod schemas the
  gatherer validates with.
- **Formatting:** Prettier 3.2.5 is enforced by ESLint (`.prettierrc`), so a written JSON must
  come out Prettier-formatted or `yarn lint` fails.
- **Found while writing this plan (§2.7):** `server.fs.strict: false` (`vite.config.ts`) with
  `--host` lets any LAN device read any file the user can read through `/@fs/<path>` (Vite's
  `fs.deny` still hides `.env`, `*.pem`, `*.crt`).

## 2. Design

### 2.1 Plugin and routes

`devTools/devFilesPlugin.ts` (`apply: 'serve'`), its parts in `devTools/devFiles/`. Routes under
`/__aek/files/`:

| Route         | Does                                                                                                                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET status`  | `{ enabled, writesFromLAN, roots }`, so a tool can grey out its save button                                                                                                              |
| `GET read`    | `?path=`: the file's bytes and its `sha256` (for `expectedHash`)                                                                                                                         |
| `PUT stage`   | a raw body (a PNG, never base64) into `.cache/dev-files/stage/`, returns `{ stageId, bytes, sha256 }`; staged files expire after 10 minutes and on server start                          |
| `POST commit` | `{ writes: [{ path, json \| stageId, expectedHash? }] }`: every write of a batch lands or none does (§2.3), returns per file `{ path, sha256, status: created \| updated \| unchanged }` |

Errors are JSON with a code: `NOT_ENABLED`, `BAD_TOKEN`, `BAD_ORIGIN`, `BAD_HOST`, `NOT_LOCAL`,
`FORBIDDEN_PATH`, `TOO_LARGE`, `CONFLICT` (with the current hash), `INVALID_JSON`,
`INVALID_SCHEMA` (with the gatherer's expanded issues), `STAGE_EXPIRED`.

No delete or rename in this plan.

### 2.2 Security

Two threats: another device on the LAN, and any website open in the developer's browser (a simple
`POST` to `localhost:8080` is sent without a CORS preflight; a DNS-rebinding page is even
same-origin).

- **Token:** a random 32-byte token per server start, injected into `index.html` by
  `transformIndexHtml` (a `<meta name="aek-dev-files">`). Every route but `status` needs it in an
  `X-Aek-Dev-Token` header. A cross-origin page can't read the HTML; a custom header also forces a
  preflight, which gets no CORS answer.
- **Host:** `Host` must be loopback (`localhost`, `127.0.0.1`, `[::1]`), one of the machine's own
  addresses or in `server.allowedHosts`. This stops DNS rebinding, which the token alone doesn't
  (a rebound page is same-origin and can read the token).
- **Origin:** when present, it must equal the request's own origin.
- **Writes from localhost only** by default: a request from a non-loopback address gets
  `NOT_LOCAL`. `AEK_DEV_FILES_LAN=true` allows the LAN (a phone under `dev:https`).
  `AEK_DEV_FILES=false` turns the routes off.

### 2.3 Path policy and writes

- **Paths** are relative to the repo root, `/` separated. After normalising they must be inside an
  allowed root: `src/app/`, `src/toolkit/`, `src/public/`, but never `src/public/aek-assets/` (the
  pipeline's outputs). Nothing in `src/_engine/` (the engine and its generated files), no dot
  folder, no `node_modules`. The nearest existing parent's `realpath` must still be inside the
  root, and a write never follows a symlink at the target.
- **Extensions:** `.json`, `.png`, `.jpg`, `.jpeg`, `.webp`. No code: a written `.ts` would be
  executed by Vite.
- **Size:** 32 MB per file, 128 MB per batch.
- **JSON:** the client sends a value, not text. The server serialises it and formats it with
  Prettier (`resolveConfig` for the target path), so the diff is what lint expects. A file with a
  gathered suffix is validated against its schema first, and the error lists the same issues the
  gatherer would.
- **Conflicts:** `expectedHash` is the hash the tool read; a different file on disk fails the
  whole batch with `CONFLICT`. `expectedHash: null` means "must not exist yet". Without it, the
  write overwrites.
- **A batch is all or nothing:** every file is written to a temporary file next to its target
  first, then each existing target is copied to `.cache/dev-files/backup/` and the temporaries are
  renamed into place. A failure before the renames removes the temporaries; a failure during them
  restores the renamed targets from the backups. Folders are created as needed.
- The server logs each commit (paths and statuses) in the terminal.

### 2.4 Client API (`debug/DevFiles.ts` → `core/Debug/_dbg__DevFiles.ts`)

The usual debug split: a thin public module that loads the `_dbg__` implementation only in the
debug env.

- `getDevFilesStatus(): Promise<DevFilesStatus>`: unavailable in production, without a dev server
  (`import.meta.hot` undefined) and when the routes are off or refuse this device.
- `writeDevFiles(writes, opts?)`: a write is `{ path, json }` or `{ path, blob }` (staged
  automatically), with an optional `expectedHash`. Resolves with the commit's result or rejects
  with a `DevFilesError` carrying the code and details.
- `readDevFile(path)`: `{ bytes | json, sha256 }`.
- `encodePNG(source)`: an `ImageData`, canvas or RGBA8 buffer to a PNG `Blob`
  (`OffscreenCanvas.convertToBlob`), for exporters that read pixels back from a render target
  (p351, p304).
- `onDevDataGathered(fn)`: the gatherer's result after a write (§2.5).

### 2.5 The gatherer after a write

A write is an ordinary file event, so the gatherer and the pipeline run as they do for an editor
save. That gives the exporters their whole loop: write the PNGs and JSONs → the pipeline encodes
the KTX2 → the gather → a reload with the new asset.

The client should know how it went before the reload: the gatherer sends a custom HMR event
`aek:gather` (`{ status: 'done' | 'failed', files, assetErrors }`) before the `full-reload`, and
`onDevDataGathered` delivers it. A save that leaves the page as it was (no reload) is out of scope
(§5, question 1): the engine's debug state already survives a reload (tabs, windows, views, camera
poses), which is enough for p351 and p304.

### 2.6 `__saveData` entries

CLAUDE.md asks every writer of save entries to stamp `engineVersion`, `toolkitVersion` and
`appVersion`. One server operation does it for every tool: a commit write
`{ path, saveData: { sceneId, entry } }` reads the JSON, puts `entry` first in
`__saveData[sceneId]` (the older entries after it), stamps `__meta` from `package.json`, and
validates and formats the result like any JSON write. No tool uses it in this plan; the material
editor's, sky box's and character config's "save to JSON" are their own plans.

### 2.7 `server.fs.strict`

Replace `fs.strict: false` with `fs.allow: [<repo root>]`: the root is `src/`, so `node_modules`
and `.tools/` are outside it, which is presumably why strictness was turned off. Phase 1 checks
that the app, workers, WASM and decoders still load on both backends. It's a read hole, not a
write, but it's the same threat (§2.2) and a one-line fix.

## 3. Phases

### Phase 1 — Server — done

§2.1-2.3 and §2.7: the plugin, the routes, the token, host and origin checks, the path policy,
staging, batch commits with rollback, Prettier, schema validation, conflicts.

**Exit:** a script run against `yarn dev` (no test framework: a `devTools/devFiles/selfCheck.ts`
run with tsx, which reads the token from `index.html`) passes every case: a JSON and a PNG batch
lands; an unchanged write reports `unchanged`; each refusal gets its code (no token, a foreign
`Origin`, a foreign `Host`, a LAN address without the opt-in, `../`, a symlink out of a root, a
`.ts`, `src/_engine/`, `aek-assets`, too large, an invalid `*.material.json`, a stale
`expectedHash`); a batch whose last write fails leaves every file as it was, also when the
failure is in the renames (forced by the script). `/@fs/` outside the repo is refused and the app
still loads on WebGPU and WebGL2.

As built:

- `GET status` also returns `canWrite` (this device may use the other routes), `deniedRoots`,
  `extensions`, `maxFileBytes` and `maxBatchBytes`.
- `GET read` answers with the raw bytes and the hash in an `x-aek-sha256` header, not JSON.
- Three more error codes: `BAD_REQUEST`, `NOT_FOUND` (`read` of a missing file, an unknown route),
  `WRITE_FAILED` (a failed batch, every file restored).
- A write whose bytes equal the file's is `unchanged` and isn't written: no file event, no gather.
  Commits run one at a time. The backups of the last 20 commits are kept in
  `.cache/dev-files/backup/<commit>/`, for undoing a write by hand.
- Schema validation is `validateGatheredJson` in `gatherAppData.ts` (the gatherer's schemas by
  suffix, a sky box's id defaulted to its file name as the gather does).
- The self-check: `npx tsx devTools/devFiles/selfCheck.ts` starts its own dev server on 8091 with
  `AEK_DEV_FILES_FAULTS=true`, which makes a commit honour an `x-aek-dev-fault: rename:<n>` header
  (the forced rename failures); `--url http://localhost:8080` runs against a running `yarn dev`
  and skips those. It writes into `src/app/__devFilesSelfCheck__/` and removes it.

### Phase 2 — Client API and gatherer event — done

§2.4 and §2.5: `debug/DevFiles.ts`, `_dbg__DevFiles.ts`, `encodePNG`, the `aek:gather` event, and
a "Dev files" row in the Debug tools tab (on, localhost only, off, unavailable).

**Exit:** from the browser, a debug-only call writes a `*.texture.json` with a PNG from
`encodePNG`; the pipeline encodes it, `onDevDataGathered` reports it, the page reloads and the
texture loads from its KTX2. A write in production and with `AEK_DEV_FILES=false` reports
unavailable.

As built:

- The protocol (route names, headers, the bodies, the `aek:gather` event) moved from
  `devTools/devFiles/protocol.ts` to `src/_engine/debug/DevFilesProtocol.ts`: the engine's public
  API needs its types, and imports go from `devTools/` to `src/`, never back. It has no imports,
  so Node loads it too.
- `getDevFilesStatus()` never rejects: `{ available: true, server }` or
  `{ available: false, reason, message, server }`, the reasons `NOT_DEBUG_ENV`, `NO_DEV_SERVER`,
  `UNREACHABLE`, `NOT_ENABLED`, `NOT_LOCAL`, `NO_TOKEN`. `DevFilesError` adds two client codes:
  `UNAVAILABLE` (not the debug env, no dev server, no token in the page) and `NETWORK`.
- `writeDevFiles(writes)` has no `opts`. `readDevFile(path)` resolves `null` for a missing file
  and always returns `bytes`, plus `json` for a `.json` path.
- `encodePNG(source, { flipY? })` encodes `ImageData` and RGBA8 buffers with its own encoder
  (`core/Debug/_dbg__PNGEncoder.ts`: libpng's filter heuristic, `CompressionStream` deflate), not
  `convertToBlob`: a canvas stores premultiplied alpha and loses a transparent pixel's colour,
  which an impostor atlas's dilation writes (p351). Canvases go through their own encoder.
- `aek:gather` carries `willReload` and, when `failed`, `message`. Every gather that wrote the
  generated data reloads the page, asset errors too (Vite reloads on the change of
  `generatedAppData.json`, which nothing accepts; the asset error overlay the gatherer shows
  doesn't survive it, which predates this plan). Only a `failed` gather keeps the page. `files`
  lists the changed files the run reacted to, so a new PNG that no asset reads yet isn't in it;
  a batch of `unchanged` files sets off no gather and no event.
- `onDevDataGathered(fn)` returns its remover. Vite's client handles the `full-reload` only after
  the listeners of the message before it settled, so the reload waits for `fn`'s promise (capped
  at 2 s).
- The gatherer ignores a commit's `*.aek-tmp` files (after a failed gather every added file
  queues a run).
- Phase 1 fix: chokidar reads a new folder before it watches it, so the files a commit renames
  into a folder it created were never reported (the read saw the temporaries). The commit returns
  them and the plugin emits `add` for each on `server.watcher`.
- The row's texts: `On (localhost only)`, `On (LAN too)`, `Off (AEK_DEV_FILES)` and
  `Unavailable (…)` with the reason. It asks the server on every mount of the tab.
- Testing from a page: after a gather the app runs the invalidated modules (`Scene.ts` and its
  importers) under `?t=` URLs, so an `import('/_engine/...')` from the test gets fresh copies of
  them; drive the UI instead.

### Phase 3 — `__saveData` writes

§2.6. **Exit:** an entry written into a test material JSON for one scene is applied by the gatherer
in that scene and not in another, stamped with the three versions; a second write puts its entry
first and keeps the first one after it.

### Phase 4 — Docs and versioning

1. CLAUDE.md: the Debug system section (the API, the security rules, the env vars), Commands
   (`AEK_DEV_FILES`, `AEK_DEV_FILES_LAN`).
2. `readme.md`: the env vars, if it lists dev settings.
3. p351 Phase 4 and p304 D5: write through `writeDevFiles` instead of downloading.
4. Versions and `CHANGELOG.md` (§4).

## 4. Versioning

Engine minor (a new public debug API, `debug/DevFiles.ts`). Project entry for the dev server
plugin. No toolkit or app change.

## 5. Open questions

1. **Saving without a reload:** the material editor saving into its JSON would rather keep the page.
   That needs the runtime to accept a new `generatedAppData.json` / `generatedAppFns.ts` in place
   (`import.meta.hot.accept` in `core/Scene.ts`, and whatever caches the data), and the gatherer
   to skip its `full-reload` for writes that ask for it. Its own plan, when a tool needs it.
2. **LAN writes by default?** Localhost only is the safe default; whoever works from a phone sets
   `AEK_DEV_FILES_LAN=true`. Revisit if that's the common case.
3. **Delete and rename:** needed once an exporter replaces a set of files whose names change (an
   impostor re-exported with fewer frames leaves stale PNGs). p351 Phase 4 decides whether it
   needs them (it could also write its frames into one folder per impostor and list it).
