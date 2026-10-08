## Quick start

### Requirements

- Node.js `>= 22.13.0` (the repo's `.nvmrc` has the exact version) and Yarn `>= 1.22.15`.
- A browser with WebGPU: a recent Chrome, Edge or Safari, or Firefox with WebGPU enabled. Other
  browsers fall back to WebGL 2.

### Install and run

```bash
git clone https://github.com/JarSeal/threerapier.git my-game
cd my-game
yarn
yarn dev
```

The dev server runs at `http://localhost:8080`.

::: tip The debug suite
Open `http://localhost:8080/?isDebug=true` for the full debug tooling, then press `h` to open
the debug drawer.
:::

### Next

Drop some shapes onto the ground in the [physics example](hub:examples/physics).
