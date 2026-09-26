import { mkdir, readFile, writeFile, open, unlink, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from './server';
import { AppError } from './errors';
import { APP_VERSION } from '../../core/src/types';
import Database from 'better-sqlite3';

export interface EngineState {
  version: 1;
  pid: number;
  port: number;
  token: string;
}
export const defaultProfile = () =>
  process.env.REVANIME_DATA_DIR
    ? resolve(process.env.REVANIME_DATA_DIR)
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'Revanime')
      : process.platform === 'win32'
        ? join(process.env.APPDATA ?? homedir(), 'Revanime')
        : join(homedir(), '.local', 'share', 'revanime');
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export async function startOrAttach(webDir: string, profile = defaultProfile()) {
  await mkdir(profile, { recursive: true, mode: 0o700 });
  // Serialize recovery as well as creation: read/unlink of a stale lock is not atomic.
  // Keep this sidecar in place; SQLite releases its process lock even after a crash.
  const startup = new Database(join(profile, 'engine-startup.sqlite'), { timeout: 0 });
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        startup.exec('BEGIN IMMEDIATE');
        break;
      } catch (error) {
        if ((error as { code?: string }).code !== 'SQLITE_BUSY') throw error;
        if (attempt >= 75)
          throw new AppError('PROFILE_LOCKED', '本地资料正在被另一个启动中的实例使用，请稍后重试', 409);
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    return await startLocked(webDir, profile);
  } finally {
    startup.close();
  }
}

async function startLocked(webDir: string, profile: string) {
  const statePath = join(profile, 'engine.json');
  const lockPath = join(profile, 'engine.lock');
  const describe = (state: EngineState) => ({
    state,
    origin: `http://127.0.0.1:${state.port}`,
    bootstrapUrl: `http://127.0.0.1:${state.port}/bootstrap?token=${state.token}`,
  });
  async function existing() {
    let state: EngineState;
    let data: { app?: string; pid?: number; version?: string };
    try {
      state = JSON.parse(await readFile(statePath, 'utf8')) as EngineState;
      if (
        state.version !== 1 ||
        !Number.isInteger(state.port) ||
        state.port < 1 ||
        state.port > 65535 ||
        !/^[a-f0-9]{64}$/.test(state.token) ||
        !alive(state.pid)
      )
        return undefined;
      const response = await fetch(`http://127.0.0.1:${state.port}/api/v1/health`, {
        headers: { Authorization: `Bearer ${state.token}` },
        signal: AbortSignal.timeout(800),
      });
      data = (await response.json()) as { app?: string; pid?: number; version?: string };
      if (!(response.ok && data.app === 'revanime' && data.pid === state.pid)) return undefined;
    } catch {
      return undefined;
    }
    if (data.version !== APP_VERSION) {
      let acknowledged = false;
      try {
        const response = await fetch(`http://127.0.0.1:${state.port}/api/v1/shutdown`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${state.token}` },
          signal: AbortSignal.timeout(800),
        });
        if (response.ok) {
          const result = (await response.json()) as { shuttingDown?: unknown } | null;
          acknowledged = result?.shuttingDown === true;
        }
      } catch {
        /* A failed or malformed acknowledgement keeps the short handoff deadline. */
      }
      // Audience cleanup may wait for an 8-second join and then an 8-second leave.
      // Keep the old engine's lock in place until it finishes closing its database.
      const deadline = Date.now() + (acknowledged ? 20_000 : 3000);
      while (alive(state.pid) && Date.now() < deadline) {
        const released = await Promise.all(
          [statePath, lockPath].map(async (path) => {
            try {
              await stat(path);
              return false;
            } catch (error) {
              return (error as NodeJS.ErrnoException).code === 'ENOENT';
            }
          }),
        );
        // Embedded engines can close their database while the host process remains alive.
        if (released.every(Boolean)) return undefined;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (alive(state.pid))
        throw new AppError('ENGINE_VERSION', '正在运行的是另一版本，且未能退出，请先手动退出后重开', 409);
      return undefined;
    }
    return state;
  }
  const previous = await existing();
  if (previous) return { ...describe(previous), owned: false as const, close: async () => {} };
  let locked = false;
  for (let attempt = 0; attempt < 75; attempt++) {
    try {
      const lock = await open(lockPath, 'wx', 0o600);
      await lock.writeFile(JSON.stringify({ pid: process.pid }));
      await lock.close();
      locked = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const state = await existing();
      if (state) return { ...describe(state), owned: false as const, close: async () => {} };
      try {
        const info = await stat(lockPath);
        if (info.size === 0) {
          if (Date.now() - info.mtimeMs > 2000) {
            await unlink(lockPath);
            continue;
          }
        } else {
          try {
            const lock = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number };
            if (Number.isInteger(lock.pid) && !alive(lock.pid)) {
              await unlink(lockPath);
              continue;
            }
          } catch {
            if (Date.now() - info.mtimeMs > 2000) {
              await unlink(lockPath);
              continue;
            }
          }
        }
      } catch {
        /* another starter may still be writing the lock */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (!locked) throw new AppError('PROFILE_LOCKED', '本地资料正在被另一个启动中的实例使用，请稍后重试', 409);
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  let closeEngine: () => void | Promise<void> = async () => {};
  try {
    server = await createServer({
      database: join(profile, 'revanime.sqlite'),
      token: randomBytes(32).toString('hex'),
      webDir,
      onShutdown: () => closeEngine(),
    });
    let closed = false;
    let closing: Promise<void> | undefined;
    const close = async () => {
      if (closed) return closing;
      closed = true;
      closing = (async () => {
        server!.app.server.closeAllConnections();
        await server!.app.close();
        await unlink(statePath).catch(() => {});
        await unlink(lockPath).catch(() => {});
      })();
      return closing;
    };
    closeEngine = close;
    await server.app.listen({ host: '127.0.0.1', port: 0 });
    const port = Number(new URL(server.origin()).port);
    const state: EngineState = { version: 1, pid: process.pid, port, token: server.token };
    const temp = statePath + `.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await rename(temp, statePath);
    return { ...describe(state), owned: true as const, close };
  } catch (error) {
    if (server) await server.app.close();
    await unlink(lockPath).catch(() => {});
    throw error;
  }
}
