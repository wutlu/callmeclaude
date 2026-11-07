// CallMeClaude desktop: a tray app that is one more client of the local hub (like the phone app).
// The renderer holds the hub WebSocket and the audio; this process owns the tray, the window and OS glue.
import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, screen, session, shell, systemPreferences, Tray, type MenuItemConstructorOptions, type NativeImage } from 'electron';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { autostartEntry, DONE_ALERTS, hubDataDir, MODES, panelPosition, parseHubConfig, parseSettings, RING_TARGETS, stateLabel, trayLook, type DesktopSettings, type TrayTone, type View } from './shared.ts';

const SIZE = { width: 380, height: 620 };
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
const REPO = 'https://github.com/wutlu/callmeclaude';

let win: BrowserWindow | undefined;
let tray: Tray | undefined;
let view: View = { link: 'offline' };
let quitting = false;
/** Tray images per tone, drawn by the renderer (canvas) once it loads. */
const icons = new Map<TrayTone, NativeImage>();
let lastRinging: string | undefined;
let settings: DesktopSettings | undefined;

// A screenshot run may happen next to the installed app, so it does not take the single-instance lock.
if (!process.env.CMC_DESKTOP_SNAPSHOT && !app.requestSingleInstanceLock()) app.quit();
else start();

function start() {
  // Launching the app again (Dock, Start menu, app launcher) opens the panel of the running one.
  app.on('second-instance', () => showWindow());
  app.on('activate', () => showWindow());
  app.on('before-quit', () => (quitting = true));
  // A tray app: closing the window does not quit.
  app.on('window-all-closed', () => {});

  app.whenReady().then(() => {
    if (isMac) app.dock?.hide();
    lockDown();
    createWindow();
    createTray();
    ipc();
    if (!process.argv.includes('--hidden') && !app.getLoginItemSettings().wasOpenedAtLogin) win!.once('ready-to-show', () => showWindow());
    // Smoke test / screenshots: render the panel, save it as PNG, quit (CMC_DESKTOP_SNAPSHOT=/path/out.png).
    const shot = process.env.CMC_DESKTOP_SNAPSHOT;
    if (shot) {
      win!.webContents.once('did-finish-load', () =>
        setTimeout(async () => {
          // Capturing a hidden window sometimes fails under Xvfb (UnknownVizError): retry, then exit 1, never hang.
          // CMC_DESKTOP_SNAPSHOT_SCROLL=px shows the lower part of the panel.
          const scroll = Number(process.env.CMC_DESKTOP_SNAPSHOT_SCROLL ?? 0);
          if (scroll) {
            await win!.webContents.executeJavaScript(`document.querySelector('main').scrollTop = ${scroll}`);
            await new Promise((r) => setTimeout(r, 500)); // let it paint
          }
          for (let i = 1; ; i++) {
            try {
              writeFileSync(shot, (await win!.webContents.capturePage()).toPNG());
              break;
            } catch (e) {
              console.error(`snapshot attempt ${i} failed: ${(e as Error).message}`);
              if (i === 5) return app.exit(1);
              await new Promise((r) => setTimeout(r, 1000));
            }
          }
          console.log(`snapshot ${shot} tray=${icons.size} link=${view.link}`);
          quitting = true;
          app.quit();
        }, Number(process.env.CMC_DESKTOP_SNAPSHOT_DELAY ?? 2500)),
      );
    }
  });
}

/** The page may only use the microphone; it never navigates or opens windows. */
function lockDown() {
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const ok = wc === win?.webContents && permission === 'media' && (details as any).mediaTypes?.every((t: string) => t === 'audio');
    cb(!!ok);
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) => wc === win?.webContents && permission === 'media');
  app.on('web-contents-created', (_e, wc) => {
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
}

function createWindow() {
  win = new BrowserWindow({
    ...SIZE,
    show: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: isLinux,
    skipTaskbar: !isLinux,
    title: 'CallMeClaude',
    backgroundColor: '#121214',
    icon: join(__dirname, 'icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // The window is hidden most of the time but keeps the hub link and rings.
      backgroundThrottling: false,
    },
  });
  win.removeMenu();
  void win.loadFile(join(__dirname, 'renderer', 'index.html'));
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win!.hide();
    }
  });
  // A popover panel: clicking elsewhere hides it, unless a call is ringing or running here.
  win.on('blur', () => {
    if (!isLinux && !view.local && !win!.webContents.isDevToolsOpened()) win!.hide();
  });
}

function showWindow() {
  if (!win) return;
  if (!isLinux && tray) {
    const b = tray.getBounds();
    if (b.width) {
      const work = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
      const { x, y } = panelPosition(b, SIZE, work);
      win.setPosition(x, y, false);
    } else win.center();
  }
  win.show();
  win.focus();
}

function toggleWindow() {
  if (win?.isVisible() && win.isFocused()) win.hide();
  else showWindow();
}

function createTray() {
  // Until the renderer draws the real icons: the app icon, small.
  const fallback = nativeImage.createFromPath(join(__dirname, 'icon.png')).resize({ width: 18, height: 18 });
  tray = new Tray(fallback);
  tray.setToolTip('CallMeClaude');
  if (isLinux) {
    // Most Linux trays (AppIndicator) only show a menu; the menu has "Open CallMeClaude".
    tray.setContextMenu(buildMenu());
  } else {
    tray.on('click', toggleWindow);
    tray.on('right-click', () => tray!.popUpContextMenu(buildMenu()));
  }
}

/** Send a command for the hub to the renderer (it owns the socket). */
function command(c: object) {
  win?.webContents.send('command', c);
}

function buildMenu(): Menu {
  const s = view.snapshot;
  const online = view.link === 'online' && !!s;
  const items: MenuItemConstructorOptions[] = [];
  const look = trayLook(view);
  items.push({ label: look.tooltip.replace(/^CallMeClaude: /, ''), enabled: false });
  items.push({ type: 'separator' });

  if (view.local?.state === 'ringing') {
    items.push({ label: 'Answer on this computer', click: () => command({ type: 'answer' }) });
    items.push({ label: 'Decline', click: () => command({ type: 'decline' }) });
  } else if (view.local) {
    items.push({ label: view.local.muted ? 'Unmute' : 'Mute', click: () => command({ type: 'mute' }) });
    items.push({ label: 'Hang up', click: () => command({ type: 'hangup' }) });
  } else {
    items.push({ label: 'Talk to Claude here', enabled: online && !s!.call, click: () => command({ type: 'talk' }) });
  }
  items.push({ type: 'separator' });

  for (const t of RING_TARGETS) {
    items.push({ label: t.label, type: 'radio', checked: s?.ringTarget === t.id, enabled: online, click: () => command({ type: 'ring.set', target: t.id }) });
  }
  items.push({ type: 'separator' });

  if (online) {
    if (s!.doneAlert) {
      items.push({
        label: `Spoken alert when done: ${DONE_ALERTS.find((a) => a.id === s!.doneAlert)?.label ?? s!.doneAlert}`,
        submenu: DONE_ALERTS.map((a) => ({ label: a.label, type: 'radio' as const, checked: s!.doneAlert === a.id, click: () => command({ type: 'alert.set', target: a.id }) })),
      });
    }
    items.push({
      label: `Mode: ${MODES.find((m) => m.id === s!.mode)?.label ?? s!.mode}`,
      submenu: MODES.map((m) => ({ label: `${m.label} — ${m.hint}`, type: 'radio' as const, checked: s!.mode === m.id, click: () => command({ type: 'mode.set', mode: m.id }) })),
    });
    for (const p of s!.pending.slice(0, 8)) {
      items.push({
        label: `⚠︎ ${p.project}${p.background ? ' (background)' : ''}: ${clipText(p.summary, 50)}`,
        submenu: [
          { label: clipText(p.summary, 120), enabled: false },
          { type: 'separator' },
          // A waiting session needs a written reply (in the panel), not a bare yes.
          ...(p.kind === 'permission'
            ? [
                { label: 'Approve', click: () => command({ type: 'pending.resolve', pendingId: p.id, decision: 'approve' }) },
                { label: 'Deny', click: () => command({ type: 'pending.resolve', pendingId: p.id, decision: 'deny' }) },
              ]
            : [{ label: 'Reply…', click: () => showWindow() }]),
          { label: 'Let it stop', click: () => command({ type: 'pending.resolve', pendingId: p.id, decision: 'release' }) },
        ],
      });
    }
    items.push({
      label: `Sessions (${s!.sessions.length})`,
      enabled: s!.sessions.length > 0,
      submenu: s!.sessions.slice(0, 20).map((x) => ({ label: `${x.project}${x.background ? ' (background)' : ''} — ${stateLabel(x.state)}`, sublabel: clipText(x.summary, 80), enabled: false })),
    });
    items.push(s!.paused ? { label: 'Resume automation', click: () => command({ type: 'resume' }) } : { label: 'Stop everything…', click: () => showWindow() });
    items.push({ type: 'separator' });
  }

  items.push({ label: 'Open CallMeClaude', click: () => showWindow() });
  items.push({ label: 'Answer calls automatically', type: 'checkbox', checked: getSettings().autoAnswer, click: (i) => setAutoAnswer(i.checked) });
  items.push({ label: 'Start at login', type: 'checkbox', checked: loginItem(), click: (i) => setLoginItem(i.checked) });
  items.push({ label: 'Source code (MIT)', click: () => void shell.openExternal(REPO) });
  items.push({ label: 'Quit', click: () => app.quit() });
  return Menu.buildFromTemplate(items);
}

function clipText(t: string, n: number) {
  const one = t.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

function refreshTray() {
  if (!tray) return;
  const look = trayLook(view);
  const img = icons.get(look.tone);
  if (img) tray.setImage(img);
  tray.setToolTip(look.tooltip);
  if (isMac) tray.setTitle(look.badge, { fontType: 'monospacedDigit' });
  if (isLinux) tray.setContextMenu(buildMenu());
}

function onView(v: View) {
  const prev = view;
  view = v;
  refreshTray();
  // Ringing here: bring the panel forward and notify (once per call).
  if (v.local?.state === 'ringing' && lastRinging !== v.local.callId) {
    lastRinging = v.local.callId;
    showWindow();
    win?.setAlwaysOnTop(true, 'floating');
    if (Notification.isSupported()) {
      const n = new Notification({ title: 'Claude is calling', body: v.snapshot?.call?.title ?? 'Open CallMeClaude to answer.', silent: true });
      n.on('click', () => showWindow());
      n.show();
    }
  }
  if (prev.local && !v.local) win?.setAlwaysOnTop(false);
}

function loginItem(): boolean {
  if (isLinux) return existsSync(autostartPath());
  return app.getLoginItemSettings().openAtLogin;
}

function autostartPath() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'autostart', 'callmeclaude.desktop');
}

function setLoginItem(on: boolean) {
  if (isLinux) {
    const p = autostartPath();
    if (on) {
      mkdirSync(join(p, '..'), { recursive: true });
      // An AppImage runs from a temporary mount; APPIMAGE is the file the user keeps.
      writeFileSync(p, autostartEntry(process.env.APPIMAGE || process.execPath));
    } else rmSync(p, { force: true });
  } else {
    // Windows passes --hidden; macOS reports wasOpenedAtLogin instead. Either way the panel stays closed at login.
    app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] });
  }
  refreshTray();
}

function settingsPath() {
  return join(app.getPath('userData'), 'settings.json');
}

function getSettings(): DesktopSettings {
  if (!settings) {
    const p = settingsPath();
    settings = parseSettings(existsSync(p) ? readFileSync(p, 'utf8') : undefined);
  }
  return settings;
}

function setAutoAnswer(on: boolean) {
  settings = { ...getSettings(), autoAnswer: on };
  try {
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify(settings, null, 2) + '\n');
  } catch (e) {
    console.error(`could not save settings: ${(e as Error).message}`);
  }
  // The tray menu changed it: the panel shows the switch (and answers a call ringing right now).
  command({ type: 'auto-answer', on });
  refreshTray();
}

function ipc() {
  ipcMain.handle('hub-config', () => {
    const dir = hubDataDir(homedir(), process.env);
    const path = join(dir, 'config.json');
    const text = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    return parseHubConfig(text) ?? null;
  });
  ipcMain.on('view', (e, v: View) => {
    if (e.sender === win?.webContents) onView(v);
  });
  ipcMain.on('icons', (e, list: Array<{ tone: TrayTone; x1: string; x2: string; template: boolean }>) => {
    if (e.sender !== win?.webContents) return;
    for (const i of list) {
      const img = nativeImage.createEmpty();
      img.addRepresentation({ scaleFactor: 1, dataURL: i.x1 });
      img.addRepresentation({ scaleFactor: 2, dataURL: i.x2 });
      if (isMac && i.template) img.setTemplateImage(true);
      icons.set(i.tone, img);
    }
    refreshTray();
  });
  ipcMain.on('show', () => showWindow());
  ipcMain.on('hide', () => win?.hide());
  ipcMain.on('open-repo', () => void shell.openExternal(REPO));
  ipcMain.handle('login-item', (_e, on?: boolean) => {
    if (typeof on === 'boolean') setLoginItem(on);
    return loginItem();
  });
  ipcMain.handle('auto-answer', (e, on?: boolean) => {
    if (e.sender === win?.webContents && typeof on === 'boolean') setAutoAnswer(on);
    return getSettings().autoAnswer;
  });
  // macOS asks once for the microphone; elsewhere the permission handler above decides.
  ipcMain.handle('mic-access', async () => (isMac ? systemPreferences.askForMediaAccess('microphone') : true));
  ipcMain.handle('platform', () => process.platform);
}
