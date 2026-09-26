import type { LineObject } from './LineObject';

/** @internal Every live line, by id. Lines belong to no ECS world, so this is module-wide. */
const lines = new Map<string, LineObject>();
let autoIdCounter = 0;

/** @internal */
export const nextLineId = () => {
  let id: string;
  do id = `line_${autoIdCounter++}`;
  while (lines.has(id));
  return id;
};

/** @internal */
export const registerLine = (line: LineObject) => lines.set(line.id, line);

/** @internal */
export const unregisterLine = (id: string) => lines.delete(id);

/** @internal */
export const getRegisteredLine = (id: string) => lines.get(id);

/** @internal */
export const getRegisteredLines = () => lines;
