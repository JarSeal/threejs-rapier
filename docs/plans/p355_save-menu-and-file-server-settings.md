Status: draft | not-implemented
Category: Debug, Dev tooling
Related: \_DONE_p342_dev-file-server.md (builds on it: the routes, `writeDevFiles`, save entry
writes, the "File server" folder; this plan is its §5 question 4), \_DONE_p085_material-editor-params-and-persistence.md
(the material overrides this plan saves), p150_current-entity-data-source-info-on-edit-windows.md
(origin info on the same camera and light data)

# Save Menu and File Server Settings

The debug tools keep every edit in localStorage: a light's colour, a sky box layer, a PostFX
pass, a material in the material editor. Nothing writes those edits back to the asset JSONs,
so a developer copies values by hand. p342 gave the browser a way to write files and `__saveData`
entries; this plan uses it:

- **The Æ menu:** the Æ button opens a menu with "Save scene" (Ctrl+S), "Save specific data…"
  (Ctrl+Shift+S) and "About Ækasha". "Save scene" saves the current scene's changes and the
  global ones in one write. "Save specific data…" lists them, and the other scenes' changes,
  with a checkbox each.
- **File server settings** (p342 §5 question 4): a toast with how a write's gather went,
  confirming writes before they land, the server's backup count, and an author stamp in save
  entries.

---

## 1. Grounding

- **The Æ button** (`core/Debug/_dbg__OnScreenTools.ts` ~l.455) opens the About dialog
  (`openAboutDialog`, `_dbg__About.ts`) directly. It's in the top left group, debug env only
  (prod test mode has no such group), and stays visible in editor views.
- **`createDropDown`** (`core/UI/DropDown.ts`) is a select: a trigger with a label and caret, a
  current value, `{ value, label }` options. It has the list behaviour a menu needs (keys, focus,
  click outside, its keys reach no binding) but no icon-only trigger, item hints, disabled items
  or separators.
- **Key bindings:** undo/redo (`core/Input/DefaultDebugKeyBindings.ts`) are `KEY_DOWN` with Ctrl
  and ⌘ chords and `preventDefault`, the pattern Ctrl+S needs (the browser's "Save page as").
- **Dialogs:** `openDialog` (`core/UI/DialogWindow.ts`) with `closeOnEscape`. `core/UI/` has no
  checkbox list; `debuggerListCMP` (`_dbg__DebuggerList.ts`) has rows with icon toggles.
- **p342's write side:** `writeDevFiles` (`debug/DevFiles.ts`) commits a batch all or nothing; a
  `saveData` write puts its entry first in `__saveData[sceneId]`, stamps `__meta` and keeps
  `getDevFilesSaveHistorySize()` entries. It replaces, it doesn't merge: the new entry must
  carry everything the latest one had. Each batch is one gather and one page reload. The
  server keeps the last 20 commits' backups (`BACKUPS_KEPT`, `devTools/devFiles/commit.ts`).
- **`MetaSchema`** (`schemas/_saveDataSchema.ts`) has `author` commented out.
- **`vite.config.ts`** reads git with `execSync` and gets '' without git.

### What the debug tools keep (localStorage)

| Store                                                      | Asset                         | Scope             | Stored as                                                                                                                    | Saves into                                                        |
| ---------------------------------------------------------- | ----------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `AEK_debugSkyBox` (`_dbg__SkyBoxShared.ts`)                | `*.skybox.json`               | scene, sky box id | deviation-only `SkyBoxOverrides`, a delta over the def **with the latest entry merged in**                                   | `__saveData`, no conversion                                       |
| `AEK_debugPostFx` (`_dbg__PostFX.ts`)                      | `*.postFx.json`               | scene, pass id    | deviation-only `{ enabled?, params? }` over the authored snapshot (latest entry included)                                    | `__saveData`, no conversion                                       |
| `AEK_debugCams` (`Camera/_dbg__CameraGUI.ts`)              | `*.camera.json`               | scene, appId      | full values (every edited key), plus UI keys (`helperVisible`, `_lensSettingsOpen`) and `debugCam`                           | `__saveData`, strip and diff                                      |
| `AEK_debugLights` (`Light/_dbg__LightGUI.ts`)              | `*.light.json`                | scene, appId      | full values, plus UI keys and `globalHelpersVisible`; colours as hex numbers; every record has `enabled: true`               | `__saveData`, convert and diff                                    |
| `AEK_debugMatEditorMat_<id>` (`_dbg__MaterialEditorStore`) | `*.material.json`             | **global**        | deviation-only `overrides: { params, nodes }` against the raw material JSON (plus editor `settings` and `camera`, not saved) | `__saveData` of the current scene, if its JSON lists the material |
| `AEK_debugPostFxSettings` `postFxEnabled[sceneId]`         | scene JSON `postFxEnabled`    | scene             | deviation-only boolean                                                                                                       | scene `__saveData` (Phase 7)                                      |
| `AEK_debugSpatialGrid` `domains[id].cellSizeByScene`       | scene JSON `spatialDomains[]` | scene             | full value                                                                                                                   | scene `__saveData` (Phase 7)                                      |
| `AEK_debugCharConfig`                                      | none (characters are code)    | scene, character  | deviation-only                                                                                                               | not saved (characters come later)                                 |

Not saved (config or tool settings, CONFIG.ts is code): renderer options, physics world
settings, world-scope spatial cell size, PostFX `measureEnabled`, every UI state key. Nothing
persists edits of meshes, geometries, textures, imported assets or LOD.

- **Source files:** `getGeneratedAppData()` (dev data) keeps the registries (`cameras`, `lights`,
  `materials`, `skyboxes`, `postFx`, …) with `__sourcePath` and every `__saveData`. Cameras and
  lights are keyed by appId. A camera, light or sky box made in code, or written inline in a
  scene JSON, has no file of its own.
- **A material's entry is applied only through a scene JSON's `materials` list** (the gather
  resolves each listed id with that scene's entry, ~l.1347). In the dev data:
  `sceneTestECS` lists `testMaterial`, `checkerBoard`, `testTslMat`; the gyms the two triplanar
  ones; `space` `asteroid`; the other scenes none.
- **Scene JSONs** have neither: the gather merges a scene's latest entry and sets `__sourcePath`
  only on its internal list (`gatherAppData.ts` ~l.533), and the output pass re-reads the raw
  file (~l.1133). So a scene's own `__saveData` is validated but never applied.
- **Undo/redo** names the asset of most actions (appId, skyBoxId, postFxPassId, materialId and the
  scene's bucket), but is trimmed, drops its redo tail and misses some edits (helper toggles, the
  cell size): not a changes list.

## 2. Design

### 2.1 Save sources

`debug/SaveData.ts` → `core/Debug/_dbg__SaveData.ts`, the usual split. Each debug module that
keeps asset edits registers a source at module load:

```ts
registerSaveSource({
  id: 'skyBox',
  label: 'Sky boxes',
  /** Every unsaved change, of every scene in localStorage and every global one */
  collect: () => SaveChange[],
  /** After the commit: drop what was saved from localStorage */
  onSaved: (changes: SaveChange[]) => void,
});

type SaveChange = {
  id: string; // unique per source, eg. `${sceneId}:${skyBoxId}`
  label: string; // 'Sky box "dayNight"'
  scope: 'SCENE' | 'GLOBAL';
  sceneId?: string;
  /** Repo-relative; null with `unsaveable` when there's no file */
  path: string | null;
  unsaveable?: string; // why: 'made in code', 'not in this scene', 'id taken by <path>'
  /** An inline asset's extraction (§2.6): the new file and the scene JSON's edit */
  extract?: { newPath: string; scenePath: string };
  /** What changed, for the dialog: 'atmosphere.turbidity, suns.0.elevation' */
  summary: string[];
  /** Builds the write from the file as it is now (read just before the commit) */
  build: (file: { json: unknown }) => { saveData: DevFilesSaveData } | { json: unknown };
};
```

- **Fresh reads:** saving reads every target with `readDevFile` and passes its hash as
  `expectedHash`, so a file edited since makes the batch fail with `CONFLICT` instead of losing
  that edit.
- **Merged entries:** a scene change builds its entry from the file's latest
  `__saveData[sceneId][0]` with the debug delta merged in, by its type's merge rule (the
  gatherer's: flat for cameras and lights, `params` and `nodes` one level deeper for materials
  and PostFX, deep for sky boxes, where a whole list replaces). Then it drops every value that
  equals what the asset gives without the entry, so entries hold only real overrides. An entry
  left empty isn't written.
- **Global changes** write into the asset's own values (a `json` write of the file with the
  keys set), not `__saveData`: they aren't bound to a scene. The scope is in the API for later
  sources; no source in this plan has one.
- **Materials (for now) save only into the current scene, and only the ones it lists.** The
  material editor's edits aren't bound to a scene, but its source reports them as changes of
  the current scene: one per material in the scene JSON's `materials` list, saved as that
  scene's `__saveData` entry (its latest entry with the editor's `params` / `nodes` merged in,
  one level deep), so the save shows where the gather applies it. A material the scene doesn't
  list is Not saveable ("not in this scene") and keeps its editor changes; it's never in
  "Other scenes" either. Later the material editor will edit only the current scene's materials
  (and import one into the scene), its own work; then this rule just holds.
- **One write per file:** a batch takes each path once. Changes to the same file are folded
  into one write (two entries for one scene are merged). A file that would need both a
  global and a `__saveData` write fails the collect with a message (no source does that now).
- **After a commit** each source's `onSaved` removes the saved values from localStorage before
  the reload: the JSON has them now. Cameras and lights keep their UI keys. Undo history is kept:
  undoing a saved edit makes it an unsaved change again.
- **Inline assets** (a camera, light or sky box written in a scene JSON) are saved by moving them
  into a JSON file of their own (§2.6), not as Not saveable.
- **Characters** aren't saved: no source, not listed (their saving comes with the later character
  work; the state window's "Copy changes" stays).
- **What's saved:** "Save scene" saves the current scene's saveable changes and every global
  one. Unsaved material edits it can't save (materials not in the scene) get a warning toast
  naming them: 'Not saved: "rock", "bark" aren't in this scene's materials (they keep their
  editor changes)'. Other scenes' changes stay. In an editor view the scene is the suspended
  runtime one.

### 2.2 The Æ menu

The Æ button opens a menu (title "Ækasha menu") instead of the About dialog:

| Item                | Hint         | Does                |
| ------------------- | ------------ | ------------------- |
| Save scene          | Ctrl+S       | §2.1, at once       |
| Save specific data… | Ctrl+Shift+S | the dialog (§2.3)   |
| (separator)         |              |                     |
| About Ækasha        |              | `openAboutDialog()` |

- **Menu mode for `createDropDown`:** `variant: 'MENU'`. The trigger is the caller's
  `triggerHtml` (the Æ icon, no label or caret), there's no current value, and items take
  `hint` (right-aligned text), `disabled` (with a `title` saying why) and `separatorBefore`.
  ARIA roles `menu` / `menuitem`. Arrow keys skip disabled items. The select behaviour stays the
  default.
- **Disabled save items**, with the reason as their title, read when the menu opens:
  - **Saving disabled** disables both: the dev files unavailable (the `getDevFilesStatus`
    reason) or the save history size 0 (saving off, p342). 0 turns off every save of the menu,
    also a later global one that writes no `__saveData`: one rule, "0 = saving off", is easier
    to trust than one per kind of write. Revisit when the first global source comes.
  - **Nothing saveable in this scene** (and no global change) disables "Save scene". "Save
    specific data…" stays on while another scene has a saveable change, and is disabled when
    no scene has one.
- **While saving**, the Æ icon turns into a spinner and the menu is disabled (an open list
  closes, the trigger can't open it, its title says "Saving…"):
  - It starts when a save starts (the collect and the file reads) and ends when the commit
    fails, or when nothing was written (every file `unchanged`: no gather follows). After a
    commit that wrote files it stays until the reload; if the gather fails instead (the
    `aek:gather` event with `failed`, no reload), it ends then. A 30 s timeout ends it if no
    event comes (a dev server restarted meanwhile).
  - The save keys do nothing meanwhile but a toast ("Saving…"), so a held or repeated Ctrl+S
    is one save.
  - The spinner is a new `spinner` icon (`core/UI/icons/`), turned by CSS; with
    `prefers-reduced-motion` it doesn't turn but pulses its opacity.
  - `createDropDown` gets `setDisabled(disabled)` on `TDropDown` (today `disabled` is fixed at
    creation): it updates the trigger's `disabled` and closes an open list.
- **Keys:** `sc-save-scene` (Ctrl+S, ⌘S) and `sc-save-specific` (Ctrl+Shift+S, ⌘⇧S),
  `KEY_DOWN`, category `DEBUGGER`, rebindable through `debugKeys`. They always
  `preventDefault` (the browser's save dialog is never wanted), also in a text field: they blur
  it first, so a typed Tweakpane value is committed before the collect. A key on an unavailable
  save (disabled, by the same rules) shows the reason as a toast. They work in every view.

### 2.3 "Save specific data…" dialog

`openDialog` with `closeOnEscape`, id `aekSaveSpecific`:

- Grouped rows, each group with a heading checkbox for its rows:
  - **This scene** (`<scene name>`), checked by default;
  - **Global** (empty in this plan, not shown), checked by default;
  - **Other scenes**, a sub-heading per scene (its name, else its id), unchecked by default:
    the changes localStorage keeps for scenes visited before (sky boxes, PostFX, cameras,
    lights, scene JSON entries). A scene that no longer exists in the generated data is Not
    saveable ("scene not found");
  - **Not saveable**: greyed, no checkbox, with the reason (made in code, a material not in
    this scene, an inline asset whose new file or id is taken).
- An inline asset's row says what its save does: "moves to `src/app/skyboxes/topDownTestSky.skybox.json`"
  under its path.
- A row: a checkbox, the label, the file path and the summary (the changed keys, folded after
  five).
- Buttons: **Check all**, **Uncheck all**, **Save (n)** (disabled at 0) and **Cancel**.
- While its save runs, the Æ spinner shows (§2.2) and the dialog's buttons and checkboxes are
  disabled.
- Save commits the checked changes as one batch, as "Save scene" does. Another scene's entry is
  built the same way, from that file's latest entry for that scene; the delta it merges was
  measured against the same entry (the debug tools diff against the def with the scene's
  entry applied). The dialog stays open
  on an error (the code and message under the buttons), and closes on success (the reload
  follows).
- It's its own confirmation: a confirm-writes dialog (§2.4) isn't shown after it.

### 2.4 File server settings

All in the "File server" folder (Debug tools tab) with a CONFIG default, as the save history size
(`AppConfig.devFiles`, overridden per browser by `debugToolsState.devFiles`, saved only once
changed):

1. **Gather toasts** (`gatherToasts`, default true): after a write from this page, a toast with
   how its gather went. `writeDevFiles` remembers the paths it wrote for 60 s; an
   `aek:gather` event whose `files` has one of them is this page's.
   - `done`: the reload comes next, so the listener writes a note to sessionStorage
     (`AEK_devFilesGatherNote`; the reload waits for the listener, p342 Phase 2) and the debug
     init shows the toast after the reload: "Saved 4 files" with the list, a warning with the
     asset errors when there are some.
   - `failed`: an alert toast at once with the message (no reload; the overlay shows).
   - Gathers set off by an editor save stay as they are (no toast).
2. **Confirm writes** (`confirmWrites`, default false): `writeDevFiles` first asks the server for
   a dry run (`POST commit` with `dryRun: true`: every check, no write; per file its status and
   current hash), shows the files with created / updated / unchanged in a dialog, and commits
   only on Confirm, with the dry run's hashes as `expectedHash` (what was confirmed is what's
   overwritten). Cancel rejects with the client code `CANCELLED`. Every tool's writes go through
   it, the save menu's too; the "Save specific data…" dialog skips it.
3. **Backups kept:** a server setting, so an env var: `AEK_DEV_FILES_BACKUPS` (commits, default
   20; -1 keeps all, 0 keeps none: a commit's backups are removed once it landed, a failed one
   still restores from them). `GET status` gets `backupsKept` and `backupDir`; the folder shows
   them read-only.
4. **Author stamp:** the server stamps `__meta.author` in every save entry with git's
   `user.name` (`git config user.name` in the repo, read on each commit with `execFile`, so a
   change applies at once). Without git, outside a repo, or with no `user.name` set, `author` is
   undefined: the key is left out, also when the entry had one (the server's stamp always wins,
   as with the versions). `MetaSchema` gets `author: z.string().optional()`. `GET status` gets
   `author` (null when undefined) and the folder shows it ("none (git user.name not set)").

### 2.5 Scene JSON entries (Phase 7)

To save `postFxEnabled` and a scene's spatial domain cell size, the gatherer has to apply a
scene's own `__saveData[sceneId][0]` in its output pass, and keep `__sourcePath` on the scene
in dev data (production keeps neither). The cell size becomes a `spatialDomains` entry
(`{ id, cellSize }`, merged by id into the latest entry's list). A gatherer fix, so applying an
existing scene entry is a visible change: none of the app's scenes has one today.

### 2.6 Inline assets to JSON files (Phase 8)

A camera, light or sky box written inline in a scene JSON (`cameras` / `lights` / `skyboxes`
entries that are objects, not ids) has no file for a `__saveData` entry, and the gather ignores
an inline asset's own `__saveData`. Saving its changes moves it out:

1. **The new file:** `src/app/<cameras | lights | skyboxes>/<id>.<camera | light | skybox>.json`
   (the app's folders for them), with the inline object as it is (its `$schema` relative to the
   new place) and the changes as its `__saveData[sceneId]` entry. The id is the sky box's `id`,
   the camera's or light's `appId` (an inline one without an appId has no saved debug edits,
   so it never gets here).
2. **The scene JSON:** the inline object in its list replaced with the id, in place (the order
   of a list is kept; the gather resolves the id from the registry, where the new file's
   basename and `appId` / `id` both give it).
3. **One batch** with both writes (and the rest of the save), so the asset never exists twice
   or not at all: the new file with `expectedHash: null` (it must not exist yet) and the scene
   JSON with the hash it was read with.

- **Taken:** a file already at the new path, or the id already in the registry (another file
  has it), makes the change Not saveable with the reason ("id taken by
  `src/app/lights/sun.light.json`"); nothing is renamed automatically.
- **Server:** a write gets `json` and `saveData` together: `json` is the file's content and
  `saveData` is applied over it as over a read file (stamped, history size), so the new file's
  entry is stamped like any other. `saveData` alone still needs an existing file.
- **Two scenes, one inline asset:** an asset inline in one scene JSON belongs to that scene
  only, so the move never touches another scene. A second scene with an inline asset of the same
  id is "id taken" once the first one moved (the first save's file is in the registry after the
  gather).
- Materials and PostFX passes can be inline too, but their debug edits (the material editor,
  `AEK_debugPostFx`) exist only for registry assets, so they have nothing to move.

## 3. Phases

### Phase 1 — Server: author, backups, dry run

§2.4 items 2 (the server side), 3 and 4: `__meta.author`, `AEK_DEV_FILES_BACKUPS`, `dryRun`,
the new status fields, `MetaSchema.author`.

**Exit:** the self-check covers the author, an entry's own `author` replaced or removed, a dry
run that writes nothing and reports the statuses and hashes, and backups kept per the env var (0
keeps none, the forced rename failure still restores). It never touches the developer's git
config: its own server's `git` inherits the process env, which it switches between commits
(own-server mode only). Set: `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=user.name`,
`GIT_CONFIG_VALUE_0=Self Check`. Unset: `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` pointed at an
empty file and `GIT_DIR` at an empty folder (no repo config either).

### Phase 2 — Client: gather toasts and confirm writes

§2.4 items 1 and 2 (the client side) and the folder's rows (gather toasts, confirm writes,
author, backups).

**Exit:** a debug-only write shows the toast after its reload (and the asset errors when a
source fails); a failed gather shows the alert; an editor save shows none. With confirm writes
on, the dialog lists the files, Cancel writes nothing and rejects with `CANCELLED`, and a file
changed between the dry run and Confirm fails with `CONFLICT`.

### Phase 3 — The Æ menu and "Save scene"

§2.1 and §2.2: `createDropDown`'s menu mode, the Æ menu (About moves into it), the save source
registry, "Save scene" and its key. The first sources: sky boxes and PostFX passes (no
conversion).

**Exit:** a sky box layer and a PostFX param edited in `skyShowcase`, Ctrl+S: one commit with
both files, their entries merged over the latest ones, stamped; after the reload the scene
looks the same with localStorage cleared for them; a second Ctrl+S toasts "Nothing to save".
The Æ icon is a spinner and the menu disabled from the key press to the reload, and a second
Ctrl+S meanwhile only toasts. A file edited by hand in between fails with `CONFLICT`, keeps
localStorage, and brings the icon and menu back. The save items are
disabled with the reason when the dev files are off and when the save history size is 0. The
menu works by keyboard; Escape closes it.

### Phase 4 — "Save specific data…"

§2.3 and its key.

**Exit:** with three changes, unchecking one saves the other two and leaves the third in
localStorage; Check all / Uncheck all and the group checkboxes; a sky box changed in
`skyShowcase` and saved from `largeWorld` under Other scenes lands in `skyShowcase`'s entry; a
PostFX pass shows under Not saveable when its scene is gone. With no change in the current
scene but one in another, "Save scene" is disabled and "Save specific data…" isn't.

### Phase 5 — Cameras and lights

Their sources: the UI keys and `debugCam` stripped, light colours to `#rrggbb`, values equal to
the asset's dropped, the UI keys kept after a save.

**Exit:** a light's colour and a camera's fov saved from largeWorld land as entries with only
those keys; helper toggles alone are no change; a light made in code is Not saveable.

### Phase 6 — Material editor (the current scene's materials)

Its source (§2.1): the edited materials the current scene lists, as that scene's `__saveData`
entries; the others Not saveable with the warning toast. A save clears the saved records'
`overrides` (settings and camera kept).

**Exit:** in `sceneTestECS`, `testMaterial` edited in the material editor and saved with Ctrl+S
(also from the material editor view): its JSON gets a `sceneTestECS` entry with the edits merged
into the existing one, the scene shows them, and the editor shows no override. `asteroid`
(listed by `space` only) edited too: the same Ctrl+S leaves it out with the warning toast and
keeps its editor changes; it's Not saveable in the dialog.

### Phase 7 — Scene JSON entries

§2.5: the gatherer fix and the `postFxEnabled` and spatial cell size sources.

**Exit:** a scene's PostFX switched off and a cell size changed, saved: the scene JSON gets one
entry with both, the gather applies it (`generatedAppData.json`), and a scene without
`__saveData` gathers byte for byte as before.

### Phase 8 — Inline assets to JSON files

Needs Phase 7 (the scene JSON's `__sourcePath` in the dev data). §2.6: the server's `json` +
`saveData` write (with self-check cases: the stamped entry in a
created file, `expectedHash: null` refusing an existing one), the extraction in the camera,
light and sky box sources, the dialog's "moves to" line.

**Exit:** `topDownTest`'s inline sky box (`topDownTestSky`, the only inline asset in the app)
edited and saved: one commit creates `src/app/skyboxes/topDownTestSky.skybox.json` with the
entry for `topDownTestScene`, and the scene JSON lists `"topDownTestSky"` at the same place;
after the reload the sky looks the same and the debug overrides are gone. A file put at that
path first makes it Not saveable ("taken"), and nothing is written.

### Phase 9 — Docs and versioning

CLAUDE.md (the Debug system section: the Æ menu, save sources and how a debug module adds one,
the keys, the File server settings and env var), `readme.md` if it lists the debug keys, the
versions and `CHANGELOG.md` (§4).

## 4. Versioning

Engine minor (the save menu, `debug/SaveData.ts`, the DropDown menu mode, `MetaSchema.author`,
new `AppConfig.devFiles` keys). App minor if `src/CONFIG.ts` gets the new `devFiles` keys.
Project entry for the dev server's author, backups and dry run. No toolkit change.

## 5. Open questions

None. Decided: inline assets move into their own files (§2.6); a save history size of 0 turns off
every save, a later global one too (§2.2); characters aren't saved in this plan (§2.1).
