// NOTE! Type-only file: everything here is erased at build time, so importing it broadly
// does not defeat the file-boundary tree-shaking described in
// docs/plans/p050_input-system-refactoring.md §2.1.
import type * as THREE from 'three/webgpu';

/** Whether a binding fires while the debug (orbit) camera is active. */
export type EnabledInDebugCam =
  | 'ENABLED_IN_DEBUG'
  | 'ENABLED_ONLY_IN_DEBUG'
  | 'NOT_ENABLED_IN_DEBUG';

/** Shared modifier-key fields, reused by KeyChord (Keyboard) and collision checks. */
export type Modifiers = {
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
};

/** Optional metadata every binding type carries, per decision 9 in the plan. */
export type BindingMeta = {
  name?: string;
  description?: string;
  /** Raw SVG strings, same convention as UI/icons/SvgIcon.ts. */
  icons?: string[];
};

/** A static list of raycast targets, or a getter evaluated at raycast time (Mouse/Touch). */
export type TargetList = THREE.Object3D[] | (() => THREE.Object3D[]);
