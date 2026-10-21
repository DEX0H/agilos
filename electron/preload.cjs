// The only bridge between the game page and the desktop app: version, the update
// setting, and a notice when an update is ready. No Node or Electron APIs reach the page.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agilosDesktop', {
  info: () => ipcRenderer.invoke('agilos:info'),
  setAutoUpdate: (on) => ipcRenderer.invoke('agilos:set-auto-update', !!on),
  onUpdateReady: (fn) => ipcRenderer.on('agilos:update-ready', (_e, version) => fn(String(version))),
  installUpdate: () => ipcRenderer.invoke('agilos:install-update'),
  googleSignIn: () => ipcRenderer.invoke('agilos:google-sign-in'),
});
