## A viewport

```ts
const mapCamera = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 500);
mapCamera.position.set(0, 200, 0);
mapCamera.lookAt(0, 0, 0);

createViewport({
  id: 'minimap',
  scene: getRootScene(), // The game's own scene, seen from above
  camera: mapCamera, // Or a function, called every frame: () => getActiveCamera()
  anchor: 'BOTTOM_RIGHT',
  size: { width: '12rem', height: '12rem' },
  transparent: false,
  sceneId: 'myScene', // Deleted when the scene exits
});
```

- Each viewport renders into its own render target after the main render and the post effects,
  and a quad draws it over the frame. While no viewport is enabled, the cost is one check a
  frame.
- `scene` can be a private scene (a preview stage of its own) or the game's root scene. The game
  scene seen twice is rendered twice, shadow maps included: that cost is yours.
- `toneMapping: 'NONE'` (the default) keeps flat colours exact, for overlays; `'RENDERER'` uses
  the renderer's. `transparent` (the default) blends it over the frame.
- [`setViewportEnabled`](api:setViewportEnabled) shows and hides one, and
  [`deleteViewport`](api:deleteViewport) removes it.

## Placement

A viewport owns a slot element in a layer over the canvas, and draws where the slot is:

- **In a corner stack:** `anchor` (a corner) and `order` (0 in the corner, then outwards). The
  stacks have global classes (`aekViewportStack_BOTTOM_RIGHT`) for your SCSS, and `slotClass`
  gives the slot one of its own.
- **At a rect:** `rect` in pixels or `%` of the canvas.

The rect is measured again when the canvas resizes, a class on `<body>` changes, or a CSS
transition runs in the layer. Call [`invalidateViewportLayout`](api:invalidateViewportLayout)
after any other change that moves it.

## Pointer input

A viewport lets the pointer through to the game. `interactive: true` gives it the pointer
instead: the canvas and its controls don't see those events, and
[`getViewportPointerNDC`](api:getViewportPointerNDC) gives the pointer's position for a raycast
into the viewport's own scene.

The debugger's axes gizmo (`F10`) is an interactive viewport: with the debug camera, click a
bubble to align the camera to an axis, or drag it to orbit.

## Views

A view is what the whole canvas shows. The **Runtime** view is the game: the loaded scene and its
debugger. Editor views, such as the material editor, take over the canvas with a scene, a camera
and drawers of their own (see [Debug suite](hub:features/debug-suite#editor-views)).

- While an editor view is active, the game scene is suspended: no ECS stage runs, no scene
  looper, no physics step, and its time stands still. Physics resumes without catching up, so a
  visit to an editor keeps a scene deterministic.
- Viewports draw over whichever view is active.
- [`registerView`](api:registerView) adds one (its scene, its camera, and hooks for entering,
  leaving and every frame), and [`setActiveView`](api:setActiveView) switches.
- A debug tool that must run in every view adds itself with
  [`addViewFrameListener`](api:addViewFrameListener), and
  [`addViewChangeListener`](api:addViewChangeListener) hears every switch.

Only the debug build registers editor views so far.

## Key APIs

- [`createViewport`](api:createViewport), [`setViewportEnabled`](api:setViewportEnabled),
  [`deleteViewport`](api:deleteViewport) and [`getViewportPointerNDC`](api:getViewportPointerNDC).
- [`registerView`](api:registerView), [`setActiveView`](api:setActiveView) and
  [`isRuntimeViewActive`](api:isRuntimeViewActive).

## Read more

- The API reference: [Viewports](hub:documentation/engine/core/Viewports) and
  [ViewManager](hub:documentation/engine/core/ViewManager).

::: claude-md
:::
