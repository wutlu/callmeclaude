<p align="center">
  <img src="apps/ios/CallMeClaude/Assets.xcassets/AppIcon.appiconset/icon.png" width="96" alt="CallMeClaude icon">
</p>

<h1 align="center">CallMeClaude</h1>

<p align="center">
  <b>Your Claude Code agents call you when they get stuck. You answer from your helmet, your car or your couch.</b><br>
  Open source · self-hosted · runs on <i>your own</i> Claude subscription · no SaaS, no accounts, no relay servers
</p>

<p align="center">
  <a href="INSTALLATION.md">Installation</a> ·
  <a href="#supported-platforms">Platforms</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="docs/">Design docs</a> ·
  <a href="README.tr.md">Türkçe</a>
</p>

---

Claude Code can work for hours on its own, until it stops to ask for a permission, says *"I can't submit this form without your approval"*, or finishes and waits for the next instruction. Each time, you have to go back to the keyboard.

**CallMeClaude takes the keyboard out of that loop.** A small agent on your Mac (or Linux computer) watches every Claude Code session in real time. When a session gets stuck or finishes, it **rings your iPhone (or Android phone) like a real phone call** and tells you what happened in two short sentences. You answer through your motorcycle intercom, AirPods or the phone itself, and say what to do:

> 📞 **Claude:** "acme-web: the application form is filled in and waiting for your OK. Should I submit it?"
> 🧑 **You:** "Send it, you have full authority. Then move on to the email draft."
> 📞 **Claude:** "Submitted, the confirmation page is open. The agent moved on to the email."

You can also call Claude yourself at any time ("Hey Siri, call CallMeClaude"). Ask for a status update, start new sessions, approve permissions, or have the Mac (or Linux computer) click through something in the browser for you.

## Features

- **Watches every Claude Code session**: terminal, IDE or desktop app. It uses Claude Code's official HTTP hooks and patches nothing.
- **Understands why a session stopped**: a permission prompt, a question, "I can't do this", a finished task or an API error. Claude Haiku does the classification on your own plan.
- **Rings your phone for real** with PushKit and CallKit. It works on the lock screen, the Bluetooth or intercom answer button works, and calls show up in Recents. The Android app rings through Android's Telecom framework over its own always-on connection to the hub (no Google push service).
- **Natural, interruptible voice**: Gemini Live speech-to-speech with about one second of latency. It talks like a phone call: short sentences, no file paths, one question at a time.
- **Speaks your language**: pick the conversation language in the app or with `cmc setup --language` (`en-US`, `tr-TR`, `de-DE`, `es-ES`, …). Claude speaks it on calls and writes session summaries in it. You can also say "from now on speak German". The app and CLI themselves are in English.
- **Unblocks sessions remotely**. It holds a stopped session open and continues it with your spoken instruction (`Stop` hook `decision: block`). It can also answer permission prompts, type into tmux sessions, resume ended sessions, or queue the instruction for the next step.
- **Uses the computer for you** when an agent can't, with Claude in Chrome, [Peekaboo](https://github.com/steipete/Peekaboo) and `cliclick`. On Linux it uses Claude in Chrome plus the screenshot and input tools of your desktop (see [what works where](#what-works-where)). It always asks for explicit voice confirmation first.
- **Built for unattended days away**: a launchd service (systemd `--user` on Linux), sleep-prevention checks, Tailscale for cellular access, calls that survive reconnects, a panic switch and a full audit log.

## How it works

```
        Mac (stays at home)                                   iPhone (with you)
 ┌──────────────────────────────────────┐              ┌─────────────────────────┐
 │  Claude Code sessions                │              │  CallKit incoming call  │
 │        │ HTTP hooks (127.0.0.1)      │   VoIP push  │  (lock screen, Recents) │
 │        ▼                             │  ──────────▶ │           │             │
 │  Hub  (cmc, launchd service)         │  your APNs   │           ▼             │
 │   ├─ classifier  → Claude Haiku      │     key      │  Bluetooth HFP          │
 │   ├─ call scheduler                  │              │  → helmet intercom      │
 │   ├─ voice bridge → Gemini Live      │  ◀════════▶  │                         │
 │   └─ brain → Claude Agent SDK        │  PCM audio   │                         │
 │            + computer use            │  over        │                         │
 └──────────────────────────────────────┘  Tailscale   └─────────────────────────┘
```

- **Hub** (`apps/mac-agent`, TypeScript/Node): a launchd service with a `cmc` CLI. It receives Claude Code hooks on `127.0.0.1`, keeps session state, decides when to call, bridges the phone's audio to the voice model, and runs tools.
- **iOS app** (`apps/ios`, Swift): CallKit, PushKit, and AVAudioEngine with voice processing. It is a thin phone: it rings, streams audio and lists your sessions.
- **Android app** (`apps/android`, Kotlin): the same thin phone. A foreground service keeps the WebSocket to the hub open, so the hub rings it over that connection instead of a push; see [apps/android/README.md](apps/android/README.md).
- On **Linux** the hub is the same code: a systemd `--user` service instead of launchd, the libsecret keyring instead of the Keychain. See [ADR-0006](docs/adr/0006-linux-hub.md) and [ADR-0008](docs/adr/0008-linux-computer-use.md).
- **Two-layer voice**: a fast speech-to-speech model handles the conversation. Anything that matters goes through hub tools to **Claude** and to your sessions: instructions, approvals, questions about the code, computer use. See [ADR-0003](docs/adr/0003-two-layer-voice.md).

## Your subscription, your machine

CallMeClaude never sees, stores or forwards your Claude credentials. It reaches Claude only through the Claude Code you already installed and logged in to on your own Mac (or Linux computer), via the Claude Agent SDK, for personal and local use. There is no central server and no shared account. Each install serves exactly one developer, and usage counts against your own plan limits. See [ADR-0002](docs/adr/0002-subscription-auth.md) and Anthropic's [guidance on using the Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

Everything else is bring-your-own-key and talks directly to the vendor: a **Gemini API key** for voice and your **Apple APNs key** for ringing the phone. Keys are stored in the macOS Keychain. On Linux they go into your keyring through libsecret (`secret-tool`). The Android app needs no APNs key and no Google account.

## Supported platforms

| | Supported |
|---|---|
| Hub (the computer that stays at home) | **macOS** 15+ · **Linux**: Ubuntu 22.04+, Debian 12+, Fedora, Linux Mint 21+, Arch; X11 and Wayland; GNOME, KDE and wlroots-based desktops (Sway, Hyprland) |
| Phone | **iPhone** (iOS 17+, [apps/ios](apps/ios/README.md)) · **Android** 10+ ([apps/android](apps/android/README.md)) |

Any phone works with any hub: the Android app also works with a macOS hub, and the iPhone app with a Linux hub.

### What works where

| | macOS | Linux X11 | Linux Wayland, KDE | Linux Wayland, wlroots (Sway, Hyprland) | Linux Wayland, GNOME |
|---|---|---|---|---|---|
| Watching sessions, calls, voice | ✅ | ✅ | ✅ | ✅ | ✅ |
| Computer use: browser (Claude in Chrome) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Computer use: screenshots | ✅ Peekaboo / `screencapture` | ✅ `scrot`, `import` or `maim` | ✅ `spectacle` | ✅ `grim` | ❌ not supported |
| Computer use: mouse and keyboard | ✅ Peekaboo / `cliclick` | ✅ `xdotool` | ⚙️ `ydotool` 1.x, optional | ⚙️ `ydotool` 1.x, optional | ❌ (no screenshots to check against) |
| Computer use: typing text (any keyboard layout) | ✅ Peekaboo | ✅ pasted through `xclip` or `xsel`, clipboard put back | ✅ pasted through `wl-clipboard`, clipboard put back | ✅ same | ❌ |
| Sessions you start by voice | ✅ in tmux | ✅ in tmux, or headless (`claude -p`) if you choose no tmux | ✅ same | ✅ same | ✅ same |

| Phone | Rings in the background | Needs |
|---|---|---|
| iPhone | ✅ with your APNs key (VoIP push); without it only while the app is open | A paid Apple Developer account |
| Android | ✅ over the app's own connection to the hub | Battery optimisation off for the app; no Google services |

## Requirements

| | |
|---|---|
| Mac | macOS 15+, Node 22.5+, pnpm, Homebrew, Xcode 16+ |
| Claude | Claude Code installed and logged in to your Pro/Max plan |
| Voice | A Gemini API key ([get one](https://aistudio.google.com/apikey)) |
| Phone | An iPhone on iOS 17+ and a **paid Apple Developer account** (VoIP push requires it) |
| On the road | [Tailscale](https://tailscale.com) on both the Mac and the iPhone (free for personal use) |

On Linux and Android instead:

| | |
|---|---|
| Linux | Node 22.5+, pnpm, `secret-tool` (libsecret) with an unlocked keyring (on KDE Plasma, KDE Wallet provides it; elsewhere GNOME Keyring); optional: tmux, the computer-use tools for your desktop, including `wl-clipboard` (Wayland) or `xclip` (X11), without which the agent cannot type text |
| Android | Android 10+; JDK 17 and the Android SDK to build the APK. On Android 17 the local network permission is needed only for LAN addresses; Tailscale works without it |

## Quick start

```bash
git clone https://github.com/wutlu/callmeclaude && cd callmeclaude
pnpm install
ln -s "$PWD/apps/mac-agent/bin/cmc.mjs" /opt/homebrew/bin/cmc

cmc setup --gemini-key <GEMINI_KEY> --language en-US   # hooks + launchd service; key → Keychain
./scripts/ios-install.sh              # build and install the iPhone app over USB
cmc pair                              # scan the QR code in the app
cmc call-me                           # your phone rings
```

The full guide, including APNs and Tailscale, is in **[INSTALLATION.md](INSTALLATION.md)**.

**Linux** (any distribution; see [INSTALLATION.md › Linux hub](INSTALLATION.md#linux-hub) for the packages per distribution):

```bash
git clone https://github.com/wutlu/callmeclaude && cd callmeclaude
pnpm install
mkdir -p ~/.local/bin && ln -s "$PWD/apps/mac-agent/bin/cmc.mjs" ~/.local/bin/cmc

read -rs -p 'Gemini API key: ' KEY; echo               # keeps the key out of your shell history
cmc setup --gemini-key "$KEY" --language en-US         # hooks + systemd --user service; asks about tmux; key → keyring
unset KEY
cmc doctor                                             # linger, sleep, project roots and computer-use advice
cmc pair                                               # scan the QR code in the app
cmc call-me                                            # your phone rings
```

Sessions you start by voice run only inside your **project roots** (on Linux by default `~/projects`, `~/Desktop/projects` and other common folders that exist). Change them with `projectRoots` in `~/.callmeclaude/config.json`, then `systemctl --user restart dev.callmeclaude.hub`; see [INSTALLATION.md › L2](INSTALLATION.md#l2-install-the-hub). To keep a Linux computer awake only while you are away, without `sudo`: [INSTALLATION.md › L3](INSTALLATION.md#l3-keep-the-hub-running-linger-and-sleep).

**Android app:** build and install the APK as described in [apps/android/README.md](apps/android/README.md), then scan the `cmc pair` QR code. It works with a macOS or a Linux hub.

## Daily use

```bash
cmc status                                    # sessions and pending decisions
cmc mode away                                 # desk | away | ride | sleep: when the hub may call
cmc run ~/code/app "fix the failing tests"    # start Claude Code in tmux so the hub can type into it
cmc do "open the PR in Chrome and press Merge" # let the hub use the computer
cmc ignore ~/code/private                     # watch only: report status, never hold or call
cmc panic                                     # interrupt everything and pause automation (cmc resume)
cmc doctor                                    # check the whole setup
```

On the phone, tap **Call Claude**, or say *"Hey Siri, call CallMeClaude"*.

## Safety

This software can operate your computer by voice. The defaults are conservative:

- Risky actions need an explicit spoken confirmation: payments, deploys, `git push`, deleting, sending messages, computer use.
- Destructive shell commands and sensitive paths (`~/.ssh`, the Keychain, `.env`; on Linux also the keyring files) are blocked for the hub's own agent.
- On Linux the hub's agent types text only by pasting it through the clipboard and puts your clipboard back afterwards; select-all (Ctrl+A) and cut (Ctrl+X) are blocked for it, and it fixes mistakes only with undo (Ctrl+Z).
- **Locked phone = ask only.** While the phone is on its lock screen (PIN, Face ID or pattern set), anyone holding it can talk to Claude, so the hub only lets them ask: session status and questions work, but instructing sessions, approving permissions, starting sessions and computer use need the phone unlocked first. Denying a permission and the emergency stop always work.
- Web page content is treated as data, never as instructions.
- Everything goes into an append-only audit log in `~/.callmeclaude/audit`.

Read [docs/08-security.md](docs/08-security.md) and [SECURITY.md](SECURITY.md) before you rely on it.

## Honest limits

- **GNOME on Wayland:** no screenshots, so no desktop control; only the browser path (Claude in Chrome) works.
- **ydotool is optional and has a security cost:** mouse and keyboard on Wayland need write access to `/dev/uinput`, and then every program running as your user can create synthetic input. It is off until you set it up yourself, and only ydotool 1.x is used.
- **Linux clipboard:** text on the clipboard is put back after the agent types; an image or other non-text content cannot be, so it is cleared and the agent tells you.
- **Headless Linux:** without a desktop login the keyring may stay locked, so the hub cannot read its keys. The phone then says that the key is in the keyring, which unlocks when you log in.
- **Android has no push:** the app keeps a permanent connection to the hub. If Android or the manufacturer stops the app, the hub can't ring it, so the battery settings matter.
- **Smartwatches:** some watches register as a phone headset and pull the call audio to themselves.

Details and workarounds: [INSTALLATION.md › Honest limits](INSTALLATION.md#honest-limits).

## Project layout

```
apps/mac-agent/     Hub: hook server, session state, classifier, calls, voice bridge, CLI
apps/ios/           iPhone app (XcodeGen project)
apps/android/       Android app (Gradle project)
packages/protocol/  Hub ↔ app message types
scripts/            install helpers
docs/               design docs, research and ADRs (in Turkish)
```

## Status

Early, but it works end to end on real devices: hooks → classification → VoIP call → voice conversation → instruction delivered to the session. Expect rough edges. Issues and PRs are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

CallMeClaude is an independent open-source project. It is not affiliated with or endorsed by Anthropic or Google. "Claude" is a trademark of Anthropic.
