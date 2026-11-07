# CallMeClaude desktop

A tray app for macOS and Linux. It connects to the hub on the same computer the same way the phone apps do, over the local WebSocket. It reads the port and app token from `~/.callmeclaude/config.json`, or from `$CMC_HOME`.

- **Tray icon**:
  - Orange: idle.
  - Amber: a session is waiting for you. On macOS the number of waiting sessions shows next to the icon.
  - Red: automation is paused.
  - Green: Claude is calling, or a call is running, on this computer or on the phone.
  - Gray: the hub is not running.
- **Click the icon** to open the panel. It has two tabs:
  - **Home**: Talk to Claude, decisions waiting for you (with how long each one still waits), mode, sessions, and Stop everything. Sessions that need you come first; finished ones older than 6 hours fold under **Earlier**. Click a session to read its whole summary.
  - **Settings**: where calls go, the spoken alert when a session finishes, voice language, answering automatically, and start at login.
  - Right-click the icon (or use the menu on Linux) for the same options.
- **Where Claude calls you**: **Call this computer**, **Call my phone**, or **Don't call**.
  - With "this computer", the app rings and you answer with the computer's microphone, so no phone is needed.
  - **Answer calls automatically** (Settings, or the tray menu) picks the call up after 4 seconds of ringing, hands-free. Decline still works while it rings. The choice is kept by the app on this computer.
  - Desk mode still rings here.
  - If the app is closed, the phone rings instead.
- **Voice** runs through the hub's Gemini Live bridge, exactly like a phone call. The microphone is captured as 16 kHz PCM16 and the speaker plays 24 kHz PCM16.

The hub must be set up first (`cmc setup`, see the main README). The Windows build is a client only: the hub does not run on Windows yet.

## Install

Download the file for your computer from the [latest desktop release](https://github.com/wutlu/callmeclaude/releases?q=desktop-v&expanded=true):

| Computer | File |
|---|---|
| Mac with Apple silicon (M1 or later) | `CallMeClaude-<version>-mac-arm64.dmg` |
| Mac with an Intel processor | `CallMeClaude-<version>-mac-x64.dmg` |
| Linux, any distribution | `CallMeClaude-<version>-linux-x86_64.AppImage` |
| Debian, Ubuntu, Mint | `CallMeClaude-<version>-linux-amd64.deb` |

**macOS: the first open shows a warning.** The app is not signed with an Apple Developer ID and not notarized, so macOS says it can't check the app for malware (or, on some Macs, that the app "is damaged"). The app is fine. To open it once:

1. Open the dmg and drag **CallMeClaude** to **Applications**.
2. Open CallMeClaude. When the warning appears, click **Done** (not **Move to Trash**).
3. Open **System Settings → Privacy & Security**, scroll down to the message about CallMeClaude, click **Open Anyway**, and confirm with your password.

On macOS 14 and earlier, right-clicking the app and choosing **Open** works too. If macOS says the app "is damaged", or there is no **Open Anyway** button, run this once in Terminal, then open the app normally:

```bash
xattr -dr com.apple.quarantine /Applications/CallMeClaude.app
```

After the first open, macOS no longer asks. On the first call it asks for microphone access; allow it so you can talk on this computer.

**Linux:** make the AppImage executable (`chmod +x CallMeClaude-*.AppImage`) and run it, or install the deb with `sudo apt install ./CallMeClaude-*.deb`.

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

- The macOS build is ad-hoc signed and not notarized; see [Install](#install) for the first open. A Developer ID is used automatically when `CSC_LINK`/`CSC_KEY_PASSWORD` are set.
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
