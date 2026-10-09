import globals from 'globals';
import prettier from 'eslint-plugin-prettier';
import typescriptEslint from '@typescript-eslint/eslint-plugin';
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat();

// The simulation: code that runs at APP_PHYSICS_STEP or inside the physics step, on the main
// thread or in the physics worker. It must run identically on every machine, so it counts time in
// steps and draws randomness from a seeded RNG. p608's codemod rewrites these paths when it moves
// the files.
const SIMULATION_FILES = [
  'src/_engine/core/Physics/**/*.ts',
  'src/_engine/workers/physicsWorker.ts',
  'src/_engine/workers/physics/**/*.ts',
  'src/_engine/core/PhysicsAPI.ts',
  'src/_engine/core/PhysicsManager.ts',
  'src/_engine/core/PhysicsTiers.ts',
  'src/_engine/core/PhysicsTierPolicy.ts',
  'src/_engine/core/Character.ts',
  'src/_engine/core/Character/**/*.ts',
  'src/_engine/utils/world/movingPlatform.ts',
  'src/toolkit/ecs/effects/MutualGravity.ts',
];
const STEP_TIME_MESSAGE =
  'Simulation time is the step index (getPhysicsSubStepIndex), never the wall clock. Profiling reads use readStatsClock (utils/StatsClock.ts).';
const SIMULATION_RESTRICTED_PROPERTIES = [
  {
    object: 'Math',
    property: 'random',
    message:
      'Simulation randomness is seeded: createSeededRandom (toolkit/geometry/seededRandom.ts) until the RNG service exists.',
  },
  { object: 'performance', property: 'now', message: STEP_TIME_MESSAGE },
  { object: 'Date', property: 'now', message: STEP_TIME_MESSAGE },
];
const SIMULATION_RESTRICTED_SYNTAX = [
  { selector: 'NewExpression[callee.name="Date"]', message: STEP_TIME_MESSAGE },
  { selector: 'CallExpression[callee.name="Date"]', message: STEP_TIME_MESSAGE },
];

export default [
  // Generated/vendored files (DRACO/Basis decoders copied by devTools/copyDecoders.ts, TypeDoc
  // output, the Hub's build)
  { ignores: ['src/public/draco/', 'src/public/basis/', 'docs-api/', 'dist-hub/'] },

  // Old .eslintrc config (old style for plugins that don't support flat config)
  ...compat.config({
    root: true,
    ignorePatterns: ['dist', 'node_modules'],
    plugins: ['prettier', '@typescript-eslint'],
    extends: [
      'plugin:@typescript-eslint/eslint-recommended',
      'plugin:@typescript-eslint/recommended',
      'plugin:prettier/recommended',
    ],
    rules: {
      '@typescript-eslint/no-unused-vars': 1,
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
      // Type-only imports as a top-level `import type`, which is erased, so a type can't pull its
      // module (and three) into the physics worker. The inline `import { type X }` alone compiles
      // to `import {}` under verbatimModuleSyntax: a side-effect import that still loads it.
      // `typeof import('…')` annotations are erased too, and type the debug loader's modules.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'separate-type-imports', disallowTypeAnnotations: false },
      ],
      '@typescript-eslint/no-import-type-side-effects': 'error',
    },
  }),

  // Flat config (new style)
  {
    files: ['**/*.ts'],
    ignores: ['dist/*', 'node_modules/*'],
    plugins: { prettier, typescriptEslint },
    rules: {
      'no-console': 1,
      'no-var': 1,
      camelcase: 1,
      'arrow-body-style': 1,
      semi: [2, 'always'],
    },
    languageOptions: {
      ecmaVersion: 12,
      sourceType: 'module',
      globals: {
        commonjs: true,
        browser: true,
        es6: true,
        ...globals.browser,
      },
    },
  },

  // The simulation rules (the coding standards' "The simulation")
  {
    files: SIMULATION_FILES,
    rules: {
      'no-restricted-properties': ['error', ...SIMULATION_RESTRICTED_PROPERTIES],
      'no-restricted-syntax': ['error', ...SIMULATION_RESTRICTED_SYNTAX],
    },
  },
  // Known violations, each with the plan that removes it. A later entry replaces the rule's
  // options for its file, so it lists what stays restricted there.
  {
    // The tumble impulse's direction (p610: the seeded RNG)
    files: ['src/_engine/core/Character/DynamicCharacter.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        ...SIMULATION_RESTRICTED_PROPERTIES.filter((p) => p.object !== 'Math'),
      ],
    },
  },
  {
    // The wall clock under getPhysGameTime(), which the characters read (p610: step-index time)
    files: ['src/_engine/core/Physics/PhysicsWallClock.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        ...SIMULATION_RESTRICTED_PROPERTIES.filter((p) => p.object !== 'performance'),
      ],
    },
  },
];
