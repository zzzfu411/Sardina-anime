import { app, BrowserWindow, dialog, Menu, powerMonitor, shell, utilityProcess } from 'electron';
import { join } from 'node:path';

app.setName('Sardina anime');
// Keep the existing Chromium profile and single-instance lock across the rename.
if (!app.commandLine.hasSwitch('user-data-dir'))
  app.setPath('userData', join(app.getPath('appData'), 'Revanime'));
const isMain = app.requestSingleInstanceLock();
let window: BrowserWindow | undefined;
let engine: Electron.UtilityProcess | undefined;
let engineOwned = false;
let quitting = false;
let bootstrapUrl = '';
let engineOrigin = '';
const showWindow = async () => {
  if (window && !window.isDestroyed()) {
    window.show();
    window.focus();
    return;
  }
  if (!bootstrapUrl) return;
  window = new BrowserWindow({
    width: 1380,
    height: 920,
    minWidth: 860,
    minHeight: 620,
    title: 'Sardina anime',
    backgroundColor: '#d8d3cc',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 22, y: 20 },
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (target.protocol === 'https:') void shell.openExternal(target.href);
    } catch {
      /* ignore invalid targets */
    }
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== engineOrigin) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(permission === 'fullscreen'),
  );
  await window.loadURL(bootstrapUrl);
};
if (!isMain) app.quit();
else {
  app.on('second-instance', () => {
    void showWindow();
  });
  app.on('activate', () => {
    void showWindow();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => {
    quitting = true;
    if (engineOwned) engine?.kill();
  });
  void app.whenReady().then(() => {
    powerMonitor.on('resume', () => {
      // Recreate pending media/network requests after sleep; the page restores its persisted position.
      if (window && !window.isDestroyed()) window.webContents.reload();
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'Sardina anime',
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            {
              label: '在浏览器中打开',
              click: () => {
                if (bootstrapUrl) void shell.openExternal(bootstrapUrl);
              },
            },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'quit' },
          ],
        },
        { role: 'editMenu', label: '编辑' },
        { role: 'viewMenu', label: '显示' },
        { role: 'windowMenu', label: '窗口' },
      ]),
    );
    engine = utilityProcess.fork(join(__dirname, '../engine/cli.js'), [], {
      serviceName: 'Sardina anime Engine',
      stdio: 'pipe',
    });
    let ready = false;
    engine.on(
      'message',
      (message: { type: string; origin: string; bootstrapUrl: string; owned: boolean }) => {
        if (message.type !== 'ready') return;
        ready = true;
        engineOwned = message.owned;
        bootstrapUrl = message.bootstrapUrl;
        engineOrigin = message.origin;
        void showWindow();
      },
    );
    engine.on('exit', (code) => {
      if (!quitting && (!ready || (engineOwned && code !== 0))) {
        dialog.showErrorBox(
          'Sardina anime 未能启动',
          '本地引擎启动失败。请检查资料目录是否可写，或重新打开应用。',
        );
        app.quit();
      }
    });
    engine.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  });
}
