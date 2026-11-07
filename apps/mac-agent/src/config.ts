import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { projectRootCandidates } from './platform/projectRoots.ts';

export const DATA_DIR = process.env.CMC_HOME ?? join(homedir(), '.callmeclaude');
export const CONFIG_PATH = join(DATA_DIR, 'config.json');
export const STATE_PATH = join(DATA_DIR, 'state.json');
export const AUDIT_DIR = join(DATA_DIR, 'audit');
export const LOG_DIR = join(DATA_DIR, 'logs');
export const BRAIN_DIR = join(DATA_DIR, 'brain');

export type Mode = 'desk' | 'away' | 'ride' | 'sleep';
export type RingTarget = 'computer' | 'phone' | 'off';
/** Where "<project>: task complete." is said out loud when a session finishes a turn. */
export type DoneAlertTarget = 'off' | 'computer' | 'phone';
/** Where voice-started Claude Code sessions run: a detached tmux session, or a background `claude -p`. */
export type VoiceSessions = 'tmux' | 'headless';

export interface Config {
  hookPort: number;
  appPort: number;
  /** Bearer token used by Claude Code HTTP hooks (localhost). */
  hookToken: string;
  /** Token the phone app must present. Rotated by `cmc pair --rotate`. */
  appToken: string;
  mode: Mode;
  /** Where calls ring: the desktop app, the phone, or nowhere. */
  ringTarget: RingTarget;
  /** Spoken "task complete" alerts (off by default). Turns shorter than minSeconds stay silent. */
  doneAlert: { target: DoneAlertTarget; minSeconds: number };
  /** BCP-47 code of the language the voice agent speaks and summaries are written in (e.g. en-US, tr-TR). */
  language: string;
  voice: {
    provider: 'gemini-live';
    model: string;
    voiceName: string;
  };
  claude: {
    classifyModel: string;
    brainModel: string;
    computerModel: string;
    /** Use Claude-in-Chrome (`claude --chrome`) inside computer tasks. */
    useChrome: boolean;
  };
  apns: {
    teamId: string;
    keyId: string;
    bundleId: string;
    /** 'development' for Xcode-installed builds, 'production' for TestFlight/App Store. */
    environment: 'development' | 'production';
  };
  calls: {
    batchSeconds: { P1: number; P2: number };
    minGapSeconds: number;
    retryMissedAfterSeconds: number;
    maxRetries: number;
  };
  /** How long Stop / PermissionRequest hooks are held open waiting for the developer. */
  holdSeconds: number;
  projectRoots: string[];
  /** Watch-only folders: sessions are tracked and reported, but never held and never trigger calls. */
  ignorePaths: string[];
  /** Per-project auto-approve rules: tool name prefixes, e.g. "Bash(npm test", "Edit". */
  autoApprove: Record<string, string[]>;
  /**
   * 'critical' (default, also when absent): approve every permission request except critical ones (payments,
   * sign-ups and logins, card numbers, messages to other people, wiping data). 'ask': ask for everything except
   * read-only requests and autoApprove rules.
   */
  approvals?: 'critical' | 'ask';
  /**
   * Claude Code's permission mode for every session. 'bypass' (default, also when absent): sessions run like
   * `claude --dangerously-skip-permissions`; `cmc setup` sets it as Claude Code's default mode, and the sessions
   * the hub starts get it too. Critical actions still ask (the PreToolUse hook). 'keep': leave Claude Code's own
   * mode alone; hub-started sessions use acceptEdits.
   */
  sessionPermissions?: 'bypass' | 'keep';
  /** Claude Code's defaultMode before `cmc setup` switched it to bypassPermissions (restored by uninstall). */
  claudeDefaultModeBefore?: string | null;
  /** In 'ask' mode, approve requests that only read (files, git/CI status) without calling. Absent = on. */
  autoApproveReadOnly?: boolean;
  /** Linux only, chosen by `cmc setup` (absent = tmux). Not in the defaults, so macOS configs never get this key. */
  voiceSessions?: VoiceSessions;
}

export type PermissionMode = 'bypassPermissions' | 'acceptEdits';

/** The --permission-mode for sessions the hub starts. */
export function sessionPermissionMode(cfg: Pick<Config, 'sessionPermissions'>): PermissionMode {
  return cfg.sessionPermissions === 'keep' ? 'acceptEdits' : 'bypassPermissions';
}

export function defaultRoots(os: NodeJS.Platform = process.platform, home = homedir()): string[] {
  return projectRootCandidates(os)
    .map((p) => join(home, p))
    .filter((p) => existsSync(p));
}

export function defaultConfig(): Config {
  return {
    hookPort: 47800,
    appPort: 47801,
    hookToken: randomBytes(24).toString('hex'),
    appToken: randomBytes(24).toString('base64url'),
    mode: 'away',
    ringTarget: 'phone',
    doneAlert: { target: 'off', minSeconds: 20 },
    language: 'en-US',
    voice: { provider: 'gemini-live', model: 'gemini-3.8-live', voiceName: 'Puck' },
    claude: {
      classifyModel: 'haiku',
      brainModel: 'sonnet',
      computerModel: 'sonnet',
      useChrome: true,
    },
    apns: { teamId: '', keyId: '', bundleId: '', environment: 'development' },
    calls: { batchSeconds: { P1: 15, P2: 45 }, minGapSeconds: 90, retryMissedAfterSeconds: 180, maxRetries: 2 },
    holdSeconds: 1500,
    projectRoots: defaultRoots(),
    ignorePaths: [],
    autoApprove: {},
  };
}

/** How voice-started sessions run on this OS. macOS always uses tmux. */
export function voiceSessionMode(cfg: Pick<Config, 'voiceSessions'>, os: NodeJS.Platform = process.platform): VoiceSessions {
  return os === 'linux' && cfg.voiceSessions === 'headless' ? 'headless' : 'tmux';
}

/**
 * What `cmc setup` should do about voiceSessions (pure, for tests):
 * undefined = leave the config alone (not Linux), 'ask' = prompt the user, otherwise the value to store.
 */
export function planVoiceSessions(o: {
  os: NodeJS.Platform;
  flags: Record<string, unknown>;
  interactive: boolean;
  tmuxInstalled: boolean;
}): VoiceSessions | 'ask' | undefined {
  if (o.os !== 'linux') return undefined;
  if (o.flags.tmux && o.flags['no-tmux']) throw new Error('Use either --tmux or --no-tmux, not both.');
  if (o.flags.tmux) return 'tmux';
  if (o.flags['no-tmux']) return 'headless';
  if (o.interactive) return 'ask';
  return o.tmuxInstalled ? 'tmux' : 'headless';
}

/**
 * The answer to the Linux setup question (pure). Choice 1 is the default shown first: tmux when it is installed,
 * headless otherwise. Empty = the default; the option names work too. Anything else: undefined (ask again).
 */
export function parseVoiceSessionsAnswer(answer: string, tmuxInstalled: boolean): VoiceSessions | undefined {
  const a = answer.trim().toLowerCase();
  const [first, second]: VoiceSessions[] = tmuxInstalled ? ['tmux', 'headless'] : ['headless', 'tmux'];
  if (a === '' || a === '1') return first;
  if (a === '2') return second;
  if (a === 'tmux' || a === 'headless') return a;
  return undefined;
}

/** True if dir is one of the project roots or inside one. */
export function inProjectRoots(roots: string[], dir: string) {
  return roots.some((r) => dir === r || dir.startsWith(r + '/'));
}

export function ensureDirs() {
  for (const d of [DATA_DIR, AUDIT_DIR, LOG_DIR, BRAIN_DIR]) mkdirSync(d, { recursive: true, mode: 0o700 });
}

function deepMerge<T>(base: T, over: any): T {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return (over ?? base) as T;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const k of Object.keys(over)) {
    const b = (base as any)?.[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) ? deepMerge(b, over[k]) : over[k];
  }
  return out;
}

export function loadConfig(): Config {
  ensureDirs();
  if (!existsSync(CONFIG_PATH)) {
    const c = defaultConfig();
    saveConfig(c);
    return c;
  }
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  return deepMerge(defaultConfig(), raw);
}

export function saveConfig(c: Config) {
  ensureDirs();
  writeAtomic(CONFIG_PATH, JSON.stringify(c, null, 2));
}

export function writeAtomic(path: string, data: string) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}
