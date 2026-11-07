// The only bridge between the page and the OS: a few named calls, no Node access.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('cmc', {
  hubConfig: () => ipcRenderer.invoke('hub-config'),
  view: (v: unknown) => ipcRenderer.send('view', v),
  icons: (list: unknown) => ipcRenderer.send('icons', list),
  show: () => ipcRenderer.send('show'),
  hide: () => ipcRenderer.send('hide'),
  openRepo: () => ipcRenderer.send('open-repo'),
  loginItem: (on?: boolean) => ipcRenderer.invoke('login-item', on),
  autoAnswer: (on?: boolean) => ipcRenderer.invoke('auto-answer', on),
  micAccess: () => ipcRenderer.invoke('mic-access'),
  platform: () => ipcRenderer.invoke('platform'),
  onCommand: (cb: (c: unknown) => void) => {
    ipcRenderer.on('command', (_e, c) => cb(c));
  },
});
