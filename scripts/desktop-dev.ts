import { spawn } from 'node:child_process';
import electron from 'electron';
import { resolve } from 'node:path';
import './build';
import { startOrAttach } from '../packages/engine/src/runtime';

// Development reuses a Node-owned engine. Packaged apps own a utility-process engine
// with a separate Electron ABI build of SQLite (see package.ts).
const engine = await startOrAttach(resolve('dist/web'));
const child = spawn(electron as unknown as string, ['dist/desktop/main.cjs'], {
  stdio: 'inherit',
  env: process.env,
});
const finish = async (code = 0) => {
  await engine.close();
  process.exit(code);
};
child.on('error', (error) => {
  console.error(error.message);
  void finish(1);
});
child.on('exit', (code) => {
  void finish(code ?? 0);
});
process.once('SIGINT', () => child.kill());
process.once('SIGTERM', () => child.kill());
