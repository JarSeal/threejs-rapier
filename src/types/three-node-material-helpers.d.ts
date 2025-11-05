/* eslint-disable @typescript-eslint/no-explicit-any */

// three-node-material-helpers.d.ts
// Place this file somewhere in your project (e.g., `src/types/`) and ensure your tsconfig “typeRoots” (or include) picks it up.

import * as THREE from 'three';

/**
 * Basic Node type alias for TSL/Node-Material system.
 * Many node/graph functions return some kind of Node<T> or Node,
 * but typings may not always reflect it.
 */
declare module 'three/tsl' {
  /**
   * A generic Node representing a shader expression of type T.
   */
  export interface Node<T = any> {
    // methods commonly used chainable (swizzle, etc)
    // you can expand if you use more node-features
    add?(other: Node<T>): Node<T>;
    mul?(other: Node<T>): Node<T>;
    // … you may add more operators as needed
  }

  /**
   * A vector2 node type alias
   */
  export interface Vec2Node extends Node<THREE.Vector2> {}
  /**
   * A float scalar node
   */
  export interface FloatNode extends Node<number> {}
  /**
   * A color/vec3 node type
   */
  export interface Vec3Node extends Node<THREE.Vector3> {}

  /**
   * The fn() function wrapper for shader logic.
   * We type it so that it returns a function from Node arguments to Node<T>.
   */
  export function fn<Args extends any[], R>(
    func: (...args: Args) => Node<R>
  ): (...args: Args) => Node<R>;
}

/**
 * Augmenting THREE.Material and specific NodeMaterial subclasses
 * to allow Node properties (common in NodeMaterial system).
 */
declare module 'three' {
  interface Material {
    // allow arbitrary “...Node” properties for advanced shaders
    [prop: string]: any;
  }

  // If you know you use specific NodeMaterial types:
  class NodeMaterial extends Material {
    // maybe add node-specific methods or properties
  }
  class MeshStandardNodeMaterial extends Material {
    // typical properties for standard node material
    colorNode?: any;
    emissiveNode?: any;
    // … you can add more node sockets you use
  }
}
