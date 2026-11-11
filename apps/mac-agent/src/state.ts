import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { CallInfo, DoneAlertTarget, PendingCard, RingTarget, SessionCard, SessionState, Snapshot, Risk } from '@callmeclaude/protocol';
import { STATE_PATH, writeAtomic, type Mode } from './config.ts';
import { log, plainText } from './util.ts';

export const HUB_VERSION = '0.1.0';

export interface Subagent {
  id: string;
  type: string;
  state: 'running' | 'done';
  summary?: string;
  transcriptPath?: string;
  startedAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  project: string;
  cwd: string;
  state: SessionState;
  summary: string;
  lastMessage: string;
  lastPrompt: string;
  transcriptPath: string;
  tmuxPane?: string;
  startedAt: string;
  updatedAt: string;
  lastToolAt?: string;
  /** When the current turn began (the last prompt, or the last Stop for a continued session): its length decides the spoken alert. */
  turnAt?: string;
  openTool?: string;
  /** Running as a headless `claude -p` the hub started (fork, resume or voice start): there is no window. */
  background?: boolean;
  subagents?: Subagent[];
}

export interface Pending {
  id: string;
  sessionId: string;
  project: string;
  kind: 'permission' | 'stop';
  summary: string;
  detail: string;
  risk: Risk;
  createdAt: string;
  deadline: string;
  status: 'open' | 'resolved' | 'expired';
  toolName?: string;
  toolInput?: unknown;
  announced?: boolean;
}

/** An HTTP hook request we are holding open, waiting for the developer. */
export interface Hold {
  pendingId: string;
  sessionId: string;
  kind: 'permission' | 'stop';
  respond: (body: object) => void;
  timer: NodeJS.Timeout;
}

const nameCache = new Map<string, string>();

/** Finished subagents stay visible for a while; long sessions don't accumulate them forever. */
const SUBAGENT_TTL_MS = 60 * 60e3;
const MAX_SUBAGENTS = 20;
const MAX_SUBAGENTS_IN_CARD = 8;

/** Project name = the git repository root's folder name (so sub-folders map to their project). */
export function projectName(cwd: string) {
  if (!cwd) return '?';
  const hit = nameCache.get(cwd);
  if (hit) return hit;
  let dir = cwd;
  let name = basename(cwd) || cwd;
  for (let i = 0; i < 12 && dir && dir !== '/'; i++) {
    if (existsSync(join(dir, '.git'))) {
      name = basename(dir);
      break;
    }
    dir = dirname(dir);
  }
  nameCache.set(cwd, name);
  return name;
}

export class State extends EventEmitter {
  sessions = new Map<string, Session>();
  pending = new Map<string, Pending>();
  holds = new Map<string, Hold>(); // by pendingId
  /** Instructions waiting for a session's next hook event. */
  queued = new Map<string, string[]>();
  /**
   * "Call me when it's done" requests: key = session id, or "dir:<path>" for a session that was just
   * started and has no id yet. Value = expiry (ms). These ring even in desk mode.
   */
  callbacks = new Map<string, number>();
  mode: Mode;
  language = 'en-US';
  paused = false;
  ringTarget: RingTarget = 'phone';
  doneAlert: DoneAlertTarget = 'off';
  /** The call ringing or in progress (set by Calls / VoiceManager). */
  call?: CallInfo;
  private saveTimer?: NodeJS.Timeout;

  constructor(mode: Mode) {
    super();
    this.mode = mode;
    this.load();
  }

  private load() {
    if (!existsSync(STATE_PATH)) return;
    try {
      const raw = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
      for (const s of raw.sessions ?? []) this.sessions.set(s.id, { ...s, project: projectName(s.cwd) });
      for (const [k, v] of Object.entries(raw.queued ?? {})) this.queued.set(k, v as string[]);
      this.paused = !!raw.paused;
      for (const [k, v] of Object.entries(raw.callbacks ?? {})) if ((v as number) > Date.now()) this.callbacks.set(k, v as number);
      // Holds die with the process; their pendings are no longer answerable via hook.
      for (const p of raw.pending ?? []) if (p.status === 'open') this.pending.set(p.id, { ...p, status: 'expired' });
    } catch (e) {
      log.warn('state load failed', e);
    }
  }

  changed() {
    this.emit('changed');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 500);
  }

  save() {
    const week = Date.now() - 7 * 864e5;
    const sessions = [...this.sessions.values()].filter((s) => Date.parse(s.updatedAt) > week);
    const pending = [...this.pending.values()].filter((p) => Date.parse(p.createdAt) > Date.now() - 864e5);
    writeAtomic(
      STATE_PATH,
      JSON.stringify({ sessions, pending, queued: Object.fromEntries(this.queued), callbacks: Object.fromEntries(this.callbacks), paused: this.paused }, null, 1),
    );
  }

  upsertSession(id: string, cwd: string, patch: Partial<Session> = {}): Session {
    const now = new Date().toISOString();
    let s = this.sessions.get(id);
    if (!s) {
      s = {
        id,
        cwd,
        project: projectName(cwd),
        state: 'running',
        summary: 'New session started.',
        lastMessage: '',
        lastPrompt: '',
        transcriptPath: '',
        startedAt: now,
        updatedAt: now,
      };
      this.sessions.set(id, s);
      // Claude Code does not deliver SessionStart over HTTP hooks, so a session is "new" on its first hook.
      this.bindCallback(s);
    }
    Object.assign(s, patch, { updatedAt: now });
    if (cwd && !s.cwd) {
      s.cwd = cwd;
      s.project = projectName(cwd);
    }
    this.changed();
    return s;
  }

  /** Track a subagent Claude spawned inside a session. */
  upsertSubagent(sessionId: string, cwd: string, id: string, patch: Partial<Subagent> = {}): Session {
    const now = new Date().toISOString();
    const s = this.upsertSession(sessionId, cwd);
    let a = s.subagents?.find((x) => x.id === id);
    if (!a) {
      a = { id, type: patch.type || 'agent', state: 'running', startedAt: now, updatedAt: now };
      (s.subagents ??= []).push(a);
    }
    Object.assign(a, patch, { updatedAt: now });
    if (!a.type) a.type = 'agent';
    if (s.subagents) {
      s.subagents.sort((x, y) => (x.state === y.state ? y.updatedAt.localeCompare(x.updatedAt) : x.state === 'running' ? -1 : 1));
      s.subagents = s.subagents
        .filter((x) => x.state === 'running' || Date.parse(x.updatedAt) > Date.now() - SUBAGENT_TTL_MS)
        .slice(0, MAX_SUBAGENTS);
    }
    this.changed();
    return s;
  }

  /** A closing session takes its running subagents with it. */
  endSubagents(s: Session) {
    let touched = false;
    for (const a of s.subagents ?? []) {
      if (a.state === 'running') {
        a.state = 'done';
        a.updatedAt = new Date().toISOString();
        touched = true;
      }
    }
    if (touched) this.changed();
  }

  /** Remember that the developer wants a call when this session (or the next session in `dir`) stops. */
  addCallback(key: { sessionId?: string; dir?: string }, hours = 12) {
    const k = key.sessionId ?? `dir:${key.dir}`;
    this.callbacks.set(k, Date.now() + hours * 3600e3);
    this.changed();
  }

  private prune() {
    const now = Date.now();
    for (const [k, exp] of this.callbacks) if (exp < now) this.callbacks.delete(k);
  }

  hasCallback(s: Session): boolean {
    this.prune();
    return this.callbacks.has(s.id);
  }

  /**
   * A session started by phone has no id until its SessionStart hook. Bind the folder's callback to the
   * first NEW session that opens in that folder (existing sessions there are not affected).
   */
  bindCallback(s: Session) {
    this.prune();
    for (const [k, exp] of this.callbacks) {
      if (!k.startsWith('dir:')) continue;
      const d = k.slice(4);
      if (s.cwd === d || s.cwd.startsWith(d + '/')) {
        this.callbacks.set(s.id, exp);
        this.callbacks.delete(k);
        this.changed();
        return;
      }
    }
  }

  consumeCallback(s: Session): boolean {
    if (!this.hasCallback(s)) return false;
    this.callbacks.delete(s.id);
    this.changed();
    return true;
  }

  activeSessions() {
    return [...this.sessions.values()]
      .filter((s) => s.state !== 'ended')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  openPending() {
    return [...this.pending.values()]
      .filter((p) => p.status === 'open')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  holdForSession(sessionId: string): Hold | undefined {
    for (const h of this.holds.values()) if (h.sessionId === sessionId) return h;
  }

  /** Fuzzy lookup by project name, session id prefix or cwd fragment. */
  findSession(q: string): Session | undefined {
    const n = norm(q);
    const list = this.activeSessions();
    return (
      list.find((s) => s.id === q || s.id.startsWith(q)) ??
      list.find((s) => norm(s.project) === n) ??
      list.find((s) => norm(s.project).includes(n) || n.includes(norm(s.project))) ??
      list.find((s) => norm(s.cwd).includes(n))
    );
  }

  snapshot(): Snapshot {
    return {
      mode: this.mode,
      language: this.language,
      paused: this.paused,
      ringTarget: this.ringTarget,
      doneAlert: this.doneAlert,
      ...(this.call ? { call: this.call } : {}),
      hubVersion: HUB_VERSION,
      sessions: this.activeSessions().map(toCard(this)),
      pending: this.openPending().map(
        (p): PendingCard => ({
          id: p.id,
          sessionId: p.sessionId,
          project: p.project,
          kind: p.kind,
          summary: plainText(p.summary),
          risk: p.risk,
          createdAt: p.createdAt,
          deadline: p.deadline,
          ...(this.sessions.get(p.sessionId)?.background ? { background: true } : {}),
        }),
      ),
    };
  }
}

const toCard =
  (st: State) =>
  (s: Session): SessionCard => {
    const c: SessionCard['controllable'] = [];
    if (st.holdForSession(s.id)) c.push('hold');
    if (s.tmuxPane) c.push('tmux');
    c.push('queue');
    const subagents = s.subagents
      ?.filter((a) => a.state === 'running' || Date.parse(a.updatedAt) > Date.now() - SUBAGENT_TTL_MS)
      .slice(0, MAX_SUBAGENTS_IN_CARD)
      .map((a) => ({ id: a.id, type: a.type, state: a.state, ...(a.summary ? { summary: a.summary } : {}) }));
    return {
      id: s.id,
      project: s.project,
      cwd: s.cwd,
      state: s.state,
      summary: plainText(s.summary),
      updatedAt: s.updatedAt,
      controllable: c,
      ...(s.background ? { background: true } : {}),
      ...(subagents?.length ? { subagents } : {}),
    };
  };

export function norm(s: string) {
  return s
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i')
    .replace(/[^a-z0-9]/g, '');
}
