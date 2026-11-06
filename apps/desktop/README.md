# CallMeClaude desktop

A tray app for macOS and Linux. It connects to the hub on the same computer the same way the phone apps do, over the local WebSocket. It reads the port and app token from `~/.callmeclaude/config.json`, or from `$CMC_HOME`.

- **Tray icon**:
  - Orange: idle.
  - Amber: a session is waiting for you. On macOS the number of waiting sessions shows next to the icon.
  - Red: automation is paused.
  - Green: Claude is calling, or a call is running, on this computer or on the phone.
  - Gray: the hub is not running.
- **Click the icon** to open the panel: Talk to Claude, where calls go, approvals, mode, sessions, voice language, start at login, and Stop everything. Right-click (or the menu on Linux) has the same options.
- **Where Claude calls you**: **Call this computer**, **Call my phone**, or **Don't call**.
  - With "this computer", the app rings and you answer with the computer's microphone, so no phone is needed.
  - Desk mode still rings here.
  - If the app is closed, the phone rings instead.
- **Voice** runs through the hub's Gemini Live bridge, exactly like a phone call. The microphone is captured as 16 kHz PCM16 and the speaker plays 24 kHz PCM16.

The hub must be set up first (`cmc setup`, see the main README). The Windows build is a client only: the hub does not run on Windows yet.

## Develop

```bash
pnpm install
pnpm --filter @callmeclaude/desktop start       # build + run (Electron downloads on first run)
pnpm --filter @callmeclaude/desktop test
CMC_DESKTOP_SNAPSHOT=/tmp/panel.png pnpm --filter @callmeclaude/desktop exec electron .   # render the panel to a PNG and quit
```

## Package

```bash
pnpm --filter @callmeclaude/desktop dist        # this OS: dmg (macOS), AppImage + deb (Linux), exe (Windows)
```

Builds land in `apps/desktop/release/`.

- The macOS build is ad-hoc signed and not notarized. The first time, open it with right-click → **Open**. A Developer ID is used automatically when `CSC_LINK`/`CSC_KEY_PASSWORD` are set.
- The GitHub workflow `desktop-release` builds all three platforms. It runs on a `desktop-v*` tag, or by hand.

## Layout

| File | |
|---|---|
| `src/main.ts` | Tray, panel window, start at login, notifications, permissions (microphone only) |
| `src/preload.ts` | The page's only bridge to the OS |
| `src/renderer/app.ts` | Hub link, calls, panel UI |
| `src/renderer/audio.ts` | Microphone → hub, hub → speaker, ringtone |
| `src/renderer/icons.ts` | Tray icons (drawn at startup) |
| `src/shared.ts` | Pure logic (tray state, panel position, config, PCM), unit-tested |
