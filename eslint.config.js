import js from '@eslint/js';

export default [
  { ignores: ['dist/**', 'node_modules/**', '.agent/**', '.agent-workspaces/**'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        Buffer: 'readonly',
        AbortController: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        structuredClone: 'readonly'
      }
    },
    rules: { 'no-console': 'off' }
  }
];
