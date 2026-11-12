import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { LOG_DIR } from '../config.ts';
import { execFileP } from '../util.ts';
import { binPath, SERVICE_LABEL } from './common.ts';
import { SecretStoreError, type DoctorResult, type Platform, type SecretState } from './types.ts';
import {
  desktopSessionEnv,
  envSummary,
  needsSessionEnv,
  SESSION_VARS,
  blockedInput,
  installCommand,
  linuxExtraRules,
  linuxToolsBlock,
  packageManager,
  selectComputerDriver,
  UINPUT_RISK,
  uinputSteps,
  ydotoolTooOld,
  ydotoolVersion,
  type ComputerDriver,
  type PackageManager,
  type YdotoolVersion,
} from './computerUse.ts';

const UNIT_NAME = `${SERVICE_LABEL}.service`;

/** The program `speak` uses, best first: speech-dispatcher, then espeak-ng / espeak. Pure. */
export function speechTool(has: (bin: string) => boolean): 'spd-say' | 'espeak-ng' | 'espeak' | undefined {
  return (['spd-say', 'espeak-ng', 'espeak'] as const).find((b) => has(b));
}

/** Doctor line for spoken "task complete" alerts on this computer. Missing = a note, not a problem. Pure. */
export function speechReport(tool: ReturnType<typeof speechTool>, pm: PackageManager | undefined): DoctorResult {
  if (tool === 'spd-say') return 'speech-dispatcher (spd-say)';
  if (tool) return `${tool} (sounds robotic; speech-dispatcher sounds better → ${installCommand(pm, ['speech-dispatcher'])})`;
  return { info: `nothing can speak (spd-say, espeak-ng or espeak), so alerts set to "computer" stay silent → ${installCommand(pm, ['speech-dispatcher', 'espeak-ng'])}` };
}

/** Does systemd-resolved answer mDNS (MulticastDNS=yes globally and on a link)? From `resolvectl status`. Pure. */
export function resolvedAnswersMdns(status: string): boolean {
  // systemd >= 246: "Protocols: ... +mDNS ..." per section ("mDNS/resolve" only looks names up);
  // older: "MulticastDNS setting: yes".
  const sections = status.split(/\n(?=\S)/);
  const on = (sec: string) => /(^|\s)\+mDNS(\s|$)/m.test(sec) || /MulticastDNS setting:\s*yes/.test(sec);
  const global = sections.find((x) => x.startsWith('Global'));
  const links = sections.filter((x) => x.startsWith('Link'));
  return !!global && on(global) && links.some(on);
}

/**
 * Doctor line for the `<host>.local` address the hub gives the phone. Without a responder (avahi-daemon,
 * or systemd-resolved with MulticastDNS) that name resolves to nothing: after the computer changes
 * network the phone cannot find it again except via Tailscale or pairing again. Advice only. Pure.
 */
export function mdnsReport(name: string | undefined, r: { avahi: boolean; resolved: boolean }, pm: PackageManager | undefined): DoctorResult {
  if (!name) return { info: 'no .local name sent to the phone (the hostname has characters mDNS names cannot have)' };
  if (r.avahi) return `${name} (avahi-daemon)`;
  if (r.resolved) return `${name} (systemd-resolved)`;
  return {
    info:
      `the phone gets ${name}, but nothing here answers it (avahi-daemon inactive, systemd-resolved MulticastDNS off): ` +
      `after a Wi-Fi change the phone finds this computer again only via Tailscale or a new pairing → ` +
      `${installCommand(pm, ['avahi'])} && sudo systemctl enable --now avahi-daemon`,
  };
}

const shq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** How the computer task's agent runs the hub's type-text helper (this node, this checkout's cmc). */
export const typeTextCommand = () => `${shq(process.execPath)} ${shq(binPath())} type-text`;
const UNIT_PATH = join(homedir(), '.config', 'systemd', 'user', UNIT_NAME);

/** Full path of `bin` on PATH, or undefined. */
export function which(bin: string, path = process.env.PATH ?? '') {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, bin), constants.X_OK);
      return join(dir, bin);
    } catch {}
  }
  return undefined;
}

/** Is `bin` an executable somewhere on PATH? */
export function onPath(bin: string, path = process.env.PATH ?? '') {
  return which(bin, path) !== undefined;
}

/** Same idea as the launchd PATH: system bins, the user's ~/.local/bin, and the directory of the running node. */
export function linuxServicePath(home: string, node: string) {
  const dirs = ['/usr/local/bin', '/usr/bin', '/bin', join(home, '.local/bin'), dirname(node)];
  return [...new Set(dirs)].join(':');
}

/** Escape a value for a systemd unit file: specifiers (%) always; quotes/backslashes inside "…" words. */
const sdEscape = (s: string) => s.replace(/%/g, '%%');
const sdQuote = (s: string) => `"${sdEscape(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** systemd --user unit text (pure, for tests). */
export function linuxUnit(o: { node: string; bin: string; path: string; home: string; logDir: string }) {
  return `[Unit]
Description=CallMeClaude hub (watches Claude Code sessions, calls your phone)

[Service]
Type=simple
ExecStart=${sdQuote(o.node)} ${sdQuote(o.bin)} serve
Restart=always
RestartSec=10
Environment=${sdQuote(`PATH=${o.path}`)}
Environment=${sdQuote(`HOME=${o.home}`)}
Environment=NODE_NO_WARNINGS=1
StandardOutput=append:${sdEscape(join(o.logDir, 'systemd.out.log'))}
StandardError=append:${sdEscape(join(o.logDir, 'systemd.err.log'))}

[Install]
WantedBy=default.target
`;
}

const SECRET_HELP = `Install secret-tool (Debian/Ubuntu: sudo apt install libsecret-tools · Fedora: sudo dnf install libsecret · Arch: sudo pacman -S libsecret) and make sure a Secret Service provider (GNOME Keyring, KDE Wallet or KeePassXC) is running and unlocked in this session, then run the setup command again.
   Alternative: put GEMINI_API_KEY into the service environment (systemctl --user edit ${UNIT_NAME}).
   Nothing was written to disk: CallMeClaude never stores secrets in plain-text files.`;

/**
 * Why `secret-tool lookup` gave no secret (pure). secret-tool exits 1 without a word both for "no such item" and
 * for a locked keyring whose unlock prompt cannot be shown (no desktop yet), so the default collection's Locked
 * property (`locked`, read over D-Bus) decides between them. A Secret Service that is not running at all (the hub
 * started by linger before the desktop login) is named on stderr.
 */
export function classifySecretLookup(o: { status: number | null; stdout: string; stderr: string; locked?: boolean }): SecretState {
  if (o.status === 0 && o.stdout.trim()) return 'found';
  const err = o.stderr.trim();
  if (/\blocked\b|prompt|dismiss/i.test(err)) return 'locked';
  if (/org\.freedesktop\.secrets|not provided by any|ServiceUnknown|autolaunch|Could not connect|Failed to connect|No such file or directory/i.test(err)) return 'unreachable';
  if (o.locked === true) return 'locked';
  if (o.locked === false && !err) return 'missing';
  return 'unknown';
}

/** `b true` / `b false` from busctl get-property; undefined for anything else. */
export const parseBusctlBool = (out: string) => (/^b true\s*$/.test(out.trim()) ? true : /^b false\s*$/.test(out.trim()) ? false : undefined);

/** Is the keyring's default collection locked? Read-only D-Bus property; undefined when it cannot be read. */
function defaultCollectionLocked(): boolean | undefined {
  const r = spawnSync(
    'busctl',
    ['--user', 'get-property', 'org.freedesktop.secrets', '/org/freedesktop/secrets/aliases/default', 'org.freedesktop.Secret.Collection', 'Locked'],
    { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  return r.status === 0 ? parseBusctlBool(r.stdout ?? '') : undefined;
}

/** The login shell: $SHELL if set, else /bin/sh (no zsh assumption on Linux). */
export const linuxShell = (env: NodeJS.ProcessEnv = process.env) => env.SHELL || '/bin/sh';

const systemctl = (...args: string[]) => execFileP('systemctl', ['--user', ...args]);

/** Parse `key=value` lines (systemd-analyze cat-config output); later lines win, comments ignored. */
export function parseConf(text: string) {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Output of a short, read-only command (version/help/package query); '' when it fails. Never sends input. */
function readOnly(cmd: string, args: string[], o: { stderr?: boolean } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) return '';
  if (!o.stderr) return r.status === 0 ? r.stdout : '';
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

/**
 * ydotool's version, or undefined when it is not on PATH. The package version is asked only when the binary
 * is the distribution's (/usr/bin, /bin); a ydotool built into /usr/local/bin is judged by its own output.
 * Only `--version` / `--help` are run: they print and exit, they never send input.
 */
export function probeYdotool(path = process.env.PATH ?? ''): YdotoolVersion | undefined {
  const bin = which('ydotool', path);
  if (!bin) return undefined;
  let pkg = '';
  if (/^\/(usr\/)?bin\//.test(bin)) {
    const pm = packageManager(osRelease());
    if (pm === 'pacman') pkg = readOnly('pacman', ['-Q', 'ydotool']);
    else if (pm === 'apt') pkg = readOnly('dpkg-query', ['-W', '-f=${Version}', 'ydotool']);
    else if (pm === 'dnf') pkg = readOnly('rpm', ['-q', '--qf', '%{VERSION}', 'ydotool']);
  }
  const cli = `${readOnly(bin, ['--version'], { stderr: true })}\n${readOnly(bin, ['--help'], { stderr: true })}`;
  return ydotoolVersion({ pkg: pkg || undefined, cli });
}

/**
 * The computer-use driver for this environment and PATH. A ydotool that is not 1.x counts as absent
 * (its command line differs from the one the agent is told to use).
 */
export function linuxComputerDriver(env: NodeJS.ProcessEnv = process.env, ydotool: YdotoolVersion | undefined = probeYdotool(env.PATH)) {
  return selectComputerDriver(env, (b) => (b === 'ydotool' ? !!ydotool?.supported && onPath(b, env.PATH) : onPath(b, env.PATH)));
}

/** Browser config dirs where Claude Code installs its Claude in Chrome native messaging host. */
const BROWSER_DIRS = ['google-chrome', 'google-chrome-beta', 'chromium', 'microsoft-edge', 'BraveSoftware/Brave-Browser', 'vivaldi'];
const CHROME_HOST = 'com.anthropic.claude_code_browser_extension.json';

/** Browsers that have the Claude in Chrome native host installed (set up by `claude --chrome` / `/chrome`). */
export function chromeHosts(home = homedir()) {
  return BROWSER_DIRS.filter((d) => existsSync(join(home, '.config', d, 'NativeMessagingHosts', CHROME_HOST)));
}

function osRelease() {
  try {
    return readFileSync('/etc/os-release', 'utf8');
  } catch {
    return '';
  }
}

/** ydotoold's socket: $YDOTOOL_SOCKET, else the 1.x default in $XDG_RUNTIME_DIR, else the old /tmp one. */
function ydotoolSocket(env = process.env) {
  const c = [env.YDOTOOL_SOCKET, env.XDG_RUNTIME_DIR && join(env.XDG_RUNTIME_DIR, '.ydotool_socket'), '/tmp/.ydotool_socket'].filter(Boolean) as string[];
  return c.find((p) => existsSync(p));
}

const canWrite = (p: string) => {
  try {
    accessSync(p, constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

const ind = (lines: string[]) => lines.map((l) => `\n      ${l}`).join('');

function driverReport(d: ComputerDriver) {
  if (d.env.session === 'none') return `!${d.notes.join(' ')}`;
  const parts = [`${d.id}: screenshot ${d.screenshot ?? '—'}, input ${d.input ?? '—'}, clipboard ${d.clipboard ?? '—'}`];
  if (!d.desktop) return `!${parts[0]}. ${d.notes.join(' ')}`;
  if (!d.input) return `!${parts[0]}. Look-only: no mouse/keyboard tool${d.env.session === 'wayland' ? ' (ydotool, see below)' : ''}.`;
  if (!d.clipboard) return `!${parts[0]}. Cannot type text: no clipboard tool (see missing tools below); clicks and single keys still work.`;
  return parts[0];
}

/** Undo systemd's $'…' quoting of values with special characters (show-environment, systemd ≥ 240). */
function unquoteSystemd(v: string) {
  const m = v.match(/^\$'(.*)'$/s);
  if (!m) return v;
  return m[1].replace(/\\(x[0-9a-fA-F]{2}|[0-7]{3}|.)/g, (_, e: string) => {
    if (e.length === 3 && e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^[0-7]{3}$/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return ({ n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b' } as Record<string, string>)[e] ?? e;
  });
}

/** Parse `systemctl --user show-environment` output (NAME=value lines, $'…' values unquoted). */
export function parseEnvBlock(text: string) {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = unquoteSystemd(m[2]);
  }
  return out;
}

/** The systemd user manager's environment (read only); {} when systemctl is unavailable. */
async function systemdUserEnv() {
  try {
    return parseEnvBlock((await execFileP('systemctl', ['--user', 'show-environment'], { timeout: 5000 })).stdout);
  } catch {
    return {};
  }
}

/**
 * This process's environment completed with the desktop session from systemd when it lacks one
 * (the hub started at boot by linger, before anyone logged in to the desktop). Nothing is written to process.env.
 */
export async function linuxSessionEnv(proc: NodeJS.ProcessEnv = process.env) {
  if (!needsSessionEnv(proc)) return { env: proc, fromSystemd: {} as Record<string, string> };
  return desktopSessionEnv(proc, await systemdUserEnv());
}

const SLEEP_TARGETS = ['sleep.target', 'suspend.target', 'hibernate.target', 'hybrid-sleep.target'];

export const linux: Platform = {
  id: 'linux',

  secrets: {
    displayName: 'keyring (libsecret)',
    get(service, account) {
      try {
        const out = execFileSync('secret-tool', ['lookup', 'service', service, 'account', account], {
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 15_000,
        })
          .toString()
          .trim();
        return out || undefined;
      } catch {
        return undefined;
      }
    },
    set(service, account, value) {
      if (!onPath('secret-tool')) throw new SecretStoreError(`secret-tool not found, could not store "${account}".\n   ${SECRET_HELP}`);
      try {
        execFileSync('secret-tool', ['store', `--label=CallMeClaude ${account}`, 'service', service, 'account', account], {
          input: value,
          stdio: ['pipe', 'ignore', 'pipe'],
          timeout: 60_000,
        });
      } catch (e) {
        const why = String((e as any).stderr ?? '').trim() || (e as Error).message.split('\n')[0];
        throw new SecretStoreError(`secret-tool could not store "${account}" (${why}).\n   ${SECRET_HELP}`);
      }
    },
    delete(service, account) {
      try {
        execFileSync('secret-tool', ['clear', 'service', service, 'account', account], { stdio: 'ignore', timeout: 15_000 });
      } catch {}
    },
    diagnose(service, account) {
      if (!onPath('secret-tool')) return 'unreachable';
      const r = spawnSync('secret-tool', ['lookup', 'service', service, 'account', account], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
      const o = { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      const quick = classifySecretLookup(o);
      // A silent exit 1: ask whether the keyring is locked (only then, it is one more D-Bus round trip).
      return quick === 'unknown' ? classifySecretLookup({ ...o, locked: defaultCollectionLocked() }) : quick;
    },
  },

  service: {
    displayName: 'systemd --user',
    label: SERVICE_LABEL,
    definitionPath: UNIT_PATH,
    async install() {
      const node = process.execPath;
      const unit = linuxUnit({ node, bin: binPath(), path: linuxServicePath(homedir(), node), home: homedir(), logDir: LOG_DIR });
      const wasActive = await systemctl('is-active', '--quiet', UNIT_NAME).then(() => true, () => false);
      mkdirSync(dirname(UNIT_PATH), { recursive: true });
      writeFileSync(UNIT_PATH, unit);
      await systemctl('daemon-reload');
      await systemctl('enable', '--now', UNIT_NAME);
      // launchd's bootout+bootstrap always reloads; do the same when the hub was already running with an old unit/config.
      if (wasActive) await systemctl('restart', UNIT_NAME);
    },
    async uninstall() {
      await systemctl('disable', '--now', UNIT_NAME).catch(() => {});
      if (existsSync(UNIT_PATH)) unlinkSync(UNIT_PATH);
      await systemctl('daemon-reload').catch(() => {});
    },
    async restart() {
      await systemctl('restart', UNIT_NAME);
    },
  },

  // Checks and advice only: nothing here changes the system or runs sudo.
  doctorChecks: () => [
    {
      name: 'Secret store (secret-tool)',
      fn: async () => (onPath('secret-tool') ? true : '!not installed → libsecret-tools / libsecret package'),
    },
    {
      name: 'Hub runs without a login (linger)',
      fn: async () => {
        const user = process.env.USER || userInfo().username;
        const { stdout } = await execFileP('loginctl', ['show-user', user, '-p', 'Linger']);
        return /Linger=yes/.test(stdout) ? true : `!off → sudo loginctl enable-linger ${user}`;
      },
    },
    {
      name: 'System sleep disabled (sleep targets masked)',
      fn: async () => {
        // is-enabled exits non-zero for masked units; the per-unit lines are still on stdout.
        const { stdout } = await execFileP('systemctl', ['is-enabled', ...SLEEP_TARGETS]).catch((e) => ({ stdout: String(e.stdout ?? '') }));
        const states = stdout.trim().split('\n');
        const open = SLEEP_TARGETS.filter((_, i) => !/^masked/.test(states[i] ?? ''));
        return open.length ? `!not masked: ${open.join(' ')} → sudo systemctl mask ${SLEEP_TARGETS.join(' ')}` : true;
      },
    },
    {
      name: 'No sleep with lid closed',
      fn: async () => {
        let isLaptop = false;
        try {
          isLaptop = readdirSync('/sys/class/power_supply').some((n) => n.startsWith('BAT'));
        } catch {}
        if (!isLaptop) return true;
        const { stdout } = await execFileP('systemd-analyze', ['cat-config', 'systemd/logind.conf']);
        const conf = parseConf(stdout);
        // logind defaults: HandleLidSwitch=suspend; HandleLidSwitchExternalPower falls back to HandleLidSwitch.
        const battery = conf.HandleLidSwitch ?? 'suspend';
        const ac = conf.HandleLidSwitchExternalPower ?? battery;
        return battery === 'ignore' && ac === 'ignore'
          ? true
          : `!HandleLidSwitch=${battery}, HandleLidSwitchExternalPower=${ac} → keep the lid open, or set both to ignore in /etc/systemd/logind.conf.d/`;
      },
    },
    {
      name: 'Spoken alerts on this computer',
      fn: async () => speechReport(speechTool(onPath), packageManager(osRelease())),
    },
    {
      name: 'Bonjour name (mDNS)',
      fn: async () => {
        const { mdnsName } = await import('../addresses.ts');
        const avahi = await execFileP('systemctl', ['is-active', 'avahi-daemon'])
          .then(() => true)
          .catch(() => false);
        // resolvectl fails when systemd-resolved isn't running: then it answers nothing either.
        const resolved = await execFileP('resolvectl', ['status'], { timeout: 4000 })
          .then((r) => resolvedAnswersMdns(r.stdout))
          .catch(() => false);
        return mdnsReport(mdnsName(), { avahi, resolved }, packageManager(osRelease()));
      },
    },
    ...computerUseChecks(),
  ],

  async computerUse({ useChrome }) {
    const session = await linuxSessionEnv();
    const d = linuxComputerDriver(session.env);
    const browser = useChrome && chromeHosts().length > 0;
    if (!d.desktop && !browser) {
      return {
        driver: d.id,
        subject: 'computer',
        toolsBlock: '',
        extraRules: [],
        mcpServers: {},
        usable: false,
        unsupported: `Operating this computer is not supported in this environment (${envSummary(d.env)}): ${d.notes.join(' ')} The Claude in Chrome browser tools are not set up either. Run cmc doctor on the computer for the steps.`,
        cleanup() {},
      };
    }
    // Private per-task directory for screenshots (0700); removed when the task ends, whatever the agent did.
    const shotDir = d.desktop ? mkdtempSync(join(tmpdir(), 'cmc-screen-')) : '';
    return {
      driver: d.id,
      subject: 'computer',
      toolsBlock: linuxToolsBlock(d, { shotDir, browser, typeCmd: typeTextCommand() }),
      extraRules: linuxExtraRules(d),
      mcpServers: {},
      ...(Object.keys(session.fromSystemd).length ? { env: session.fromSystemd } : {}),
      usable: true,
      cleanup() {
        if (shotDir) rmSync(shotDir, { recursive: true, force: true });
      },
    };
  },
  words: { owners: "the developer's computer", the: 'this computer', this: 'this computer' },

  shellExec: (command, opts) => execFileP(linuxShell(), ['-lc', command], { ...opts, encoding: 'utf8' }),
  servicePath: () => linuxServicePath(homedir(), process.execPath),
  tailscaleBins: ['tailscale'],
  isLanInterface: (name) => !name.startsWith('tailscale'),
  async speak(text, language) {
    const lang = language.split('-')[0];
    const bin = speechTool(onPath);
    if (bin === 'spd-say') return void (await execFileP('spd-say', ['-w', '-l', lang, text], { timeout: 60_000 }));
    if (bin) return void (await execFileP(bin, ['-v', lang, text], { timeout: 60_000 }));
    throw new Error('Nothing can speak on this computer. Install speech-dispatcher (spd-say) or espeak-ng.');
  },
  openFile(path) {
    // xdg-open may stay in the foreground with some viewers: detach. Errors (headless box) are ignored.
    try {
      const p = spawn('xdg-open', [path], { detached: true, stdio: 'ignore' });
      p.on('error', () => {});
      p.unref();
    } catch {}
  },

  security: {
    protectedPaths: [/\.local\/share\/keyrings/, /\.local\/share\/kwalletd/],
    destructive: [
      'rm\\s+-rf?\\s+[~\\/]',
      'mkfs',
      'wipefs',
      'blkdiscard',
      'dd\\s+if=',
      ':\\(\\)\\s*\\{',
      'shutdown',
      'halt\\b',
      'poweroff\\b',
      'systemctl\\s+.*\\b(poweroff|reboot|halt|kexec)\\b',
      'secret-tool\\s+(lookup|clear|search)',
      'systemctl\\s+.*\\b(stop|disable|mask|kill)\\b.*dev\\.callmeclaude',
      'sudo\\s',
    ],
    inputGuard: blockedInput,
  },

  async diagnostics() {
    const { env, fromSystemd } = await linuxSessionEnv();
    return {
      node: process.execPath,
      platform: `linux ${process.arch}`,
      shell: linuxShell(),
      display:
        (env.WAYLAND_DISPLAY ? `wayland (${env.WAYLAND_DISPLAY})` : env.DISPLAY ? `x11 (${env.DISPLAY})` : 'none') +
        (Object.keys(fromSystemd).length ? ' (from systemd --user)' : ''),
      secretTool: onPath('secret-tool') ? 'found' : 'missing',
      computerUse: (() => {
        const d = linuxComputerDriver(env);
        return `${d.id} (${envSummary(d.env)}): screenshot ${d.screenshot ?? 'none'}, input ${d.input ?? 'none'}`;
      })(),
      chrome: chromeHosts().join(', ') || 'native host not installed',
    };
  },
};

const IMPORT_ENV = `systemctl --user import-environment ${SESSION_VARS.join(' ')}`;

/**
 * Doctor: what a hub service started without a desktop (linger) will find when a computer task starts.
 * It reads the session from the systemd user manager then, so only the manager's environment matters (pure).
 */
export function serviceSessionReport(systemdEnv: Record<string, string>, shell: ComputerDriver, ydotool?: YdotoolVersion): string {
  const { env, fromSystemd } = desktopSessionEnv({}, systemdEnv);
  if (!fromSystemd.DISPLAY && !fromSystemd.WAYLAND_DISPLAY) {
    return `!systemd --user has no DISPLAY or WAYLAND_DISPLAY yet, so a computer task cannot reach the desktop. The hub reads them from systemd --user when a computer task starts; most desktops put them there at login. If they are still missing while you are logged in → ${IMPORT_ENV} (no restart needed)`;
  }
  const svc = linuxComputerDriver({ ...env, PATH: process.env.PATH }, ydotool);
  if (svc.id !== shell.id) {
    return `!systemd --user gives "${svc.id}", this shell "${shell.id}"; the hub uses the systemd values → ${IMPORT_ENV} (no restart needed)`;
  }
  return `${svc.id} (read from systemd --user when a computer task starts)`;
}

/** Doctor checks for computer use: detect, report and advise only. Nothing here changes the system. */
function computerUseChecks() {
  const ydotool = probeYdotool();
  const d = linuxComputerDriver(process.env, ydotool);
  const pm = packageManager(osRelease());
  const user = process.env.USER || userInfo().username;
  const checks: { name: string; fn: () => Promise<boolean | string> }[] = [
    { name: 'Computer use: desktop session', fn: async () => (d.env.session === 'none' ? `!${d.notes[0]}` : envSummary(d.env)) },
    { name: 'Computer use: driver', fn: async () => driverReport(d) },
  ];
  const needed = d.missing.filter((m) => m.tool !== 'ydotool');
  if (needed.length) {
    checks.push({
      name: 'Computer use: missing tools',
      fn: async () => `!${needed.map((m) => `${m.tool} (${m.purpose === 'clipboard' ? 'clipboard, needed to type text' : m.purpose})`).join(', ')} → ${installCommand(pm, needed.map((m) => m.tool))}`,
    });
  }
  if (d.env.session === 'wayland') {
    checks.push({
      name: 'Computer use: ydotool (optional, Wayland mouse/keyboard)',
      fn: async () => {
        let userUnit = false;
        try {
          await execFileP('systemctl', ['--user', 'cat', 'ydotool.service']);
          userUnit = true;
        } catch {}
        const installed = d.input === 'ydotool';
        const tooOld = ydotool && !ydotool.supported ? ydotool : undefined;
        const uinput = canWrite('/dev/uinput');
        const sock = ydotoolSocket();
        if (installed && uinput && sock) return `ready (ydotool ${ydotool?.version ?? '1.x'}, ydotoold socket ${sock}). ${UINPUT_RISK.replace('once this is allowed', 'because it is allowed')}`;
        const state = [
          tooOld ? ydotoolTooOld(tooOld).split(';')[0] : `ydotool ${installed ? 'installed' : 'not installed'}`,
          `/dev/uinput ${uinput ? 'already writable' : 'not writable for ' + user}`,
          `ydotoold ${sock ? 'running' : 'not running'}`,
        ];
        const steps = uinputSteps(pm, user, { installed, uinput, daemon: !!sock, userUnit, tooOld });
        return `!${state.join(', ')}. One-time setup, run it yourself only if you want this:${ind(steps.map((x, i) => `${i + 1}. ${x}`))}${ind([UINPUT_RISK])}`;
      },
    });
  }
  checks.push({
    name: 'Computer use: hub service sees the desktop',
    fn: async () => serviceSessionReport(parseEnvBlock((await execFileP('systemctl', ['--user', 'show-environment'])).stdout), d, ydotool),
  });
  checks.push({
    name: 'Computer use: browser (Claude in Chrome)',
    fn: async () => {
      const found = chromeHosts();
      // Only the native host file is visible from here, not whether the extension has connected to it.
      return found.length
        ? `native host installed for ${found.join(', ')}; whether the extension is connected cannot be checked from here: run \`claude --chrome\` once to make sure`
        : '!not set up → install the Claude in Chrome extension and run `claude --chrome` once';
    },
  });
  return checks;
}
