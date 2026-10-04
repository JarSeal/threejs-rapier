**Title:** `@gltf-transform/cli` installs the deprecated stub `@types/wrap-ansi@8.1.0` (via `@donmccurdy/caporal`), which fails `tsc` with TS2688 when `typeRoots` is set

Status: not filed yet
File at: https://github.com/donmccurdy/glTF-Transform/issues/new?template=bug_report.md (the `@donmccurdy/caporal` fork has had no activity since 2023, and the CLI is what pulls it in)
Category: Bug, Dependencies, Tooling
Found: 2026-10-04, adding `@gltf-transform/cli` 4.5.1 as a dev dependency (p300 Phase 1a), yarn 1.22.19, TypeScript 5.4.5
Our workaround: `"types": ["node"]` in `tsconfig.json`

Everything below the line is the issue body, in the repository's bug report template.

---

**Describe the bug**

`@gltf-transform/cli` depends on `@donmccurdy/caporal@~0.0.10`, which lists `"@types/wrap-ansi": "^8.0.1"` in its `dependencies`. The newest version in that range, `8.1.0`, is the deprecated stub package ("wrap-ansi provides its own type definitions, so you do not need this installed"). It has no `.d.ts` and no `types` entry.

Package managers that pick the newest version in a range (yarn 1 does; npm skips deprecated versions and installs `8.0.2`) hoist the stub to `node_modules/@types/wrap-ansi`. Then any project that sets `typeRoots` explicitly, eg. `"typeRoots": ["./node_modules/@types"]` (a common setup for adding a local `types` folder), fails to type-check, with `skipLibCheck` on or off:

```
error TS2688: Cannot find type definition file for 'wrap-ansi'.
  The file is in the program because:
    Entry point for implicit type library 'wrap-ansi'
```

With the default `typeRoots`, TypeScript skips the empty folder silently, which is probably why this only shows up for some setups. This is the error in #1152 (closed for lack of a reproduction), and likely the one in #1201.

`@donmccurdy/caporal` doesn't seem to need the package: its `dist/index.d.ts` doesn't reference `wrap-ansi`, and `wrap-ansi@8.1.0` (its runtime dependency) ships its own types.

**To Reproduce**

```sh
mkdir repro && cd repro
echo '{ "name": "repro", "version": "1.0.0", "private": true }' > package.json
yarn add -D typescript@5.9.3 @gltf-transform/cli@4.5.1   # yarn 1.22
echo 'export const x: number = 1;' > index.ts
echo '{ "compilerOptions": { "strict": true, "skipLibCheck": true, "noEmit": true, "typeRoots": ["./node_modules/@types"] } }' > tsconfig.json
npx tsc -p .   # TS2688, exit code 2
```

- `yarn why @types/wrap-ansi` shows `@gltf-transform/cli` → `@donmccurdy/caporal` → `@types/wrap-ansi@8.1.0`.
- The same happens with TypeScript 5.4.5.
- Without the `typeRoots` line, it passes.
- With npm instead of yarn 1, `@types/wrap-ansi@8.0.2` is installed and it passes.

**Expected behavior**

Installing the CLI doesn't add a type-only package that breaks a consumer's `tsc`. Possible fixes:

1. Remove `@types/wrap-ansi` from `@donmccurdy/caporal`'s `dependencies`, publish `0.0.11`, and bump the CLI's range.
2. Or, if the fork shouldn't be republished, pin the CLI's transitive version some other way. But (1) is the only fix that reaches consumers without action on their side.

**Versions:**

- Version: `@gltf-transform/cli` 4.5.1 (`@donmccurdy/caporal` 0.0.10)
- Environment: Node.js 22.13.1, yarn 1.22.19, TypeScript 5.4.5 and 5.9.3, Linux (WSL2)

**Additional context**

Workarounds for anyone who hits this:

- Restrict the global types in `tsconfig.json`: `"types": ["node"]` (or whatever the project needs).
- Or, with yarn 1, add `"resolutions": { "@types/wrap-ansi": "8.0.2" }` to `package.json`.

Possibly related clean-up in the same `package.json`: `@donmccurdy/caporal` also has `@types/glob`, `@types/lodash`, `@types/table` and an exact `@types/node@20.5.6` in `dependencies`, while its `index.d.ts` only references `node` types. Those packages are installed into every project that installs the CLI.
