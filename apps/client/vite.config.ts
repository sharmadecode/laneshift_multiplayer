import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: {
      '@hr/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      '@hr/simulation': fileURLToPath(new URL('../../packages/simulation/src/index.ts', import.meta.url))
    }
  },
  server: {
    port: 5199,
    host: true
  },
  build: {
    target: 'es2022'
  }
});
