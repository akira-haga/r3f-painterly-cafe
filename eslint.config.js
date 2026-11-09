import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // Three.js/r3f objects such as materials are mutable by design, and
      // mutating an instance created in useMemo is the intended pattern.
      'react-hooks/immutability': 'off',
    },
  },
  {
    // TSL (three/tsl) node types can't fully express method chains like
    // .mul/.add/.toVar, so the effects code relies on any. Allowed here only.
    files: ['src/effects/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
])
