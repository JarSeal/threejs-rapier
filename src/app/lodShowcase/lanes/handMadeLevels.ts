import * as THREE from 'three/webgpu';
import { getEntityIdByAppId } from '../../../_engine/core/ECS';
import { getGeometry } from '../../../_engine/core/Geometry';
import { getMaterial } from '../../../_engine/core/Material';
import { createMeshEntity } from '../../../_engine/core/MeshManager';
import type { LodDef } from '../../../_engine/core/Lod/LodTypes';
import { getConservativeGeometryRadius } from '../../../_engine/core/Spatial/SpatialIndexSystem';
import { existsOrThrow } from '../../../_engine/utils/assert';
import { lwarn } from '../../../_engine/utils/Logger';
import type { ShowcaseLane } from '../layout';

/** The lane's mesh JSON (lodShowcaseHandMade.mesh.json), listed in lodShowcase.scene.json. */
const MESH_APP_ID = 'lodShowcaseHandMade';

/**
 * Lane 1: hand-made levels on plain meshes (docs/plans/_DONE_p348_ecs-lod-selection.md), authored in
 * JSON: three sphere geometries at fewer segments, the mesh's `lod` with a cull distance and its
 * own `fadeSeconds`. The JSON mesh is the lane's first object, in level 0's band; the lane puts
 * copies of its definition in the other bands.
 */
export const handMadeLevelsLane: ShowcaseLane = {
  id: 'handMadeLevels',
  title: 'Hand-made levels',
  description:
    'A *.mesh.json with `lod` levels (the same sphere at fewer segments), a cull distance and its own fadeSeconds.',
  create: async (ctx) => {
    const entry = ctx.sceneData.meshes?.find(
      (mesh) => typeof mesh !== 'string' && mesh.props.appId === MESH_APP_ID
    );
    if (!entry || typeof entry === 'string' || !entry.props.lod) {
      throw new Error(
        `The lodShowcase scene needs the mesh "${MESH_APP_ID}" with a lod (lodShowcaseHandMade.mesh.json).`
      );
    }
    const { props } = entry;
    const def = props.lod as LodDef;
    const geometry = existsOrThrow(
      getGeometry(props.geo as string) as THREE.BufferGeometry | undefined,
      `The lodShowcase scene needs the geometry "${String(props.geo)}".`
    );
    const material = existsOrThrow(
      getMaterial(props.mat as unknown as string),
      `The lodShowcase scene needs the material "${String(props.mat)}".`
    );
    const radius = getConservativeGeometryRadius(geometry);
    const y = props.position?.y ?? radius;
    if (props.position?.x !== ctx.x) {
      lwarn(
        `[lodShowcase] "${MESH_APP_ID}" stands at x ${props.position?.x}, off its lane's line (x ${ctx.x}).`
      );
    }

    // The JSON mesh shows level 0: copies for every farther band
    const copyIds: number[] = [];
    const copySlots = ctx.getSlots(radius, def).filter((slot) => slot.level !== 0);
    copySlots.forEach((slot, i) => {
      copyIds.push(
        createMeshEntity(
          {
            ...props,
            // props.appId would win over the copy's own
            appId: undefined,
            geo: geometry,
            mat: material,
            position: ctx.placeAt(slot.distance, y),
          },
          {
            appId: `${MESH_APP_ID}_${i + 1}`,
            debugData: {
              name: `LOD showcase: hand-made levels ${i + 1}`,
              description: `A copy of ${MESH_APP_ID}, ${slot.distance.toFixed(0)} m from the start camera (${slot.level < 0 ? 'LOD culled' : `level ${slot.level}`} there).`,
            },
          },
          ctx.world
        )
      );
    });

    return {
      getEntityIds: () => {
        const jsonId = getEntityIdByAppId(MESH_APP_ID, ctx.world);
        return jsonId === undefined ? copyIds : [jsonId, ...copyIds];
      },
      radius,
      switchDistances: ctx.getSwitchDistances(radius, def),
    };
  },
};
