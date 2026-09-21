import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
export default defineConfig([
  ...nextVitals,
  ...nextTs,
  { settings: { next: { rootDir: 'apps/web/' } } },
  globalIgnores([
    '**/.next/**',
    '**/node_modules/**',
    // Generated bundles: apps/worker/dist is esbuild output shipped into the image.
    '**/dist/**',
    'reference/**',
    'var/**',
    'artifacts/**',
    'apps/web/next-env.d.ts',
  ]),
]);
