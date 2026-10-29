/**
 * eslint.config.js — lint rules plus the architecture boundaries from docs/ARCHITECTURE.md.
 *
 * The boundary rules make the layer ownership enforceable in CI, not just in prompts:
 *   - The core layer (src/core-engine.js) must not depend on the UI layer or the server.
 *   - The UI layer may use core only through its public exports, never its internals.
 */
'use strict';

const js = require('@eslint/js');
const globals = require('globals');

// Internals of core-engine.js that are not part of its public API.
const CORE_INTERNALS = 'USERS|CUSTOMERS|connection';

module.exports = [
  { ignores: ['node_modules/', 'qa-evidence/', '.claude/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    // Boundary: core never reaches up into the UI layer or the HTTP server.
    files: ['src/core-engine.js'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='require'][arguments.0.value=/invoice-dashboard|server/]",
          message: 'ARCHITECTURE: the core layer must not depend on the UI layer or the server.',
        },
      ],
    },
  },
  {
    // Boundary: the UI layer uses core through its public functions only.
    files: ['src/invoice-dashboard.js', 'src/server.js'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: `MemberExpression[object.name='core'][property.name=/^(${CORE_INTERNALS})$/]`,
          message: 'ARCHITECTURE: use core-engine public functions only, never its internals.',
        },
        {
          selector: "CallExpression[callee.name='require'][arguments.0.value=/core-engine\\/|\\.\\.\\/.*core/]",
          message: 'ARCHITECTURE: require core only as ./core-engine.',
        },
      ],
    },
  },
  {
    files: ['src/server.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
];
