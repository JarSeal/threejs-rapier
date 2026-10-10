import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { ENTRY_FILES, getTsconfigPaths } from './aliases';
import { ROOT } from './assetPipeline/sources';

describe('aliases', () => {
  it("tsconfig.json's paths are the entry list", () => {
    const { config, error } = ts.readConfigFile(path.join(ROOT, 'tsconfig.json'), ts.sys.readFile);
    expect(error).toBeUndefined();
    expect(config.compilerOptions.paths).toEqual(getTsconfigPaths());
  });

  it('every entry file exists', () => {
    for (const file of Object.values(ENTRY_FILES)) {
      expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
    }
  });
});
