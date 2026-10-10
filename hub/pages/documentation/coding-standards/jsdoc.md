## JSDoc

The [API reference](hub:documentation) and the editor's hover text are built from JSDoc, so a
comment is written for someone who sees only the signature and the comment.

### The summary

Every export gets a summary. It says what the function does and what the signature can't tell:
when it's a no-op, what wins when calls overlap, what it registers or owns, and what happens at
the edges. Don't repeat the name ("Gets the sun direction") or the types.

```ts
/**
 * Registers a spatial domain in `world`, or new settings for one. Registering an existing id
 * with the same settings is a no-op; with different settings it replaces the domain's grid and
 * re-inserts its members (the cell size is baked into the grid's layout, so there is no cheaper
 * path). Members past a smaller `maxMembers` leave the domain.
 */
export function registerSpatialDomain(world: ECSWorld, opts: SpatialDomainOptions): void {
```

A field or a short constant can have a one-line comment: `/** Fixed steps the probe runs before
it freezes physics (2 s at 60 Hz) */`. State a default in the text, `(default 20)`.

A function that isn't exported gets a comment when its purpose isn't obvious from its name.

### Tags

| Tag | When | How |
| --- | --- | --- |
| `@param` | When the parameter needs more than its name and type: units, valid range, what `null` means | `@param geometryId a registered geometry (not a LOD level)`: the name, a space and the text, no hyphen, no type |
| `@returns` | When the result has cases: `null`, a remover, the argument it wrote into | `@returns the chain, or null when it was refused (warned)`; words first, since `@returns {@link X}` reads as a type |
| `@template` | A type parameter that needs explaining | `@template K a key of the debug state` (TypeDoc shows it as a type parameter) |
| `@example` | Every entry-point API: the functions an app calls first | A fenced `ts` block showing the call; imports are left out |
| `@remarks` | A trap the reader would hit: a three quirk, an order the caller must keep, a cost | After the summary and the tags it explains |
| `@internal` | Every export that isn't part of a public entry | An empty tag on its own line, the reason in the summary |
| `@deprecated` | An export that's going away | What replaces it, and the major that removes it |
| `{@link X}` | A reference to another export | Only for names TypeDoc resolves (our own exports); three's classes and outside names go in backticks |

```ts
/**
 * Generates a registered geometry's LOD chain: simplified levels registered as geometries
 * `${geometryId}#lod${n}`, with their triangle counts and errors. A chain the geometry already
 * has is replaced. A call while one is pending for the same geometry returns that one.
 * @param geometryId a registered geometry (not a LOD level, not skinned or with morph targets)
 * @param opts {@link LodChainOptions}
 * @returns the chain, or null when it was refused (warned) or the geometry was deleted meanwhile
 */
```

```ts
/**
 * The unit world direction toward a sun, into `out` (with day-night on, for the current time of
 * day, including a setTimeOfDay made this frame).
 * @returns `out`, or null (no active sky box, or no such sun)
 */
export const getSunDirection = (out: THREE.Vector3, i = 0) => {
```

```ts
/**
 * The registered stats sources, for the profiler.
 * @internal
 */
```

The lint (`eslint-plugin-jsdoc`, in `eslint.config.js`) checks the shape, as errors: tag names
(TypeDoc's included), a `@param` naming a real parameter (one property of a destructured or options
parameter as `opts.id`), an empty `@internal`, no types or hyphens in tags, no blank line between
the summary and the tags, the tags' order, an `@` word in prose in backticks, and a tag or summary
that only repeats its name. `yarn lint --fix` fixes the layout ones.

Whether an export has a summary is the docs ratchet's: `yarn verify:baselines --docs` fails when a
folder of the engine or the toolkit has more undocumented exports, or class and interface members,
than `devTools/verify/baselines/docs.json` records, and names each new one with its file and line.
A new folder starts at none. Deleting documented code passes, and so does documenting more. The
repo's Stop hook runs it after an engine or toolkit change, and `--update` records a grown count
only with `--allow-docs-drop`, so a drop is on purpose and shows in the file's diff.

### Types

- **Interfaces and object types:** a summary on the type, and a comment on every property a
  caller sets or reads. An options property says its default.
- **Union and protocol types** (the physics worker's messages): a summary on the alias saying what
  the union is for, and one on each member type.
- **Types inferred from a Zod schema:** a summary on the exported alias, and JSDoc on each key of
  the schema's shape. Both the editor's hover and the API reference show the inferred type's
  fields with those comments (a union's, as `CameraProps`'s, in a table per variant). An alias
  without a summary of its own shows the schema constant's. A field also authored in asset JSON files keeps a one-line
  `.describe()`, which is what the JSON editor's tooltip shows (the generated JSON Schema).

```ts
const CameraPerspective = CameraBaseProps.extend({
  type: z.literal('PERSPECTIVE'),
  /** Vertical field of view in degrees (default 45) */
  fov: z.number().optional().describe('Vertical field of view in degrees'),
});
// …
/** A camera's props, as `*.camera.json` files and `createCameraEntity` take them */
export type CameraProps = z.infer<typeof CameraProps>;
```

### Examples compile

An `@example` is code a developer copies, so it must type-check against the public API: the call
as written, with the entry's imports added. An example that only sketches an idea belongs in a
Hub page's prose, not in `@example`.
