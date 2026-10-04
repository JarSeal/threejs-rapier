import fs from 'fs';
import path from 'path';
import {
  AssetsConfigSchema,
  TEXTURE_SLOTS,
  type AssetOptimize,
  type AssetsConfig,
  type MeshSettings,
  type OptimizeLevel,
  type TextureSettings,
  type TextureSlot,
} from '../../src/_engine/schemas/assetsConfigSchema';
import { globToRegExp } from './glob';
import { ROOT } from './sources';
import type { ProjectOptOut } from './switches';

/**
 * Resolves an asset's optimization settings (p300 §4): the built-in defaults, then
 * `assets.config.json`'s `defaults`, its matching rules (in order), the profile (the asset's own,
 * else the last matching rule's), the collider default and the asset JSON's own overrides,
 * later wins. Within each level, a texture slot's entry merges over that level's `default`.
 * The project switches (src/CONFIG.ts, `AEK_ASSETS_OPTIMIZE`) and an `optimize: false` (or
 * `textures: false` / `mesh: false`) in a rule or the asset JSON win over all of it.
 */

export const ASSETS_CONFIG_FILE = path.join(ROOT, 'assets.config.json');

/** Phase 1's measured defaults (§4). `assets.config.json`'s `defaults` merge over these. */
export const BUILTIN_DEFAULTS = {
  mesh: { codec: 'meshopt', quantize: true, simplify: null },
  textures: {
    default: {
      codec: 'uastc',
      maxSize: 1024,
      mipmaps: true,
      level: 2,
      rdo: 2,
      zstd: 18,
      quality: 128,
      normalMode: false,
    },
    normal: { rdo: 1 },
    orm: { rdo: 1 },
    metallicRoughness: { rdo: 1 },
    occlusion: { rdo: 1 },
    data: { codec: 'none' },
  },
} satisfies OptimizeLevel;

/**
 * Collider sources (DD6) get lossless meshopt: quantized positions break CONVEXHULL and
 * HEIGHTFIELD colliders (Phase 1d). No simplification either: it changes the collider's shape
 * and, like a reorder, scrambles a HEIGHTFIELD's grid. Applied after the profile, so only the
 * asset's own JSON can turn either back on.
 */
const COLLIDER_LEVEL: OptimizeLevel = { mesh: { quantize: false, simplify: null } };

/** Only the keys the codec reads, so equal encodes resolve (and hash) equally. */
export type ResolvedTextureSettings =
  | {
      codec: 'uastc';
      maxSize: number | null;
      mipmaps: boolean;
      level: number;
      rdo: number;
      zstd: number;
      normalMode: boolean;
    }
  | {
      codec: 'etc1s';
      maxSize: number | null;
      mipmaps: boolean;
      quality: number;
      normalMode: boolean;
    }
  | { codec: 'none'; maxSize: number | null };

export type ResolvedMeshSettings = Required<MeshSettings>;

export type ResolvedAssetSettings = {
  /** The profile applied, if any */
  profile: string | null;
  /** The globs of the rules that matched, in order */
  rules: string[];
  /** A standalone texture's slot (its JSON's, else the last matching rule's, else `default`) */
  slot: TextureSlot;
  /** Settings per slot, or false: keep the textures as they are */
  textures: false | Record<TextureSlot, ResolvedTextureSettings>;
  /** false: keep the geometry as it is */
  mesh: false | ResolvedMeshSettings;
  /** Why a side is kept as it is */
  passThrough: { textures?: string; mesh?: string };
};

export type AssetSettingsInput = {
  /** The source file's path relative to the repo root, '/'-separated */
  sourcePath: string;
  /** The asset JSON's `optimize` */
  optimize?: AssetOptimize;
  /** A GLB with collider nodes (`colliderType` extras) */
  isColliderSource?: boolean;
};

const formatIssues = (issues: { path: PropertyKey[]; message: string }[]) =>
  issues.map((issue) => ` └─ [${issue.path.join('.')}]: ${issue.message}`).join('\n');

/** Reads and validates `assets.config.json`; a missing file is an empty config. */
export const loadAssetsConfig = (file = ASSETS_CONFIG_FILE): AssetsConfig => {
  if (!fs.existsSync(file)) return {};
  let json: unknown;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (error) {
    throw new Error(`${path.relative(ROOT, file)}: invalid JSON (${(error as Error).message})`);
  }
  const validation = AssetsConfigSchema.safeParse(json);
  if (!validation.success) {
    throw new Error(
      `${path.relative(ROOT, file)} is invalid:\n${formatIssues(validation.error.issues)}`
    );
  }
  return validation.data;
};

const pickTextureSettings = (merged: TextureSettings): ResolvedTextureSettings => {
  const { codec, maxSize = null, mipmaps = true, normalMode = false } = merged;
  if (codec === 'none') return { codec, maxSize };
  if (codec === 'etc1s') {
    // ktx rejects Zstd with ETC1S (its BasisLZ is its own supercompression), so zstd is dropped
    return { codec, maxSize, mipmaps, quality: merged.quality ?? 128, normalMode };
  }
  return {
    codec: 'uastc',
    maxSize,
    mipmaps,
    level: merged.level ?? 2,
    rdo: merged.rdo ?? 0,
    zstd: merged.zstd ?? 0,
    normalMode,
  };
};

/**
 * Returns the resolver for a config. Throws when a rule names a profile that doesn't exist or
 * has an invalid glob; the resolver itself throws for an asset that names an unknown profile.
 * @param projectOptOut The project switches (`resolveProjectOptOut`); default: all on
 */
export const createSettingsResolver = (
  config: AssetsConfig = loadAssetsConfig(),
  projectOptOut: ProjectOptOut = {}
) => {
  const profiles = config.profiles ?? {};
  const profileNames = () => Object.keys(profiles).join(', ') || 'none';
  const rules = (config.rules ?? []).map((rule, index) => {
    if (rule.profile && !profiles[rule.profile]) {
      throw new Error(
        `assets.config.json rules[${index}] names an unknown profile "${rule.profile}" (profiles: ${profileNames()})`
      );
    }
    return { rule, regExp: globToRegExp(rule.glob) };
  });

  return (input: AssetSettingsInput): ResolvedAssetSettings => {
    const matched = rules.filter(({ regExp }) => regExp.test(input.sourcePath)).map((r) => r.rule);
    const own = input.optimize === false ? null : input.optimize;
    const passThrough: ResolvedAssetSettings['passThrough'] = {};
    const setPassThrough = (side: 'textures' | 'mesh', reason: string) => {
      passThrough[side] ??= reason;
    };

    if (projectOptOut.textures) setPassThrough('textures', projectOptOut.textures);
    if (projectOptOut.mesh) setPassThrough('mesh', projectOptOut.mesh);

    for (const rule of matched) {
      if (rule.optimize === false) {
        setPassThrough('textures', `optimize: false in the rule "${rule.glob}"`);
        setPassThrough('mesh', `optimize: false in the rule "${rule.glob}"`);
      }
      if (rule.textures === false) {
        setPassThrough('textures', `textures: false in the rule "${rule.glob}"`);
      }
      if (rule.mesh === false) setPassThrough('mesh', `mesh: false in the rule "${rule.glob}"`);
    }
    if (input.optimize === false) {
      setPassThrough('textures', 'optimize: false in the asset JSON');
      setPassThrough('mesh', 'optimize: false in the asset JSON');
    }
    if (own?.textures === false) setPassThrough('textures', 'textures: false in the asset JSON');
    if (own?.mesh === false) setPassThrough('mesh', 'mesh: false in the asset JSON');

    // The last matching rule's profile and slot (lib is ES2021: no findLast)
    const lastRules = [...matched].reverse();
    const profile = own?.profile ?? lastRules.find((rule) => rule.profile)?.profile ?? null;
    if (profile && !profiles[profile]) {
      throw new Error(`Unknown optimization profile "${profile}" (profiles: ${profileNames()})`);
    }

    // A level's `false` sides were handled above: only settings objects take part in merging
    const toLevel = (level?: {
      textures?: OptimizeLevel['textures'] | false;
      mesh?: OptimizeLevel['mesh'] | false;
    }): OptimizeLevel => ({
      textures: level?.textures || undefined,
      mesh: level?.mesh || undefined,
    });
    const levels: OptimizeLevel[] = [
      BUILTIN_DEFAULTS,
      toLevel(config.defaults),
      ...matched.map(toLevel),
      toLevel(profile ? profiles[profile] : undefined),
      input.isColliderSource ? COLLIDER_LEVEL : {},
      toLevel(own ?? undefined),
    ];

    const resolveSlot = (slot: TextureSlot) => {
      let merged: TextureSettings = {};
      for (const { textures } of levels) {
        merged = {
          ...merged,
          ...textures?.default,
          ...(slot === 'default' ? {} : textures?.[slot]),
        };
      }
      return pickTextureSettings(merged);
    };

    let mesh: MeshSettings = {};
    for (const level of levels) mesh = { ...mesh, ...level.mesh };

    return {
      profile,
      rules: matched.map((rule) => rule.glob),
      slot: own?.slot ?? lastRules.find((rule) => rule.slot)?.slot ?? 'default',
      textures: passThrough.textures
        ? false
        : (Object.fromEntries(TEXTURE_SLOTS.map((slot) => [slot, resolveSlot(slot)])) as Record<
            TextureSlot,
            ResolvedTextureSettings
          >),
      mesh: passThrough.mesh ? false : (mesh as ResolvedMeshSettings),
      passThrough,
    };
  };
};
