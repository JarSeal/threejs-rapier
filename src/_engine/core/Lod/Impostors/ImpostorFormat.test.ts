import { describe, expect, test } from 'vitest';
import { getImpostorDefSlots, IMPOSTOR_ATLAS_SLOTS, IMPOSTOR_KINDS } from './ImpostorFormat';

describe('getImpostorDefSlots', () => {
  test('every kind reads its required slots', () => {
    for (const kind of IMPOSTOR_KINDS) {
      expect(getImpostorDefSlots({ kind })).toEqual(IMPOSTOR_ATLAS_SLOTS[kind].required);
    }
  });

  test('cross-quads baked with normals also read the normal slot', () => {
    expect(getImpostorDefSlots({ kind: 'CROSS_QUADS', normals: true })).toEqual([
      'albedo',
      'normal',
    ]);
    expect(getImpostorDefSlots({ kind: 'OCTAHEDRAL', normals: true })).toEqual([
      'albedo',
      'normalDepth',
    ]);
  });

  test('returns a copy, not the shared slot list', () => {
    const slots = getImpostorDefSlots({ kind: 'OCTAHEDRAL' });
    slots.push('extra');
    expect(IMPOSTOR_ATLAS_SLOTS.OCTAHEDRAL.required).toEqual(['albedo', 'normalDepth']);
  });
});
