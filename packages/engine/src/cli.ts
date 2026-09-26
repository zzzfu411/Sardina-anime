import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { startOrAttach } from './runtime';
import { publicError } from './errors';

try {
  const webDir = process.env.REVANIME_WEB_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), '../web');
  const engine = await startOrAttach(webDir);
  const parentPort = (process as typeof process & { parentPort?: { postMessage(data: unknown): void } })
    .parentPort;
  parentPort?.postMessage({
    type: 'ready',
    origin: engine.origin,
    bootstrapUrl: engine.bootstrapUrl,
    owned: engine.owned,
  });
  console.log(`Sardina anime已${engine.owned ? '启动' : '连接'}：${engine.origin}`);
  if (process.argv.includes('--open')) {
    const command =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
    const child = spawn(command, [engine.bootstrapUrl], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  }
  if (engine.owned)
    for (const event of ['SIGINT', 'SIGTERM'] as const)
      process.once(event, () => {
        void engine.close().then(() => process.exit(0));
      });
} catch (error) {
  console.error(publicError(error).message);
  process.exitCode = 1;
}
