import { describe, expect, test } from 'vitest';
import { deepMerge, isIndexObject } from './deepMerge';

describe('deepMerge', () => {
  test('merges plain objects key by key without mutating either', () => {
    const target = { a: 1, nested: { b: 2, c: 3 } };
    const source = { nested: { c: 4, d: 5 } };
    const result = deepMerge(target, source);

    expect(result).toEqual({ a: 1, nested: { b: 2, c: 4, d: 5 } });
    expect(target).toEqual({ a: 1, nested: { b: 2, c: 3 } });
    expect(source).toEqual({ nested: { c: 4, d: 5 } });
    expect(result.nested).not.toBe(target.nested);
  });

  test('skips undefined values in the source', () => {
    expect(deepMerge({ a: 1, b: 2 }, { a: undefined, b: 3 })).toEqual({ a: 1, b: 3 });
  });

  test('an undefined source returns a copy of a plain target', () => {
    const target = { a: { b: 1 } };
    const result = deepMerge(target, undefined);
    expect(result).toEqual(target);
    expect(result).not.toBe(target);
    expect(result.a).not.toBe(target.a);
  });

  test('an array replaces an array', () => {
    expect(deepMerge({ list: [1, 2, 3] }, { list: [9] })).toEqual({ list: [9] });
  });

  test('an index object merges into an array index by index (the sky box overrides)', () => {
    const target = { suns: [{ size: 1, color: 'red' }, { size: 2 }] };
    const result = deepMerge(target, { suns: { '1': { size: 5 } } });

    expect(result).toEqual({ suns: [{ size: 1, color: 'red' }, { size: 5 }] });
    expect(Array.isArray(result.suns)).toBe(true);
    expect(result.suns[0]).not.toBe(target.suns[0]);
    expect(target.suns[1]).toEqual({ size: 2 });
  });

  test('an index object can append past the array’s end', () => {
    expect(deepMerge([{ a: 1 }], { '1': { a: 2 } })).toEqual([{ a: 1 }, { a: 2 }]);
  });

  test('class instances replace the target as they are', () => {
    class Texture {
      constructor(public id: string) {}
    }
    const texture = new Texture('next');
    const result = deepMerge({ map: new Texture('prev') }, { map: texture });
    expect(result.map).toBe(texture);
  });

  test('a primitive source replaces an object target', () => {
    expect(deepMerge({ a: { b: 1 } }, { a: null })).toEqual({ a: null });
  });
});

describe('isIndexObject', () => {
  test.each([
    [{ '0': 1, '12': 2 }, true],
    [{}, true],
    [{ '01': 1 }, false],
    [{ '-1': 1 }, false],
    [{ a: 1 }, false],
    [[1], false],
    [null, false],
  ])('%j → %s', (value, expected) => {
    expect(isIndexObject(value)).toBe(expected);
  });
});
