import js from '@eslint/js';

export default [
  { ignores: ['dist/**', 'node_modules/**', '.agent/**', '.agent-workspaces/**'] },
  js.configs.recommended,
  {
    files: ['control-center/public/**/*.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
        navigator: 'readonly',
        setInterval: 'readonly',
        self: 'readonly',
        caches: 'readonly'
      }
    }
  },
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        Buffer: 'readonly',
        AbortController: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        structuredClone: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly'
      }
    },
    rules: { 'no-console': 'off' }
  }
];
