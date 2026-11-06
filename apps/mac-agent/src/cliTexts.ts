/**
 * User-facing `cmc` texts that differ per operating system. Kept free of side effects so tests can pin
 * them: the macOS texts must stay byte-for-byte unchanged.
 */
import type { DoctorResult } from './platform/types.ts';

/** What `cmc pair` prints after the QR code. */
export function pairTexts(os: NodeJS.Platform) {
  if (os === 'linux') {
    return {
      scan: '\nIn the CallMeClaude app scan this QR code to pair the phone with this computer. To enter it manually:\n',
      noTailscale:
        '\n⚠️  Tailscale is not connected: to reach this computer on the road, log in to Tailscale on this computer and the phone, then run `cmc pair` again.',
    };
  }
  return {
    scan: '\nIn the CallMeClaude app tap "Pair Mac" and scan this QR code. To enter it manually:\n',
    noTailscale:
      '\n⚠️  Tailscale is not connected: to reach this Mac on the road, log in to Tailscale on the Mac and the phone, then run `cmc pair` again.',
  };
}

/** One `cmc doctor` line. `{ info }` is a note (ℹ️), not a problem; it is only used on Linux. */
export function doctorLine(name: string, r: DoctorResult): string {
  if (typeof r === 'object') return `ℹ️  ${name}: ${r.info}`;
  const good = r === true || (typeof r === 'string' && !r.startsWith('!'));
  return `${good ? '✅' : '❌'} ${name}${typeof r === 'string' ? ': ' + r.replace(/^!/, '') : ''}`;
}

/**
 * The doctor line about the iPhone's VoIP token (devices.json, written only when an iPhone registers one).
 * On Linux the phone may be an Android, which never registers a token, so a missing token is only a note.
 */
export function voipTokenTexts(os: NodeJS.Platform) {
  const linux = os === 'linux';
  const missing = (mac: string): DoctorResult =>
    linux ? { info: 'none: needed only to ring an iPhone in the background (the Android app does not use it)' } : mac;
  return {
    doctorName: linux ? 'iPhone registered (VoIP token)' : 'Phone registered (VoIP token)',
    /** `devices` = parsed devices.json, or undefined when the file does not exist. */
    result(devices: Record<string, { voipToken?: string }> | undefined): DoctorResult {
      if (!devices) return missing('!not paired yet');
      return Object.values(devices).some((x) => x.voipToken) ? Object.keys(devices).join(', ') : missing('!no token yet');
    },
  };
}

/** Linux doctor: the project roots on one line, or how to add one (voice-started sessions need one). */
export function projectRootsResult(roots: string[], home: string, configPath: string): DoctorResult {
  const tilde = (p: string) => (p === home ? '~' : p.startsWith(home + '/') ? '~' + p.slice(home.length) : p);
  if (roots.length) return roots.map(tilde).join(', ');
  return `!none, so sessions cannot be started by voice → add your project folders to "projectRoots" in ${tilde(configPath)}, then systemctl --user restart dev.callmeclaude.hub`;
}

/** `cmc help`. `secretStore` = the platform's secret store name, `thisMachine` = "this Mac" / "this computer". */
export function helpText(os: NodeJS.Platform, secretStore: string, thisMachine: string) {
  const tmux = os === 'linux' ? '\n                       --tmux | --no-tmux: run voice-started sessions in tmux or headless (claude -p)' : '';
  return `CallMeClaude — cmc <command>

  setup [--gemini-key K] [--language en-US] [--apns-key-file F --apns-key-id I --team-id T --bundle-id B]
                       Install hooks + service, store keys in the ${secretStore}${tmux}
  pair [--rotate]      Show the QR code for pairing the phone
  status               Sessions and pending decisions
  call-me [--text ..]  Ring the phone now (test)
  mode desk|away|ride|sleep
                       When the hub may hold sessions and call you
  run [dir] [task]     Start Claude Code inside tmux (so the hub can type into it)
  ignore [dir] [--remove|--list]
                       Watch-only: report status, never hold or call
  tell <project> "<instruction>"
                       Give a session an instruction, like answering it by phone
  do "<task>"          Let the hub do something on ${thisMachine} (browser/desktop)
  panic | resume       Interrupt everything / resume automation
  doctor               Check the installation
  logs [-f]            Hub logs
  restart | uninstall`;
}

/** `cmc setup --gemini-key` after the key was stored: a ✅ line on Linux, nothing on macOS (as before). */
export function geminiKeySavedText(os: NodeJS.Platform, secretStore: string): string | undefined {
  return os === 'linux' ? `✅ Gemini API key stored in the ${secretStore}.` : undefined;
}
