import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
export default defineConfig({
  root: resolve('apps/web'),
  plugins: [react()],
  build: { outDir: resolve('dist/web'), emptyOutDir: true, sourcemap: true },
  server: { host: '127.0.0.1' },
});
