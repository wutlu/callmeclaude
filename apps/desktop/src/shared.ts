// Pure helpers shared by the main process and the renderer (no Electron, no DOM): unit-tested in test/.
import type { CallInfo, Mode, RingTarget, Snapshot } from '@callmeclaude/protocol';

export interface HubConfig {
  appPort: number;
  appToken: string;
}

/** Where the hub keeps its files (same rule as the hub: CMC_HOME overrides ~/.callmeclaude). */
export function hubDataDir(home: string, env: Record<string, string | undefined>): string {
  return env.CMC_HOME || `${home}/.callmeclaude`;
}

/** The local hub's port and app token from its config.json text; undefined if it is not set up. */
export function parseHubConfig(text: string | undefined): HubConfig | undefined {
  if (!text) return;
  try {
    const c = JSON.parse(text);
    const appPort = Number(c.appPort ?? 47801);
    if (typeof c.appToken !== 'string' || !c.appToken || !Number.isInteger(appPort) || appPort <= 0 || appPort > 65535) return;
    return { appPort, appToken: c.appToken };
  } catch {
    return;
  }
}

/** What the renderer tells the main process after every change (drives the tray icon and menu). */
export interface View {
  /** 'setup': the hub is not set up on this computer; 'offline': set up but not answering. */
  link: 'setup' | 'offline' | 'online';
  snapshot?: Snapshot;
  /** The call this computer is ringing for / talking on. */
  local?: { callId: string; state: 'ringing' | 'connecting' | 'active'; muted: boolean };
}

export type TrayTone = 'offline' | 'idle' | 'attention' | 'paused' | 'call';

/** Icon color and tooltip. Green whenever a call rings or runs anywhere (phone or this computer). */
export function trayLook(v: View): { tone: TrayTone; tooltip: string; badge: string } {
  const s = v.snapshot;
  if (v.link !== 'online' || !s) {
    return { tone: 'offline', tooltip: v.link === 'setup' ? 'CallMeClaude: hub not set up' : 'CallMeClaude: hub not running', badge: '' };
  }
  const pending = s.pending.length;
  const call: CallInfo | undefined = s.call;
  if (v.local || call) {
    const ringing = v.local ? v.local.state === 'ringing' : call!.state === 'ringing';
    const where = v.local || call?.on === 'desktop' ? 'on this computer' : 'on your phone';
    return { tone: 'call', tooltip: `CallMeClaude: ${ringing ? 'Claude is calling' : 'on a call'} ${where}`, badge: '' };
  }
  if (s.paused) return { tone: 'paused', tooltip: 'CallMeClaude: automation paused', badge: '' };
  const n = s.sessions.length;
  const base = `CallMeClaude: ${n} session${n === 1 ? '' : 's'}`;
  if (pending) return { tone: 'attention', tooltip: `${base}, ${pending} waiting for you`, badge: String(pending) };
  return { tone: 'idle', tooltip: base, badge: '' };
}

export const RING_TARGETS: Array<{ id: RingTarget; label: string; hint: string }> = [
  { id: 'computer', label: 'Call this computer', hint: 'Talk here with the microphone. No phone needed.' },
  { id: 'phone', label: 'Call my phone', hint: 'Your phone rings, like a normal call.' },
  { id: 'off', label: "Don't call", hint: 'Updates wait until you start a conversation.' },
];

/** Same modes and words as the phone apps. */
export const MODES: Array<{ id: Mode; label: string; hint: string }> = [
  { id: 'desk', label: 'Desk', hint: 'At the computer. No phone calls; rings here if "Call this computer" is on.' },
  { id: 'away', label: 'Away', hint: 'Calls when a session is stuck or done.' },
  { id: 'ride', label: 'Ride', hint: 'Like Away, extra short sentences.' },
  { id: 'sleep', label: 'Sleep', hint: 'Emergencies only.' },
];

/** Voice languages, same list as the phone apps. */
export const LANGUAGES: Array<[string, string]> = [
  ['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['tr-TR', 'Türkçe'], ['de-DE', 'Deutsch'],
  ['fr-FR', 'Français'], ['es-ES', 'Español'], ['it-IT', 'Italiano'], ['pt-BR', 'Português (Brasil)'],
  ['nl-NL', 'Nederlands'], ['pl-PL', 'Polski'], ['ru-RU', 'Русский'], ['ar-SA', 'العربية'],
  ['hi-IN', 'हिन्दी'], ['ja-JP', '日本語'], ['ko-KR', '한국어'], ['zh-CN', '中文 (简体)'],
];

/** Session state labels, same as the phone apps. */
export function stateLabel(s: string): string {
  return (
    {
      running: 'Working',
      waiting_permission: 'Needs permission',
      waiting_input: 'Waiting for you',
      blocked: 'Stuck',
      done: 'Done',
      errored: 'Error',
      stale: 'Quiet',
      ended: 'Closed',
    } as Record<string, string>
  )[s] ?? s;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the panel opens: under the tray icon when the menu bar is on top (macOS), above it when the
 * taskbar is at the bottom (Windows), always fully inside the screen's work area.
 */
export function panelPosition(tray: Rect, size: { width: number; height: number }, work: Rect): { x: number; y: number } {
  const cx = tray.x + tray.width / 2;
  let x = Math.round(cx - size.width / 2);
  const below = tray.y + tray.height / 2 < work.y + work.height / 2;
  let y = below ? tray.y + tray.height + 4 : tray.y - size.height - 4;
  x = Math.min(Math.max(x, work.x + 4), work.x + work.width - size.width - 4);
  y = Math.min(Math.max(y, work.y + 4), work.y + work.height - size.height - 4);
  return { x, y };
}

/** ~/.config/autostart entry that starts the app at login on Linux desktops (XDG autostart). */
export function autostartEntry(exec: string): string {
  const quoted = /[\s"'\\]/.test(exec) ? `"${exec.replace(/(["\\`$])/g, '\\$1')}"` : exec;
  return ['[Desktop Entry]', 'Type=Application', 'Name=CallMeClaude', `Exec=${quoted} --hidden`, 'X-GNOME-Autostart-enabled=true', 'Terminal=false', ''].join('\n');
}

/** PCM16 little-endian from Float32 samples in [-1, 1]. */
export function floatToPcm16(f: Float32Array): Uint8Array {
  const out = new DataView(new ArrayBuffer(f.length * 2));
  for (let i = 0; i < f.length; i++) {
    const v = Math.max(-1, Math.min(1, f[i]));
    out.setInt16(i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Uint8Array(out.buffer);
}

/** Float32 samples from PCM16 little-endian bytes (an odd trailing byte is dropped). */
export function pcm16ToFloat(b: ArrayBuffer): Float32Array {
  const n = b.byteLength >> 1;
  const v = new DataView(b, 0, n * 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = v.getInt16(i * 2, true) / 0x8000;
  return out;
}
