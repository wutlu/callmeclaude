import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { LOG_DIR } from '../config.ts';
import { execFileP } from '../util.ts';
import { binPath, SERVICE_LABEL } from './common.ts';
import type { Platform } from './types.ts';

// macOS implementation: moved verbatim from secrets.ts, install.ts, index.ts, brain.ts and hookServer.ts.

const PLIST_LABEL = SERVICE_LABEL;
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);

function darwinServicePath(node = process.execPath) {
  return ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', join(homedir(), '.local/bin'), dirname(node)].join(':');
}

/** launchd plist text (pure, for tests). */
export function darwinPlist(o: { node: string; bin: string; path: string; home: string; logDir: string }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key><array><string>${o.node}</string><string>${o.bin}</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${o.path}</string>
    <key>HOME</key><string>${o.home}</string>
    <key>NODE_NO_WARNINGS</key><string>1</string>
  </dict>
  <key>StandardOutPath</key><string>${join(o.logDir, 'launchd.out.log')}</string>
  <key>StandardErrorPath</key><string>${join(o.logDir, 'launchd.err.log')}</string>
</dict></plist>
`;
}

let peekabooPath: string | null | undefined;
async function peekaboo() {
  if (peekabooPath !== undefined) return peekabooPath;
  try {
    peekabooPath = (await zsh('command -v peekaboo')).stdout.trim() || null;
  } catch {
    peekabooPath = null;
  }
  return peekabooPath;
}

/** The computer task's tool instructions on macOS (moved verbatim from brain.ts). */
const CHIME = '/System/Library/Sounds/Glass.aiff';

/** Good default voices per locale; the first installed one wins (Siri voices can't be picked by `say -v`). */
const PREFERRED_VOICES = ['Samantha', 'Daniel', 'Yelda', 'Anna', 'Thomas', 'Amélie', 'Mónica', 'Paulina', 'Alice', 'Luciana', 'Joana', 'Xander', 'Ellen', 'Zosia', 'Milena', 'Majed', 'Lekha', 'Kyoko', 'Yuna', 'Tingting'];

/**
 * The `say` voice for a BCP-47 language from `say -v '?'` output (pure, for tests). Exact locale first
 * (tr-TR → tr_TR), then the same language; among those a well-known voice. undefined = the system voice.
 */
export function pickSayVoice(listing: string, language: string): string | undefined {
  const voices = listing
    .split('\n')
    .map((l) => /^(.+?)\s+([a-z]{2,3})[_-]([A-Za-z0-9]+)\s+#/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ name: m[1].trim(), lang: m[2], region: m[3].toUpperCase() }));
  const [lang, region] = language.split('-');
  const exact = voices.filter((v) => v.lang === lang && (!region || v.region === region.toUpperCase()));
  const same = exact.length ? exact : voices.filter((v) => v.lang === lang);
  if (!same.length) return undefined;
  return (PREFERRED_VOICES.map((p) => same.find((v) => v.name === p)).find(Boolean) ?? same[0]).name;
}

const voiceCache = new Map<string, string | undefined>();
async function sayVoice(language: string) {
  if (!voiceCache.has(language)) {
    const { stdout } = await execFileP('say', ['-v', '?'], { encoding: 'utf8' }).catch(() => ({ stdout: '' }));
    voiceCache.set(language, pickSayVoice(stdout, language));
  }
  return voiceCache.get(language);
}

export const DARWIN_TOOLS_BLOCK = `Tools (prefer them in this order):
- For the desktop and apps, use the Peekaboo MCP first (mcp__peekaboo__*): "see"/"image" to look at the screen (with window and element ids), then "click", "type", "hotkey", "app", "window", "scroll". Peekaboo has its own screen and accessibility permissions; the hub service has none.
- For a web page you may also use the Claude in Chrome tools (mcp__claude-in-chrome__*) if they are available: find the tab, read the page, click, fill forms.
- Use Bash fallbacks such as "screencapture", "osascript" or "cliclick" only if Peekaboo is missing. In the service context they may return an empty or wallpaper-only image: do not read that as "the screen is empty".`;

const zsh = (command: string, opts?: { timeout?: number }) => execFileP('/bin/zsh', ['-lc', command], { ...opts, encoding: 'utf8' });

export const darwin: Platform = {
  id: 'darwin',

  secrets: {
    displayName: 'Keychain',
    get(service, account) {
      try {
        const out = execFileSync('security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .toString()
          .trim();
        return out || undefined;
      } catch {
        return undefined;
      }
    },
    set(service, account, value) {
      execFileSync('security', ['add-generic-password', '-U', '-s', service, '-a', account, '-w', value], { stdio: 'ignore' });
    },
    delete(service, account) {
      try {
        execFileSync('security', ['delete-generic-password', '-s', service, '-a', account], { stdio: 'ignore' });
      } catch {}
    },
  },

  /** launchd agent: start at login, restart on crash. */
  service: {
    displayName: 'launchd',
    label: PLIST_LABEL,
    definitionPath: PLIST_PATH,
    async install() {
      const node = process.execPath;
      const plist = darwinPlist({ node, bin: binPath(), path: darwinServicePath(node), home: homedir(), logDir: LOG_DIR });
      mkdirSync(dirname(PLIST_PATH), { recursive: true });
      await execFileP('launchctl', ['bootout', `gui/${process.getuid!()}/${PLIST_LABEL}`]).catch(() => {});
      writeFileSync(PLIST_PATH, plist);
      await execFileP('launchctl', ['bootstrap', `gui/${process.getuid!()}`, PLIST_PATH]);
    },
    async uninstall() {
      await execFileP('launchctl', ['bootout', `gui/${process.getuid!()}/${PLIST_LABEL}`]).catch(() => {});
      if (existsSync(PLIST_PATH)) unlinkSync(PLIST_PATH);
    },
    async restart() {
      await execFileP('launchctl', ['kickstart', '-k', `gui/${process.getuid!()}/${PLIST_LABEL}`]);
    },
  },

  doctorChecks: () => [
    { name: 'Peekaboo (desktop control)', fn: async () => (await zsh('peekaboo --version')).stdout.trim().split('\n')[0] },
    { name: 'cliclick', fn: async () => !!(await zsh('command -v cliclick')).stdout.trim() },
    {
      name: 'System sleep disabled (pmset sleep 0)',
      fn: async () => {
        const { stdout } = await execFileP('pmset', ['-g']);
        const m = stdout.match(/^\s*sleep\s+(\d+)/m);
        return m && m[1] === '0' ? true : `!sleep=${m?.[1]} → sudo pmset -a sleep 0`;
      },
    },
    {
      name: 'Power on after power loss',
      fn: async () => {
        const cap = (await execFileP('pmset', ['-g', 'cap'])).stdout;
        if (!/autorestart/.test(cap)) return 'laptop: not supported, the battery acts as a UPS (keep it charging)';
        const { stdout } = await execFileP('pmset', ['-g']);
        const m = stdout.match(/autorestart\s+(\d)/);
        return m?.[1] === '1' ? true : '!sudo pmset -a autorestart 1';
      },
    },
    {
      name: 'No sleep with lid closed',
      fn: async () => {
        const isLaptop = /InternalBattery/.test((await execFileP('pmset', ['-g', 'batt'])).stdout);
        if (!isLaptop) return true;
        const { stdout } = await execFileP('pmset', ['-g']);
        return /SleepDisabled\s+1/.test(stdout) ? true : '!keep the lid open, or: sudo pmset -a disablesleep 1';
      },
    },
  ],

  async computerUse() {
    const pk = await peekaboo();
    const mcpServers: Record<string, any> = {};
    if (pk) mcpServers.peekaboo = { type: 'stdio', command: pk, args: ['mcp', '--allow-foreground'] };
    return { driver: 'peekaboo', subject: 'Mac', toolsBlock: DARWIN_TOOLS_BLOCK, extraRules: [], mcpServers, usable: true, cleanup() {} };
  },
  words: { owners: "the developer's Mac", the: 'the Mac', this: 'this Mac' },

  shellExec: zsh,
  servicePath: () => darwinServicePath(),
  tailscaleBins: ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'],
  isLanInterface: (name) => !name.startsWith('utun'),
  openFile(path) {
    spawnSync('open', [path]);
  },
  async speak(text, language) {
    const voice = await sayVoice(language);
    if (existsSync(CHIME)) await execFileP('afplay', ['-v', '0.5', CHIME]).catch(() => {});
    await execFileP('say', [...(voice ? ['-v', voice] : []), text], { timeout: 60_000 });
  },

  security: {
    protectedPaths: [/Library\/Keychains/],
    // Same alternatives, same order as the original single regex in brain.ts.
    destructive: [
      'rm\\s+-rf?\\s+[~\\/]',
      'mkfs',
      'diskutil\\s+erase',
      'dd\\s+if=',
      ':\\(\\)\\s*\\{',
      'shutdown',
      'halt\\b',
      'security\\s+(delete|dump|find-generic-password\\s+.*-w)',
      'launchctl\\s+unload',
      'csrutil',
      'sudo\\s',
    ],
  },

  // Report macOS privacy permissions as seen from inside the hub service (launchd context).
  async diagnostics() {
    const out: Record<string, string> = { node: process.execPath };
    try {
      out.peekaboo = (await zsh('peekaboo permissions', { timeout: 15000 })).stdout.trim();
    } catch (e) {
      out.peekaboo = 'could not run: ' + (e as Error).message;
    }
    try {
      // CGPreflightScreenCaptureAccess via a tiny Swift one-liner is heavy; use screencapture + window list instead.
      const { stdout } = await execFileP('/usr/bin/osascript', ['-e', 'tell application "System Events" to get name of first process whose frontmost is true'], { timeout: 8000 });
      out.accessibility = 'ok (' + stdout.trim() + ')';
    } catch (e) {
      out.accessibility = 'YOK: ' + (e as Error).message.split('\n')[0];
    }
    return out;
  },
};
