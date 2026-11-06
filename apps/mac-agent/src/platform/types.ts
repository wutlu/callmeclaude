/** Everything the hub does differently per operating system lives behind this interface. */

export type DoctorResult = boolean | string | { info: string };
/**
 * A doctor check: `true`/plain string = ok, `false`/string starting with "!" = problem, `{ info }` = neither:
 * a note about something optional on this OS (see doctorLine in cliTexts.ts).
 */
export interface DoctorCheck {
  name: string;
  fn: () => Promise<DoctorResult>;
}

export interface SecretStore {
  /** Human-facing name, e.g. "Keychain". */
  displayName: string;
  /** Raw stored string, or undefined if missing/unreadable. */
  get(service: string, account: string): string | undefined;
  /** Store a raw string. Throws on failure (never falls back to plain-text files). */
  set(service: string, account: string, value: string): void;
  /** Delete; never throws. */
  delete(service: string, account: string): void;
  /** Linux only: after get() returned nothing, why (see classifySecretLookup). Absent on macOS. */
  diagnose?(service: string, account: string): SecretState;
}

/** Why a secret could not be read: not stored, keyring locked, no Secret Service reachable, or cannot tell. */
export type SecretState = 'found' | 'missing' | 'locked' | 'unreachable' | 'unknown';

export interface ServiceManager {
  /** Shown to the user, e.g. "launchd". */
  displayName: string;
  /** launchd label / systemd unit base name. */
  label: string;
  /** Path of the service definition file (plist / unit). */
  definitionPath: string;
  install(): Promise<void>;
  uninstall(): Promise<void>;
  restart(): Promise<void>;
}

/** How the computer task's agent operates this machine (see brain.ts). */
export interface ComputerUsePlan {
  /** Driver id: 'peekaboo' on macOS (even when Peekaboo is missing: the Bash fallbacks are part of it), a Linux driver id, or 'none'. */
  driver: string;
  /** "Mac" / "computer": completes "you operate the developer's …". */
  subject: string;
  /** The "Tools (prefer them in this order): …" block of the system prompt. */
  toolsBlock: string;
  /** Rules appended after the shared ones (none on macOS). */
  extraRules: string[];
  mcpServers: Record<string, any>;
  /**
   * Variables the agent process gets on top of the hub's environment (Linux: the desktop session read from
   * systemd --user when the hub started before the desktop login). Absent on macOS.
   */
  env?: Record<string, string>;
  /** false when nothing at all can operate this machine: the task is refused with `unsupported`. */
  usable: boolean;
  unsupported?: string;
  /** Called when the task ends (removes the Linux screenshot directory). */
  cleanup(): void;
}

/** Wording that names this machine in user- and model-facing texts. */
export interface MachineWords {
  /** "the developer's Mac" / "the developer's computer" */
  owners: string;
  /** "the Mac" / "this computer" */
  the: string;
  /** "this Mac" / "this computer" */
  this: string;
}

export interface Platform {
  id: 'darwin' | 'linux';
  secrets: SecretStore;
  service: ServiceManager;
  /** OS-specific doctor checks, printed after the common ones (where Peekaboo/pmset used to be). */
  doctorChecks(): DoctorCheck[];
  /** Run a command line through the user's login shell. */
  shellExec(command: string, opts?: { timeout?: number }): Promise<{ stdout: string; stderr: string }>;
  /** PATH given to the background service. */
  servicePath(): string;
  /** Candidate `tailscale` binaries, tried in order. */
  tailscaleBins: string[];
  /** false for VPN/tunnel interfaces that must not be offered as LAN pairing addresses. */
  isLanInterface(name: string): boolean;
  /** Open a file with the desktop's default viewer (best effort). */
  openFile(path: string): void;
  /** Say `text` out loud on this computer in `language` (BCP-47) with the OS voice; resolves when done. Throws if nothing can speak. */
  speak(text: string, language: string): Promise<void>;
  /** OS-specific security patterns used by the brain's tool guard. */
  security: {
    protectedPaths: RegExp[];
    /** Alternatives joined into one case-insensitive DESTRUCTIVE regex. */
    destructive: string[];
    /** Linux only: why a Bash command that drives the keyboard or clipboard is blocked, or undefined (see blockedInput). */
    inputGuard?: (command: string) => string | undefined;
  };
  /** How a computer task operates this machine. `useChrome` = the hub passes --chrome to the agent. */
  computerUse(o: { useChrome: boolean }): Promise<ComputerUsePlan>;
  words: MachineWords;
  /** Diagnostics returned by the hub's /control/permissions endpoint. */
  diagnostics(): Promise<Record<string, string>>;
}

/** Thrown by SecretStore.set when the OS secret store is unavailable; the message tells the user what to do. */
export class SecretStoreError extends Error {}
