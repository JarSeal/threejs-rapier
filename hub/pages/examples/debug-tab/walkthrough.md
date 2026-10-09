## The scene

The scene owns its settings, and builds the boxes from them:

<<< src/app/examples/debugTab/exampleDebugTab.ts#debug-tab-scene

- The tab is created only in the debug env, through a dynamic `import()`. A production build
  never loads the module, so neither the tab nor the Tweakpane it uses is in it.
- Debug-only modules start with `_dbg__`, as the engine's do. The prefix marks them as debug
  code, and the API documentation leaves them out.
- The tab is created before `buildBoxes`, because creating it loads the saved settings into
  `boxSettings`.

## The tab

<!-- prettier-ignore -->
<<< src/app/examples/debugTab/_dbg__exampleDebugTab.ts#debug-tab

- `sceneId` makes it a scene tab: it's removed when the scene exits, and the scene creates it
  again on its next visit. The drawer stays on it across a reload, once the scene has made it.
- `state` is the object the controls bind to: here the scene's own settings, so a control
  changes what the scene reads. `persistKeys` are saved under `lsKey` after each change and
  loaded back when the tab is created. Other keys are never saved.
- A control's `onChange` runs on user input only, never when the saved value is loaded, so it's
  where the scene reacts to the change.
- `lsKey` also gives the heading a button that clears the saved values, and `onClearLS` puts the
  scene back to its defaults.
- `refreshIntervalMs` and `onRefresh` run only while the tab is visible: a closed drawer
  doesn't refresh it.
- `content` is built again every time the tab is shown. Besides controls, buttons and
  separators, a pane can have folders, and a tab can have lists (`debuggerListCMP`).

[`openDebuggerTab`](api:openDebuggerTab) opens the drawer on a tab, and
[`updateDebuggerTab`](api:updateDebuggerTab) refreshes one from code.

Back to the [examples](hub:examples).
