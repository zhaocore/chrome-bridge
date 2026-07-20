import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        ...globals.webextensions
      }
    },
    rules: {
      // TypeScript resolves ambient extension globals from @types/chrome.
      'no-undef': 'off'
    }
  },
  {
    files: ['vite.config.ts', 'eslint.config.js'],
    languageOptions: {
      globals: globals.node
    }
  }
);
