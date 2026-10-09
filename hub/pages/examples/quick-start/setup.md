## Requirements

- Node.js 22.13.0, the version in the repo's `.nvmrc`. With [nvm](https://github.com/nvm-sh/nvm),
  `nvm use` in the repo picks it (`nvm install` first if you don't have it).
- Yarn 1 (`>= 1.22.15`).
- A browser with WebGPU: a recent Chrome, Edge or Safari, or Firefox with WebGPU enabled. Other
  browsers fall back to WebGL 2.

## Install and run

```bash
git clone https://github.com/JarSeal/aekasha-js.git my-game
cd my-game
nvm use
yarn
yarn dev
```

The dev server runs at `http://localhost:8080`. Open `http://localhost:8080/?isDebug=true` for
the full debug tooling, then press `h` to open the debug drawer.

::: tip On a phone
A phone on your network needs a secure context for WebGPU and `SharedArrayBuffer`, which a plain
`http://` address isn't. `yarn dev:https` serves the app over HTTPS on port 8443 with a
self-signed certificate: open `https://<your computer's address>:8443/?isDebug=true` on the phone
and accept the certificate.
:::

::: dev-only

## Check your changes

```bash
yarn test               # unit tests (Vitest), about a second
yarn verify:baselines   # bundle sizes, API surface, JSDoc coverage
yarn verify:scenes      # every scene vs. your last good run
```

- `yarn test` runs the `*.test.ts` files next to the modules they test. The agents' Stop hook runs
  it after every change in `src/` or `devTools/`.
- `yarn verify:baselines` builds the app and diffs `devTools/verify/baselines/`. When a change
  grows a chunk, adds or moves an export or drops a folder's JSDoc coverage on purpose, record it
  with `--update` and commit the files with that change.
- `yarn verify:scenes` loads every scene in debug (with the physics worker over a
  `SharedArrayBuffer`, over messages, and on the main thread) and in prod test mode, and fails on
  console errors, a changed determinism hash or a snapshot that looks different. Its baselines
  are kept on your machine (`.cache/verify/scenes/`), because snapshots depend on the GPU: record
  them on `main` with `--update`, then run it on your branch. `--only <scene id>` and
  `--config quick` keep a run short; the full run takes up to an hour.

Both verify commands write to one log, which you can follow from any terminal:

```bash
tail -f .cache/verify/progress.log
```

:::
