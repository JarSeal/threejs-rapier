The engine's (`src/_engine/`) and the toolkit's (`src/toolkit/`) public API, generated from their
JSDoc: a page per module, with each export's signature, comment, parameters and a link to its
source. Exports without a JSDoc comment are listed too, marked "No description", and each folder
shows how much of it is documented.

The debug implementations behind `debug/*.ts` (the `_dbg__*` files) and the generated app data
aren't part of the API, so they aren't listed.

Good places to start are [`loadScene`](api:loadScene), [`createMeshEntity`](api:createMeshEntity),
[`createPhysicsEntity`](api:createPhysicsEntity) and [`ECSWorld`](api:ECSWorld). The search
(⌘K, Ctrl+K or `/`) finds every module, export and class member by name.
