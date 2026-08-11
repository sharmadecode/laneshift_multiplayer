import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5199,
    strictPort: true,
    proxy: {
      '/socket.io': { target: 'http://localhost:3000', ws: true }
    }
  },
  build: { outDir: 'dist' }
});
