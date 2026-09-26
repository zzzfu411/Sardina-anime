import './build';
import { startOrAttach } from '../packages/engine/src/runtime';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
const engine = await startOrAttach(resolve('dist/web'));
console.log(`Sardina anime：${engine.origin}`);
const opener = spawn(
  process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open',
  [engine.bootstrapUrl],
  { stdio: 'ignore' },
);
opener.on('error', () => {});
for (const event of ['SIGTERM', 'SIGINT'] as const)
  process.once(event, () => {
    void engine.close().then(() => process.exit(0));
  });
