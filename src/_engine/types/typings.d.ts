declare module '*.module.scss';

// Project metadata
declare const __PROJECT_METADATA__: {
  app: {
    version: string;
    codename: string;
    name: string;
    fullName: string;
    description: string;
    url: string;
    repoUrl: string;
    author: string;
  };
  engine: {
    version: string;
    codename: string;
    name: string;
    fullName: string;
    description: string;
    url: string;
    repoUrl: string;
    author: string;
  };
  toolkit: {
    version: string;
    codename: string;
    name: string;
    fullName: string;
    description: string;
    url: string;
    repoUrl: string;
    author: string;
  };
  pkgVersion: string;
  license: string;
  packages: Record<string, string>;
  buildTools: Record<string, string>;
  build: { commit: string; hasLocalChanges: boolean; time: string };
  versionChecksum: string;
  versionChecksumString: string;
};
