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
