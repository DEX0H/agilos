// Agilos for Windows: the same game as the web build, in its own window.
// Loads the built game (dist/) through a private app:// protocol, keeps the renderer
// sandboxed with no Node access, and checks GitHub Releases for updates.

const { app, BrowserWindow, protocol, net, shell, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const http = require('node:http');
const crypto = require('node:crypto');

const DIST = path.join(__dirname, '..', 'dist');
const ORIGIN = 'app://agilos';
const AUTH_PAGE = 'https://dex0h.github.io/agilos/auth.html';
const UPDATE_EVERY = 20 * 60 * 1000; // also look for a new release every 20 minutes

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

  ipcMain.handle('agilos:google-sign-in', () => googleSignIn());

  // Always the latest release: check at launch and every 20 minutes, download in the
  // background, install when the game closes (or right away from the menu)
  if (app.isPackaged) {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoInstallOnAppQuit = true;
    let ready = null;
    autoUpdater.on('update-downloaded', (info) => {
      ready = info.version;
      win?.webContents.send('agilos:update-ready', info.version);
    });
    ipcMain.handle('agilos:install-update', () => {
      if (ready) setImmediate(() => autoUpdater.quitAndInstall(true, true));
      return !!ready;
    });
    const check = () => {
      if (readPrefs().autoUpdate && !ready) autoUpdater.checkForUpdates().catch(() => {});
    };
    check();
    setInterval(check, UPDATE_EVERY);
  }
});

// Google sign-in through the system browser: open the sign-in page with a one-time state
// and a port on this computer, wait for it to send the Google ID token back, return it.
function googleSignIn() {
  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(16).toString('hex');
    let done = false;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback' || done) {
        res.writeHead(404).end();
        return;
      }
      const ok = url.searchParams.get('state') === state && url.searchParams.get('id_token');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><meta charset="utf-8"><title>Agilos</title><body style="background:#0b0d12;color:#fff;font:18px system-ui;display:grid;place-items:center;height:100vh;margin:0"><p>${ok ? 'Signed in. You can close this tab and return to Agilos.' : 'Sign-in failed. Try again from the game.'}</p></body>`);
      if (!ok) return;
      done = true;
      clearTimeout(timer);
      server.close();
      if (win) { win.show(); win.focus(); }
      resolve(url.searchParams.get('id_token'));
    });
    const timer = setTimeout(() => {
      done = true;
      server.close();
      reject(Object.assign(new Error('Google sign-in timed out.'), { code: 'auth/timeout' }));
    }, 5 * 60 * 1000);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      shell.openExternal(`${AUTH_PAGE}?port=${port}&state=${state}`);
    });
    server.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

app.on('window-all-closed', () => app.quit());
