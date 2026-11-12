# CallMeClaude Android

Kotlin + Jetpack Compose + Telecom (self-managed `ConnectionService`) + `AudioRecord`/`AudioTrack`. Android 10+ (API 29), built against API 37.

There is no push service: a foreground service keeps a WebSocket open to the hub on your computer, and the hub rings the phone over it.

| File | Job |
|---|---|
| `HubService.kt` | Foreground service that holds the hub connection; idle it runs as `specialUse`, during a call as `specialUse\|phoneCall\|microphone` |
| `HubClient.kt` | WebSocket (Tailscale/LAN), races all pairing addresses, reconnects; stops on a refused token (4003) |
| `LinkPolicy.kt` | When to reconnect: back-off, network changes, liveness pings during a call |
| `CallClaudeActivity.kt`, `QuickCall.kt` | Quick ways to call (app shortcut, quick settings tile): one invisible trampoline that reuses the home screen's "Call Claude" |
| `BootReceiver.kt` | Starts the service after a reboot or an app update, if the phone is paired |
| `calls/` | Telecom integration, lock-screen ringing, audio route picker, microphone → hub (PCM16 16 kHz), hub → speaker (PCM16 24 kHz) |
| `RemoteLog.kt`, `AppLog.kt` | Diagnostics forwarded to the hub (redacted, rate-limited) |
| `Warnings.kt`, `ui/HealthCards.kt` | Cards that say what stops Claude from reaching you, and how to fix it |
| `ui/` | Home (sessions, pending decisions, mode, panic), call screen, settings, QR pairing |

## Build and install

You need JDK 17 and the Android SDK (platform 37). With the SDK in `ANDROID_HOME` or in `local.properties` (`sdk.dir=…`):

```bash
cd apps/android
JAVA_HOME=/usr/lib/jvm/java-17-openjdk ./gradlew assembleDebug test lintDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

There is no Play Store build; you install the debug APK yourself (USB or wireless debugging). Updating with `adb install -r` keeps the pairing and restarts the hub connection on its own.

## Pairing

On the computer run `cmc pair`. In the app tap **Scan QR code**, or paste the pairing text it prints. The pairing (including the token) is stored encrypted with a key in the Android Keystore, and is excluded from backups.

To unpair: on the home screen tap **Settings** (top right) or the connection line under the title; **Unpair this computer** is the first thing in Settings.

**Where Claude calls:** Settings › **When Claude needs you** picks **This phone**, **The computer** (the desktop app rings; if it isn't open, this phone rings instead) or **Don't call**. It is the same setting as in the desktop app.

If the hub's token changes (`cmc pair --rotate`, or a new setup), the app stops retrying and shows **Pairing is no longer valid** with a **Pair again** button, which forgets the old pairing and opens the QR screen.

## Starting a call quickly

Besides the button on the home screen, two ways start the call to Claude straight away. Both land in the same place (`CallClaudeActivity`) and behave like the button: not paired opens pairing; during a call they bring the call screen forward instead of starting a second one; without the microphone permission the app opens and asks first; if the computer can't be reached, the call says so. They also work when the app isn't running.

- **App shortcut:** long-press the CallMeClaude icon and tap **Call Claude**. You can drag it to the home screen as its own icon.
- **Quick settings tile:** edit the quick settings panel and add **Call Claude**. It is highlighted while the computer is connected and shows "Not paired" or "Not connected" otherwise. It also works on the lock screen: the call screen opens over it without unlocking (measured on a Galaxy S25, One UI 9). On the lock screen Claude only answers questions: to give a session an instruction, approve something or have Claude use the computer, unlock the phone during the call and say it again.

**Samsung, by voice:** in Modes and Routines create a manual routine (for example "Agent") and, as its action, pick CallMeClaude's **Call Claude** app shortcut. Then say "Bixby, run Agent routine": the call starts directly (verified on a Galaxy S25, One UI 9). Bixby Quick Commands, the older way to do this, were removed in One UI 7.

**Google Assistant:** "Hey Google, open …" only opens the main CallMeClaude app; it doesn't start a call.

## Permissions, and why

| Permission | Why |
|---|---|
| Microphone | Your voice on calls. Without it the hub gets silence and the call stays up. |
| Notifications | The incoming-call notification and the connection status notification. Without them a call can't ring. |
| Nearby devices / local network (Android 17+) | Android 17 blocks LAN connections for apps targeting API 37 unless this is granted. The hub is usually reached by its LAN address; without it the connection silently times out. |
| Full-screen notifications (Android 14+) | Lets an incoming call take over the lock screen. Without it the call is only a notification. Granted by default for a sideloaded APK (measured on a Galaxy S25 with Android 17); the app shows a card if it is off. |
| Battery: unrestricted | Doze and app standby may cut the socket, and then Claude can't call you. The card's **Allow** opens the system "Stop optimising battery usage?" dialog. It is also what lets Android restart the service in the background. |
| Camera | Only to scan the pairing QR code. |
| Run at startup | Reconnects after a reboot or an update without opening the app. |

The home screen shows at most two of these cards, most serious first; **Settings › This phone** lists all of them.

## Samsung and other manufacturers

Beyond Android's own battery optimisation, many manufacturers have their own app killers.

- **Samsung (One UI):** Settings › Battery › Background usage limits. CallMeClaude must not be in **Sleeping apps** or **Deep sleeping apps**; putting it in **Never sleeping apps** is safest. Also leave "Put unused apps to sleep" off for it. The app can't read these lists, so it can only remind you.
- **Xiaomi, OnePlus, Oppo, Vivo, Huawei** and others have similar settings ("Autostart", "Battery saver", "App launch"). Allow autostart and background activity for CallMeClaude. [dontkillmyapp.com](https://dontkillmyapp.com) lists the steps per brand.

## Bluetooth

Some smartwatches and car kits register as a phone headset and pull the call audio to themselves. You can switch the route during a call (the audio button on the call screen). If a watch keeps taking it: in the watch's Bluetooth settings on the phone, turn off **Phone calls** for that device.

## On the road: Tailscale

Install [Tailscale](https://tailscale.com) on the computer and on the phone, log in to the same account, then run `cmc pair` again so the pairing includes the Tailscale address. The app races all addresses and uses whichever answers first, so the same pairing works at home and on mobile data.

## Logs

The app forwards its diagnostics to the hub, which writes them to `~/.callmeclaude/logs/app-YYYY-MM-DD.log` (prefixed with the phone's name). Only connection, call, audio-route and service events are sent (the same ones as iOS), at most 30 lines in a burst and then one line every 2 s; dropped lines are counted. The token, addresses, host names, the phone's and the computer's names are replaced before anything is queued, and transcripts are never logged. `adb logcat -s cmc.hub cmc.call cmc.audio cmc.telecom cmc.service cmc.boot cmc.net cmc.quick` shows everything on the phone itself.

## Known limits

- **No push.** If Android or the manufacturer kills the app, or the phone has no network, the hub can't ring it. The app can't detect from the inside that it was killed; it only knows when it runs again.
- **Reboots need one unlock.** The service starts on `BOOT_COMPLETED`, which arrives only after you unlock the phone once after a reboot (the pairing key is in credential-encrypted storage).
- **Force stop disables everything.** After *Force stop* in the app settings, Android delivers nothing (not even the boot broadcast) until you open the app again (calling Claude from the shortcut or the tile counts).
- **Background starts.** Without the battery exemption Android may refuse to restart the service from the background; opening the app always fixes it.
- **Self-managed Telecom API.** `PhoneAccount.CAPABILITY_SELF_MANAGED` is deprecated in API 37 in favour of the Core Telecom library; it still works, and moving would mean a new dependency and dropping API 29–33 behaviour.
- **LAN only without Tailscale.** A pairing made with only LAN addresses doesn't work on mobile data.
- **Debug build only.** There is no signed release build or store listing.
