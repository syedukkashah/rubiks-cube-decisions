import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // AGENTS.md 9 rule 4: no OpenRouter access from the frontend, ever.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/openrouter\\.ai/i]',
          message: 'The frontend must never call OpenRouter (AGENTS.md section 9, rule 4).',
        },
      ],
    },
  },
);
