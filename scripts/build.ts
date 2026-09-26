import { build as bundle } from 'esbuild';
import { build as viteBuild } from 'vite';
import { mkdir } from 'node:fs/promises';

await mkdir('dist/engine', { recursive: true });
await bundle({
  entryPoints: ['packages/engine/src/cli.ts'],
  outdir: 'dist/engine',
  platform: 'node',
  format: 'esm',
  target: 'node24',
  bundle: true,
  packages: 'external',
  sourcemap: true,
});
await bundle({
  entryPoints: ['apps/desktop/src/main.ts'],
  outfile: 'dist/desktop/main.cjs',
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  bundle: true,
  packages: 'external',
  sourcemap: true,
});
await viteBuild();
