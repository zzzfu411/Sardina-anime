import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { build, Platform, Arch } from 'electron-builder';
import './build';

const root = resolve('.');
const stage = resolve('.tooling/desktop-app');
await mkdir(stage, { recursive: true });
for (const directory of ['engine', 'desktop', 'web'])
  await rm(stage + '/' + directory, { recursive: true, force: true });
await cp('dist/engine', stage + '/engine', { recursive: true });
await cp('dist/desktop', stage + '/desktop', { recursive: true });
await cp('dist/web', stage + '/web', { recursive: true });
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const engineDependencies = [
  '@fastify/static',
  'better-sqlite3',
  'cheerio',
  'fastify',
  'ipaddr.js',
  'json5',
  'm3u8-parser',
  'tough-cookie',
  'https-proxy-agent',
  'zod',
];
const lock = JSON.parse(await readFile('node_modules/electron/package.json', 'utf8'));
const dependencies: Record<string, string> = {};
for (const name of engineDependencies)
  dependencies[name] = JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8')).version;
await writeFile(
  stage + '/package.json',
  JSON.stringify(
    {
      name: 'sardina-anime',
      version: pkg.version,
      private: true,
      type: 'module',
      packageManager: 'npm@11.19.0',
      main: 'desktop/main.cjs',
      description: pkg.description,
      author: 'Sardina anime',
      dependencies,
    },
    null,
    2,
  ),
);
await cp(root + '/apps/desktop/runtime-package-lock.json', stage + '/package-lock.json');
await new Promise<void>((ok, fail) => {
  const child = spawn(
    'npm',
    ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', root + '/.cache/npm'],
    { cwd: stage, stdio: 'inherit' },
  );
  child.on('error', fail);
  child.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`dependency install failed: ${code}`))));
});
await build({
  projectDir: stage,
  targets: Platform.MAC.createTarget(['dmg', 'zip'], Arch.arm64),
  config: {
    appId: 'local.revanime.app',
    productName: 'Sardina anime',
    electronVersion: lock.version,
    electronDist: resolve('node_modules/electron/dist'),
    directories: { app: stage, output: root + '/release' },
    files: ['engine/**', 'desktop/**', 'web/**', 'package.json', 'node_modules/**'],
    asar: true,
    npmRebuild: true,
    mac: {
      icon: root + '/assets/icon.icns',
      category: 'public.app-category.entertainment',
      // Seal the complete bundle without requiring a Developer ID certificate.
      identity: '-',
      strictVerify: true,
      hardenedRuntime: false,
      artifactName: 'Sardina-anime-${version}-${arch}.${ext}',
    },
    dmg: { title: 'Sardina anime', sign: false },
  },
});
