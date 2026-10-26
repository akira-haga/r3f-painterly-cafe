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
      // Three.js/r3f のパスや material は元々ミュータブルで、
      // useMemo で生成したインスタンスを直接書き換えるのが正しい使い方のため無効化
      'react-hooks/immutability': 'off',
    },
  },
  {
    // TSL(three/tsl) のノードは型がメソッドチェーン(.mul/.add/.toVar など)を
    // 十分に表現できず any 前提になるため、effects 配下のみ no-explicit-any を無効化
    files: ['src/effects/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
])
