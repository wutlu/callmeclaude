# Installation

This guide takes you from zero to "my phone rings when Claude Code gets stuck" in about 30 minutes. Each step ends with a check you can run.

Sections 1–10 set up a **Mac** hub with an **iPhone**. For a **Linux** hub follow [Linux hub](#linux-hub); for an **Android** phone see [Android app](#android-app). Any phone works with either hub.

**Contents**

1. [Prerequisites](#1-prerequisites)
2. [Install the hub on your Mac](#2-install-the-hub-on-your-mac)
3. [Voice: Gemini API key](#3-voice-gemini-api-key)
4. [Install the iPhone app](#4-install-the-iphone-app)
5. [Let the Mac ring your phone: APNs key](#5-let-the-mac-ring-your-phone-apns-key)
6. [Pair the phone](#6-pair-the-phone)
7. [Reach your Mac from anywhere: Tailscale](#7-reach-your-mac-from-anywhere-tailscale)
8. [macOS permissions for computer use](#8-macos-permissions-for-computer-use)
9. [Keep the Mac awake while you are away](#9-keep-the-mac-awake-while-you-are-away)
10. [First test](#10-first-test)
- [Linux hub](#linux-hub): [requirements](#l1-requirements) · [install](#l2-install-the-hub) · [linger and sleep](#l3-keep-the-hub-running-linger-and-sleep) · [pairing](#l4-pair-the-phone) · [Tailscale](#l5-reach-the-hub-from-anywhere-tailscale) · [computer use](#l6-computer-use-on-linux) · [ydotool](#l7-optional-mouse-and-keyboard-on-wayland-ydotool) · [first test](#l8-first-test)
- [Android app](#android-app)
- [Troubleshooting](#troubleshooting) · [Honest limits](#honest-limits) · [Uninstall](#uninstall)

---

## 1. Prerequisites

| | Install |
|---|---|
| macOS 15+ and Xcode 16+ | App Store |
| Homebrew | https://brew.sh |
| Node.js 22.5+ and pnpm | `brew install node pnpm` (or nvm) |
| Claude Code, logged in to **your own** Pro/Max plan | https://claude.com/claude-code, then run `claude` once and log in |
| Tools used by the hub | `brew install tmux cliclick xcodegen steipete/tap/peekaboo` |
| A paid Apple Developer account | https://developer.apple.com/programs/ (VoIP push needs it; free accounts can't receive VoIP pushes and their builds expire after 7 days) |

Check: `claude --version && node --version && tmux -V && xcodegen --version`

## 2. Install the hub on your Mac

```bash
git clone https://github.com/wutlu/callmeclaude.git
cd callmeclaude
pnpm install
ln -s "$PWD/apps/mac-agent/bin/cmc.mjs" /opt/homebrew/bin/cmc   # or anywhere on your PATH
cmc setup
```

`cmc setup` does three things:

- **Merges** CallMeClaude's HTTP hooks into `~/.claude/settings.json`. It backs the file up first (`settings.json.cmc-backup-*`) and never touches your other hooks. `cmc uninstall` removes only its own hooks.
- Installs a **launchd agent** (`~/Library/LaunchAgents/dev.callmeclaude.hub.plist`) that starts at login and restarts if it crashes.
- Creates `~/.callmeclaude/` (config, state, logs, audit). It starts in **away mode**: once a phone is paired, a session that finishes, gets stuck or asks for permission is held and your phone rings. Run `cmc mode desk` while you sit at the computer to only watch sessions without holding or calling.

Check: `cmc status` lists your open Claude Code sessions (start one with `claude` in any folder).

## 3. Voice: Gemini API key

1. Create a key at https://aistudio.google.com/apikey.
2. Store it in the macOS Keychain:
   ```bash
   cmc setup --gemini-key <YOUR_KEY> --no-hooks --no-service
   ```

The voice model is `gemini-3.8-live` by default; change it with `--model`. The key never leaves your Mac except to call Google directly.

**Conversation language.** Claude speaks English by default. To use another language, run `cmc setup --language tr-TR --no-hooks --no-service` (any BCP-47 code, e.g. `de-DE`, `es-ES`, `ja-JP`), choose it in the app under Settings → Voice language, or tell Claude on a call: "from now on speak Turkish". The app UI and CLI stay in English.

Check: `cmc doctor` shows `✅ Gemini API key`.

## 4. Install the iPhone app

Connect the iPhone with a USB cable, unlock it, and tap "Trust this computer". Then run:

```bash
./scripts/ios-install.sh
```

The script asks for your **Apple Team ID** and a **unique bundle id** (for example `com.yourname.callmeclaude`) and writes them to `apps/ios/Config/Local.xcconfig`, which is git-ignored. It then generates the Xcode project, builds with automatic signing (`-allowProvisioningUpdates` creates a provisioning profile with Push enabled), and installs and launches the app on the connected iPhone.

You can find your Team ID at https://developer.apple.com/account → Membership details. Xcode must be signed in to that account (Xcode → Settings → Accounts).

On first launch, allow **Microphone**, **Camera** (for the QR code) and **Local Network**. Also enable Settings → CallMeClaude → **Siri & Search** if you want the "Hey Siri, call CallMeClaude" shortcut.

To do the same steps by hand, see [apps/ios/README.md](apps/ios/README.md).

## 5. Let the Mac ring your phone: APNs key

Without this step you can still call the hub from the app, but the hub can only call you while the app is open in the foreground.

1. Go to https://developer.apple.com/account/resources/authkeys/list, click **+**, tick **Apple Push Notifications service (APNs)**, then **Configure**. Choose environment **Sandbox & Production** and **Team Scoped**, then **Save → Continue → Register → Download**. You can download the `.p8` file only once, so keep it safe.
   - One APNs key works for every app in your team. If you already have one (Apple allows only a few), reuse it.
2. Store it in the Keychain:
   ```bash
   cmc setup --no-hooks --no-service \
     --apns-key-file ~/Downloads/AuthKey_XXXXXXXXXX.p8 \
     --apns-key-id XXXXXXXXXX \
     --team-id <TEAM_ID> \
     --bundle-id <the bundle id from step 4> \
     --apns-env development      # Xcode-installed builds use the APNs sandbox
   cmc restart
   ```
3. Delete the downloaded `.p8` from your Downloads folder if you like; the hub keeps its copy in the Keychain.

Check: `cmc doctor` shows `✅ APNs` and, after pairing, `✅ Phone registered (VoIP token)`.

## 6. Pair the phone

```bash
cmc pair
```

A QR code appears in the terminal and in a window. In the app, tap **Pair Mac** and scan it. The QR contains the hub's addresses (Tailscale IP and name, LAN IP) and a random access token. Anyone holding this token can talk to your hub, so don't share it. Run `cmc pair --rotate` to issue a new token; the old pairing then stops working.

Check: the app shows a green dot and "Connected: <your Mac>".

## 7. Reach your Mac from anywhere: Tailscale

The phone talks to the Mac directly, with no relay in between. To make that work on cellular:

1. Install Tailscale on the Mac (Mac App Store, or `brew install --cask tailscale-app`) and log in.
2. Install Tailscale on the iPhone (App Store) and log in with **the same account**. Keep the VPN on.
3. Run `cmc pair` again and re-scan, so the QR includes the Tailscale addresses.

Check: turn Wi-Fi off on the phone, tap **Call Claude**, and ask "what's the status?".

## 8. macOS permissions for computer use

The hub can operate the Mac for you (`cmc do "…"` or "click submit" on a call). It runs as `node` under launchd, so macOS needs to trust that binary:

- System Settings → Privacy & Security → **Screen & System Audio Recording** → add and enable your `node` binary (`cmc doctor` prints its path, e.g. `~/.nvm/versions/node/v24.x/bin/node` or `/opt/homebrew/bin/node`).
- Same place → **Accessibility** → add and enable `node`.
- Allow the "node wants to control System Events" prompt when it appears.
- Peekaboo has its own permissions: `peekaboo permissions`.

Check: `cmc do "Which app is in front? Just look, don't click."` names the correct window.

## 9. Keep the Mac awake while you are away

```bash
# no system sleep (asks for your password)
osascript -e 'do shell script "pmset -a sleep 0" with administrator privileges'
# desktops only: power back on after a power cut
osascript -e 'do shell script "pmset -a autorestart 1" with administrator privileges'
# laptops: don't sleep with the lid closed (undo with disablesleep 0)
osascript -e 'do shell script "pmset -a disablesleep 1" with administrator privileges'
```

Leave a laptop on its charger; the battery acts as a UPS. Give a desktop a UPS. If FileVault is on, the Mac needs your password after an unplanned reboot, so the hub can't start until someone types it in. A UPS avoids that situation. For a long trip, also add a backup internet connection (a 4G/5G router). See [docs/09-unattended-operation.md](docs/09-unattended-operation.md) for the full pre-trip checklist.

## 10. First test

```bash
cmc doctor             # everything ✅
cmc call-me            # lock your phone first: it should ring like a normal call
cmc mode away          # now stuck or finished sessions call you (ride = shorter sentences)
cmc run . "Create hello.txt, then ask me whether to also create bye.txt and stop."
```

The last command starts a Claude Code session in tmux. When it asks its question, your phone rings. Answer "yes, create it", and the session continues.

---

## Linux hub

The hub is the same program on Linux. What differs: it runs as a **systemd `--user` service** instead of launchd, keeps its keys in your **keyring through libsecret** (`secret-tool`) instead of the Keychain, tmux is **optional**, and computer use goes through Claude in Chrome plus the screenshot and input tools of your desktop. Supported: Ubuntu 22.04+, Debian 12+, Fedora, Linux Mint 21+ and Arch, on X11 or Wayland, with GNOME, KDE or a wlroots-based desktop (Sway, Hyprland).

Commands work on every distribution unless they are labelled **Debian/Ubuntu/Mint**, **Fedora** or **Arch**. `cmc doctor` prints the right install command for your distribution, and it only checks and advises: it never runs `sudo` or changes the system.

### L1. Requirements

| | Debian / Ubuntu / Mint | Fedora | Arch |
|---|---|---|---|
| Node.js 22.5+ | Ubuntu 22.04, Mint 21 and Debian 12 ship an older Node: use [nvm](https://github.com/nvm-sh/nvm) (`nvm install 22`) | `sudo dnf install nodejs` (check `node --version`; else nvm) | `sudo pacman -S nodejs` |
| pnpm | `corepack enable pnpm` (Node 22 and 24 include corepack; with a system-wide Node in `/usr` it needs `sudo`) | same | same |
| Claude Code, logged in to **your own** Pro/Max plan | https://claude.com/claude-code, then run `claude` once and log in | same | same |
| git | `sudo apt install git` | `sudo dnf install git` | `sudo pacman -S git` |
| `secret-tool` | `sudo apt install libsecret-tools` | `sudo dnf install libsecret` | `sudo pacman -S libsecret` |
| A Secret Service provider: **KDE Plasma** already has one (KDE Wallet), nothing to add; GNOME and other desktops: GNOME Keyring (or KeePassXC) | `sudo apt install gnome-keyring` | `sudo dnf install gnome-keyring` | `sudo pacman -S gnome-keyring` |
| tmux (optional) | `sudo apt install tmux` | `sudo dnf install tmux` | `sudo pacman -S tmux` |
| Computer use, X11 | `sudo apt install scrot xdotool xclip` | `sudo dnf install scrot xdotool xclip` | `sudo pacman -S scrot xdotool xclip` |
| Computer use, Wayland + KDE | `sudo apt install kde-spectacle wl-clipboard` | `sudo dnf install spectacle wl-clipboard` | `sudo pacman -S spectacle wl-clipboard` |
| Computer use, Wayland + Sway / Hyprland | `sudo apt install grim wl-clipboard` | `sudo dnf install grim wl-clipboard` | `sudo pacman -S grim wl-clipboard` |
| Mouse and keyboard on Wayland (optional) | ydotool 1.x, see [L7](#l7-optional-mouse-and-keyboard-on-wayland-ydotool) | same | same |
| Spoken "task complete" alerts on this computer (optional) | `sudo apt install speech-dispatcher espeak-ng` | `sudo dnf install speech-dispatcher espeak-ng` | `sudo pacman -S speech-dispatcher espeak-ng` |
| Finding the computer by name after a Wi-Fi change (optional, `<host>.local`) | `sudo apt install avahi-daemon` | `sudo dnf install avahi` | `sudo pacman -S avahi`, then `sudo systemctl enable --now avahi-daemon` |
| Desktop tray app as an AppImage ([apps/desktop](apps/desktop/README.md)) | Ubuntu 22.04 / Debian 12: `sudo apt install libfuse2`; Ubuntu 24.04+: `sudo apt install libfuse2t64` | `sudo dnf install fuse-libs` | `sudo pacman -S fuse2` |
| Tray icon on GNOME | the AppIndicator extension (Ubuntu ships it; Debian: `sudo apt install gnome-shell-extension-appindicator`) | `sudo dnf install gnome-shell-extension-appindicator` | `sudo pacman -S gnome-shell-extension-appindicator` |

KDE Wallet provides the Secret Service on KDE Plasma, so `secret-tool` stores the keys there and gnome-keyring is not needed. On X11, `import` (ImageMagick) or `maim` work instead of `scrot`, and `xsel` instead of `xclip`. `xclip` / `wl-clipboard` let the agent type text in any language ([L6](#l6-computer-use-on-linux)). GNOME on Wayland has no screenshot tool the hub can use (see [Honest limits](#honest-limits)).

Spoken alerts: speech-dispatcher (`spd-say`) is used when it is there, else espeak-ng or espeak, which sound robotic on their own; `cmc doctor` shows which one speaks. The hub gives the phone `<host>.local` too, so it can find the computer again after a Wi-Fi change; that name only works while avahi-daemon (or systemd-resolved with MulticastDNS) answers it, and `cmc doctor` says when nothing does. The AppImage can also run without FUSE: `./CallMeClaude-*.AppImage --appimage-extract-and-run`.

Check: `node --version && pnpm --version && claude --version && command -v secret-tool`

### L2. Install the hub

```bash
git clone https://github.com/wutlu/callmeclaude.git
cd callmeclaude
pnpm install
mkdir -p ~/.local/bin
ln -s "$PWD/apps/mac-agent/bin/cmc.mjs" ~/.local/bin/cmc   # or anywhere on your PATH
read -rs -p 'Gemini API key: ' KEY; echo                  # paste the key; it is not shown and not saved in the shell history
cmc setup --gemini-key "$KEY" --language en-US
unset KEY
```

Typing the key itself on the command line (`cmc setup --gemini-key AIza…`) saves it in your shell history (`~/.bash_history`, `~/.zsh_history`). `read -s` keeps it out of the history; while `cmc setup` runs, the key is still briefly visible in the process list to other users of this computer.

If your shell does not find `cmc`, add `~/.local/bin` to your `PATH`. The service itself always has `~/.local/bin`, `/usr/local/bin`, `/usr/bin`, `/bin` and the directory of the `node` that ran `cmc setup` on its `PATH`.

`cmc setup` on Linux:

- **Merges** the HTTP hooks into `~/.claude/settings.json`, exactly as on macOS (backup first, other hooks untouched).
- **Asks one question:** should sessions you start by voice run in **tmux** (watch them with `tmux attach`) or **headless** (a background `claude -p`, no tmux needed)? Press Enter for the default (tmux if it is installed, headless otherwise), or type `1` or `2`; any other answer asks again. Skip the question with `--tmux` or `--no-tmux`. Without a terminal (for example in a script) it picks tmux if installed, headless otherwise.
- **Stores the Gemini key** in your keyring with `secret-tool`. If there is no `secret-tool` or no unlocked keyring, setup says so and stores nothing: CallMeClaude never writes keys to plain-text files. See [Troubleshooting › Linux](#linux) for a locked keyring.
- Installs a **systemd user service**, `~/.config/systemd/user/dev.callmeclaude.hub.service` (`Restart=always`, logs in `~/.callmeclaude/logs/systemd.*.log`), and starts it with `systemctl --user enable --now`.
- Says that APNs is not configured. That only matters for an **iPhone**: without APNs it rings only while the app is open. The Android app is not affected.

**Project roots.** Sessions you start by voice ("start a session in callmeclaude") run only inside a folder listed in `projectRoots`: the hub looks for the project there, and refuses folders outside them. When the config is first created, the Linux defaults are the folders that exist among `~/projects`, `~/Desktop/projects`, `~/Desktop/Projects`, `~/Documents/projects`, `~/Documents/Projects`, `~/workspace`, `~/repos`, `~/git`, `~/Projects`, `~/code`, `~/dev`, `~/src`, `~/Developer`, `~/Projeler` and `~/Desktop/Projeler`. `cmc doctor` shows the current list. To change it, edit `projectRoots` in `~/.callmeclaude/config.json` (a config created earlier keeps its saved list), then restart the service:

```bash
# in ~/.callmeclaude/config.json:  "projectRoots": ["/home/you/projects", "/home/you/work"],
systemctl --user restart dev.callmeclaude.hub
```

Check: `systemctl --user status dev.callmeclaude.hub` shows `active (running)`, `cmc status` lists your Claude Code sessions, and `cmc doctor` lists your project roots.

### L3. Keep the hub running: linger and sleep

`cmc doctor` checks these three settings and prints the commands; you run them yourself.

```bash
# start your user services at boot, without logging in (the hub survives a reboot)
sudo loginctl enable-linger "$USER"
# no system sleep (undo with: sudo systemctl unmask …)
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
# laptops: don't sleep with the lid closed (takes effect after a reboot)
sudo mkdir -p /etc/systemd/logind.conf.d
printf '[Login]\nHandleLidSwitch=ignore\nHandleLidSwitchExternalPower=ignore\n' | sudo tee /etc/systemd/logind.conf.d/callmeclaude-lid.conf
```

Masked sleep targets also stop the suspend that your desktop's power settings would start. That is the permanent way.

**Just for this trip, without `sudo`:** block sleep only while you are away. Run this in a terminal of your desktop session and leave it open; Ctrl+C (or closing the terminal) ends the block:

```bash
systemd-inhibit --what=sleep:handle-lid-switch --who=CallMeClaude --why="Away: the hub must answer calls" sleep infinity
```

`handle-lid-switch` also keeps a laptop awake with the lid closed; drop it if you keep the lid open. On **KDE Plasma** the same is a click: the battery / power icon in the system tray → **Manually block sleep and screen locking**. Both blocks end at the next reboot or logout, so for unattended weeks use the mask commands above. As on a Mac, a UPS (or a laptop on its charger) and a backup internet connection help on long trips; see [docs/09-unattended-operation.md](docs/09-unattended-operation.md).

With linger the hub starts before anyone logs in. Two things wait for a desktop login: the keyring (see [Troubleshooting › Linux](#linux)) and the desktop for computer use (see [L6](#l6-computer-use-on-linux)).

Check: `cmc doctor` shows ✅ for "Hub runs without a login (linger)", "System sleep disabled" and "No sleep with lid closed".

### L4. Pair the phone

```bash
cmc pair            # add --no-open if you don't want the QR image opened in a viewer
```

The QR code appears in the terminal and opens in your image viewer. The text printed under it names the iPhone app's **Pair Mac** button; in the Android app tap **Scan QR code**.

- **Android:** build and install the app as described in [apps/android/README.md](apps/android/README.md) (JDK 17, Android SDK, `adb install`). It needs no APNs key; see [Android app](#android-app) below.
- **iPhone:** follow [4. Install the iPhone app](#4-install-the-iphone-app) and [5. APNs key](#5-let-the-mac-ring-your-phone-apns-key). Building the iPhone app needs Xcode, so you need a Mac once for that step. The `cmc setup --apns-…` flags are the same on Linux; the `.p8` key goes into the keyring.

Check: the app shows that it is connected to your computer.

### L5. Reach the hub from anywhere: Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh    # or your distribution's tailscale package
sudo tailscale up
```

Install Tailscale on the phone, log in with **the same account**, then run `cmc pair` again and re-scan so the QR includes the Tailscale addresses.

Android 17's **Nearby devices / local network** permission does not affect Tailscale: measured with the permission revoked, the app still connected to the hub over mobile data through its Tailscale address. You need that permission only for the LAN addresses at home.

Check: `cmc doctor` shows ✅ Tailscale; turn Wi-Fi off on the phone and call Claude.

### L6. Computer use on Linux

When a computer task starts (`cmc do "…"` or "click submit" on a call), the hub picks a driver for the desktop that is running at that moment:

| Desktop | Screenshots | Mouse and keyboard |
|---|---|---|
| X11 (any desktop) | `scrot`, else `import`, else `maim` | `xdotool` |
| Wayland + KDE | `spectacle` | `ydotool` 1.x (optional, [L7](#l7-optional-mouse-and-keyboard-on-wayland-ydotool)) |
| Wayland + Sway, Hyprland, other wlroots | `grim` | `ydotool` 1.x (optional) |
| Wayland + GNOME | not supported | not offered |

Without a screenshot tool there is no desktop control: the agent must be able to check what it did. With screenshots but no input tool it can only look and report. Screenshots go into a private temporary directory that is deleted when the task ends.

- **Browser:** install the Claude in Chrome extension and run `claude --chrome` once yourself, in a terminal of your desktop. It works the same on every desktop and is the only path on GNOME Wayland. Why once: that first run installs the native messaging host through which the extension talks to Claude Code, and it is where you see the extension connect; the hub's computer tasks start Claude Code with `--chrome` and use the same connection, but they cannot set it up or ask you anything. `cmc doctor` finds the native host file in the Chrome, Chromium, Edge, Brave and Vivaldi profiles under `~/.config`, but it cannot see whether the extension is actually connected; `claude --chrome` (or `/chrome` in it) shows that.
- **Typing text:** xdotool and ydotool send key codes for a US keyboard, so on other layouts typed text comes out wrong (on Turkish Q, `Merhaba,` became `Merhabaö`). The agent therefore types only through the hub's helper, which pastes the text through the clipboard (`wl-clipboard` on Wayland, `xclip` or `xsel` on X11): it saves what is on the clipboard, pastes, and puts the old text back. If the clipboard held something that is not text (an image, files), that cannot be put back: the clipboard is left empty and the agent says so in its reply. Without a clipboard tool no text is typed at all, not even plain ASCII (key by key it would come out wrong on non-US layouts): the helper refuses, `xdotool type` and `ydotool type` are blocked, and the agent tells you which package to install (`cmc doctor` reports that the driver cannot type text and prints the install command for your distribution). Before typing, the agent checks with a screenshot that the right field has the focus and clicks into it first if needed.
- **Blocked shortcuts:** select-all (Ctrl+A) and cut (Ctrl+X) are refused for the agent, whether sent as `xdotool key ctrl+a` or as ydotool key codes (`29:1 30:1 …`), as is a Ctrl left pressed after a command. To fix a mistake the agent uses only undo (Ctrl+Z). It cannot run `wl-copy`, `wl-paste`, `xclip` or `xsel` itself, so it neither reads nor overwrites your clipboard outside the helper. Refusals are in the audit log (`computer.deny`).
- **Desktop session:** a hub started at boot (linger) has no `DISPLAY`, `WAYLAND_DISPLAY`, `XDG_SESSION_TYPE`, `XDG_CURRENT_DESKTOP` or `DBUS_SESSION_BUS_ADDRESS`. When a computer task starts without them, the hub reads them from `systemctl --user show-environment`, which most desktops fill at login, and gives them only to that task; nothing needs a restart. `cmc doctor` → "Computer use: hub service sees the desktop" shows what the service will find. If it is ❌ while you are logged in to the desktop, run this in a terminal of that desktop:
  ```bash
  systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XDG_SESSION_TYPE XDG_CURRENT_DESKTOP DBUS_SESSION_BUS_ADDRESS
  ```
- Every command the agent runs still goes through the safety policy: protected paths (such as `~/.ssh` and the keyring files) and destructive commands, including `sudo`, are blocked.

Check: `cmc do "Which app is in front? Just look, don't click."` names the correct window.

### L7. Optional: mouse and keyboard on Wayland (ydotool)

ydotool creates synthetic input through `/dev/uinput`. It is **off until you set it up yourself**, and it has a **security cost: once this is allowed, every program running under your user account can create synthetic keyboard and mouse input.** Skip it if you only need the browser or look-only control.

Only **ydotool 1.x** is used. Ubuntu 22.04 and Mint 21 package 0.1.x, which has a different command line: the hub ignores it and `cmc doctor` says "ydotool 1.x required". Install a 1.x package from a newer release, or build it from https://github.com/ReimuNotMoe/ydotool.

`cmc doctor` prints only the steps that are still missing. The full list:

```bash
sudo apt install ydotool        # Debian/Ubuntu/Mint
sudo dnf install ydotool        # Fedora
sudo pacman -S ydotool          # Arch
# /dev/uinput for a dedicated group (not "input", which can also read keyboards)
sudo groupadd -f uinput && sudo usermod -aG uinput "$USER"
echo 'KERNEL=="uinput", GROUP="uinput", MODE="0660", OPTIONS+="static_node=uinput"' | sudo tee /etc/udev/rules.d/60-callmeclaude-uinput.rules
echo uinput | sudo tee /etc/modules-load.d/uinput.conf && sudo modprobe uinput
sudo udevadm control --reload-rules && sudo udevadm trigger --name-match=uinput
# log out and back in (new group), then start the daemon
systemctl --user enable --now ydotool    # if your package ships this user unit; otherwise add ydotoold to your desktop's autostart
```

To undo: `systemctl --user disable --now ydotool`, `sudo gpasswd -d "$USER" uinput`, then delete `/etc/udev/rules.d/60-callmeclaude-uinput.rules` and `/etc/modules-load.d/uinput.conf`.

On Wayland the pointer may land off target with display scaling or several monitors; the agent checks each move with a screenshot and prefers the keyboard. Text is not typed with `ydotool type` but pasted through `wl-clipboard` with Ctrl+V sent by ydotool, and your clipboard is put back afterwards ([L6](#l6-computer-use-on-linux)); install `wl-clipboard` with ydotool.

Check: `cmc doctor` → "Computer use: ydotool" says `ready`.

### L8. First test

The same as [10. First test](#10-first-test): `cmc doctor`, `cmc call-me`, `cmc mode away`, then `cmc run . "…"` (needs tmux; without tmux just start `claude` in a folder, the hub still watches it, holds it and calls you).

## Android app

The Android app is the phone side for a macOS **or** a Linux hub. It has no push service and needs no Google account or Firebase: a foreground service keeps a WebSocket to the hub open, and the hub rings the phone over it through Android's Telecom framework.

1. Build and install: [apps/android/README.md › Build and install](apps/android/README.md#build-and-install) (JDK 17, Android SDK, `adb install -r …`).
2. Pair: run `cmc pair` on the computer and tap **Scan QR code** in the app.
3. Allow what the app asks for: microphone, notifications and, on **Android 17**, **Nearby devices / local network** (without it LAN connections silently time out; Tailscale addresses work without it).
4. Set battery usage to **Unrestricted** and check your manufacturer's own app killer (Samsung: "Never sleeping apps"). The app's cards tell you what is still missing.
5. For mobile data, add Tailscale on both sides ([7](#7-reach-your-mac-from-anywhere-tailscale) or [L5](#l5-reach-the-hub-from-anywhere-tailscale)).

Check: lock the phone and run `cmc call-me`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `cmc status`: hub not running | `cmc logs`, then `cmc restart`. Look at `~/.callmeclaude/logs/launchd.err.log` |
| Sessions don't show up | `cmc doctor` → hooks installed? Sessions started **before** `cmc setup` need a restart |
| The phone never rings | `cmc doctor` → APNs + VoIP token. Builds installed from Xcode need `--apns-env development` |
| The call connects but there's no audio | Look at `~/.callmeclaude/logs/app-*.log` (the phone ships its logs to the hub) and the `call.stats` lines in `~/.callmeclaude/audit/*.jsonl` (`micSeconds` / `outSeconds`) |
| Stuck on "Connecting…" on cellular | Is Tailscale on for both devices? Re-run `cmc pair` and re-scan |
| The hub sees only the wallpaper during computer use | Grant Screen Recording and Accessibility to the `node` binary (step 8), then `cmc restart` |
| Claude Code asks "trust this folder?" for a new session | Run `claude` in that folder once yourself, or keep projects under a folder listed in `projectRoots` in `~/.callmeclaude/config.json` |

### Linux

| Symptom | Fix |
|---|---|
| `cmc status`: hub not running | `systemctl --user status dev.callmeclaude.hub`, `cmc logs`, `~/.callmeclaude/logs/systemd.err.log`, then `cmc restart` |
| The hub is gone after a reboot until you log in | Linger is off: `sudo loginctl enable-linger "$USER"` ([L3](#l3-keep-the-hub-running-linger-and-sleep)) |
| `cmc setup`: "secret-tool could not store …", or after a reboot a call ends with "The voice key is in the keyring, which is locked …" (or "… the keyring is not running yet") | **The keyring is locked or missing.** The login keyring unlocks when you log in to the desktop with your password; a hub started by linger before that cannot read it. `cmc doctor` runs in your own session, so it may show ✅ while the service can't read the key. Options: log in to the desktop once after each boot (or use automatic login with a keyring that unlocks with it), or give the service the Gemini key directly: `systemctl --user edit dev.callmeclaude.hub.service`, add `[Service]` and `Environment=GEMINI_API_KEY=<YOUR_KEY>`, then `cmc restart`. That override file is plain text under `~/.config/systemd/user/`, readable by your user. The APNs key (iPhone only) has no such alternative. |
| Sessions the hub starts can't `git push` over SSH ("Could not open a connection to your authentication agent", or asks for a passphrase) | **The service doesn't see your SSH agent:** `SSH_AUTH_SOCK` is not in the systemd user environment, so headless and voice-started tmux sessions don't get it. After logging in: `systemctl --user import-environment SSH_AUTH_SOCK && cmc restart` (the socket can change at every login). If your agent has a fixed socket (for example one started by a systemd user unit), put it in the service instead: `systemctl --user edit dev.callmeclaude.hub.service` → `[Service]` / `Environment=SSH_AUTH_SOCK=<socket path>`, then `cmc restart`. A tmux server that was already running keeps its own environment. |
| Computer use: "not supported in this environment", or doctor ❌ "hub service sees the desktop" | **The desktop session is not visible.** Log in to the desktop; the hub reads it from systemd when the task starts. If doctor still shows ❌: run `systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XDG_SESSION_TYPE XDG_CURRENT_DESKTOP DBUS_SESSION_BUS_ADDRESS` in a terminal of that desktop (no restart needed). On GNOME Wayland only the browser works. |
| Computer use can look but not click | No input tool: `xdotool` on X11; on Wayland ydotool 1.x ([L7](#l7-optional-mouse-and-keyboard-on-wayland-ydotool)). `cmc doctor` lists what is missing. |
| `cmc doctor`: "ydotool 1.x required" | Your ydotool is 0.1.x (Ubuntu 22.04, Mint 21) and is ignored. Install 1.x ([L7](#l7-optional-mouse-and-keyboard-on-wayland-ydotool)). |
| A voice-started session: "Project folder not found" | The folder is not under a project root. `cmc doctor` lists them; add yours to `projectRoots` ([L2](#l2-install-the-hub)). |
| Computer use says it cannot type text, or that a clipboard tool is missing | Install `wl-clipboard` (Wayland) or `xclip` (X11) ([L6](#l6-computer-use-on-linux)). |
| The desktop AppImage does not start: "dlopen(): error loading libfuse.so.2" | Install FUSE 2 ([L1](#l1-requirements): `fuse2` / `libfuse2` / `libfuse2t64` / `fuse-libs`), or run `./CallMeClaude-*.AppImage --appimage-extract-and-run`. |
| No CallMeClaude icon in the GNOME top bar | Enable the AppIndicator extension ([L1](#l1-requirements)). Until then the panel opens at start and minimizes instead of hiding. |
| "Task complete" is not spoken on the computer, or sounds robotic | `cmc doctor` → "Spoken alerts on this computer". Install `speech-dispatcher` and `espeak-ng` ([L1](#l1-requirements)). |
| `cmc run`: "needs tmux" | Install tmux, or start `claude` yourself; the hub still watches it and calls you. Voice-started sessions follow the setup choice (`cmc setup --tmux` / `--no-tmux`). |

### Android

| Symptom | Fix |
|---|---|
| Android 17: the app can't reach the computer at home ("Can't reach your computer" or a local network card) | Grant **Nearby devices / local network**: tap **Allow** on the card, or Settings › Apps › CallMeClaude › Permissions. Without it Android 17 blocks LAN connections and they time out. Over Tailscale the app connects anyway. |
| The phone rings only while the app is open, or not after a while | Battery usage **Unrestricted**, and the manufacturer's app killer ([apps/android/README.md › Samsung and other manufacturers](apps/android/README.md#samsung-and-other-manufacturers)). After *Force stop* or a reboot, open or unlock the phone once. |
| "Pairing is no longer valid" | The hub's token changed (`cmc pair --rotate` or a new setup): tap **Pair again** and scan `cmc pair`. |
| The call audio goes to a smartwatch | Switch the audio route on the call screen, or turn off **Phone calls** for the watch in the phone's Bluetooth settings. |

## Honest limits

- **GNOME on Wayland: no screenshots, so no desktop control.** GNOME Shell lets only its own components call its screenshot API, and the screenshot portal asks the person at the screen. The hub uses only the browser path (Claude in Chrome) there. An X11 session of GNOME works with the X11 tools. Details: [ADR-0008](docs/adr/0008-linux-computer-use.md).
- **ydotool is optional and has a security cost.** Write access to `/dev/uinput` lets every program running under your user create synthetic keyboard and mouse input. CallMeClaude never sets it up; you decide ([L7](#l7-optional-mouse-and-keyboard-on-wayland-ydotool)). On Wayland the pointer is not calibrated: with scaling or several monitors it may land off target, so the agent checks each move with a screenshot. Only ydotool 1.x is supported.
- **Linux computer use types through the clipboard.** Your clipboard text is put back after each paste; non-text content (an image, copied files) cannot be, so it is cleared and the agent tells you. With `xsel` instead of `xclip`, non-text content cannot even be seen and is treated as empty.
- **Headless Linux: the keyring may be locked.** Without a desktop login the hub may not read its keys. The Gemini key can come from the service environment instead ([Troubleshooting › Linux](#linux)); the APNs key cannot.
- **Android has no push (no FCM).** The app keeps a permanent connection to the hub. If Android or the manufacturer stops the app, or the phone has no network, the hub can't ring it, and the app can't notice from the inside. Battery settings matter; a reboot needs one unlock. See [apps/android/README.md › Known limits](apps/android/README.md#known-limits).
- **Some smartwatches pull the call audio to themselves** because they register as a phone headset.
- **An iPhone with a Linux hub** still needs a Mac with Xcode once, to build and install the app.


## Uninstall

```bash
cmc uninstall                                  # removes our hooks + the launchd agent
rm -rf ~/.callmeclaude                         # config, state, logs, audit
security delete-generic-password -s dev.callmeclaude -a gemini-api-key
security delete-generic-password -s dev.callmeclaude -a apns-p8
```

Then delete the app from the iPhone.

On Linux:

```bash
cmc uninstall                                  # removes our hooks + the systemd user service
rm -rf ~/.callmeclaude                         # config, state, logs, audit
secret-tool clear service dev.callmeclaude account gemini-api-key
secret-tool clear service dev.callmeclaude account apns-p8
rm ~/.local/bin/cmc
```

If you changed them for the hub: `sudo loginctl disable-linger "$USER"`, `sudo systemctl unmask sleep.target suspend.target hibernate.target hybrid-sleep.target`, delete `/etc/systemd/logind.conf.d/callmeclaude-lid.conf`, and undo ydotool ([L7](#l7-optional-mouse-and-keyboard-on-wayland-ydotool)). On Android, uninstall the app.
