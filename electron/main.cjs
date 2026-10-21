// Agilos for Windows: the same game as the web build, in its own window.
// Loads the built game (dist/) through a private app:// protocol, keeps the renderer
// sandboxed with no Node access, and checks GitHub Releases for updates.

const { app, BrowserWindow, protocol, net, shell, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const DIST = path.join(__dirname, '..', 'dist');
const ORIGIN = 'app://agilos';

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// One copy of the game at a time
if (!app.requestSingleInstanceLock()) app.quit();

// Small preferences file: whether to check for updates at launch (the only network call
// the desktop app makes on its own)
const prefsFile = () => path.join(app.getPath('userData'), 'desktop-prefs.json');
function readPrefs() {
  try {
    const p = JSON.parse(fs.readFileSync(prefsFile(), 'utf8'));
    return { autoUpdate: p.autoUpdate !== false };
  } catch {
    return { autoUpdate: true };
  }
}
function writePrefs(prefs) {
  try {
    fs.writeFileSync(prefsFile(), JSON.stringify(prefs));
  } catch {
    // not writable: the setting lasts for this session only
  }
}

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 960,
    minHeight: 540,
    backgroundColor: '#05070a',
    title: 'Agilos',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep the game loop at full speed when unfocused
      spellcheck: false,
    },
  });
  win.removeMenu();
  win.once('ready-to-show', () => win.show());

  // Only the game itself loads in this window; web links open in the browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`${ORIGIN}/`)) e.preventDefault();
  });

  // F11 toggles fullscreen
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      e.preventDefault();
    }
  });

  win.loadURL(`${ORIGIN}/index.html`);
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(() => {
  // app://agilos/<path> serves files from dist/, never outside it
  protocol.handle('app', (req) => {
    const { host, pathname } = new URL(req.url);
    if (host !== 'agilos') return new Response('Not found', { status: 404 });
    const file = path.normalize(path.join(DIST, decodeURIComponent(pathname)));
    if (!file.startsWith(DIST + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  createWindow();
  // Pointer lock and fullscreen are what the game needs; anything else the page might
  // ask for (camera, notifications, ...) is refused
  win.webContents.session.setPermissionRequestHandler((_wc, permission, done) => {
    done(permission === 'pointerLock' || permission === 'fullscreen');
  });

  ipcMain.handle('agilos:info', () => ({ version: app.getVersion(), ...readPrefs() }));
  ipcMain.handle('agilos:set-auto-update', (_e, on) => {
    writePrefs({ ...readPrefs(), autoUpdate: !!on });
    return readPrefs();
  });

  if (app.isPackaged && readPrefs().autoUpdate) {
    // Downloads a newer release in the background and installs it when the game closes
    const { autoUpdater } = require('electron-updater');
    autoUpdater.on('update-downloaded', (info) => {
      win?.webContents.send('agilos:update-ready', info.version);
    });
    autoUpdater.checkForUpdates().catch(() => {});
  }
});

app.on('window-all-closed', () => app.quit());
