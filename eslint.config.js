/* ESLint 10 flat-config — minimal, complements Biome.
   Biome handles formatting + most lint rules; ESLint covers the few rules
   that Biome's Rust core doesn't implement yet (e.g. exhaustive switch). */
const globals = require('globals');

module.exports = [
    {
        ignores: [
            'node_modules/**',
            'assets/**',
            'sounds/**',
            'lib/**',
            '.claude/**',
            '*.vsix',
            '.start.py.preref',
        ],
    },
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'commonjs',
            globals: { ...globals.node, ...globals.browser },
        },
        rules: {
            'no-undef': 'error',
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            'no-empty': ['error', { allowEmptyCatch: true }],
            'no-prototype-builtins': 'off',
        },
    },
    {
        files: ['panel/**/*.js', 'injects/**/*.js'],
        languageOptions: {
            sourceType: 'script',
            globals: { ...globals.browser, acquireVsCodeApi: 'readonly' },
        },
    },
];
