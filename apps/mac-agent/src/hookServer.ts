import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { BRAIN_DIR } from './config.ts';
import type { Hub } from './hub.ts';
import { classify, quickClassify } from './classifier.ts';
import { criticalReason } from './critical.ts';
import { isReadOnly } from './readOnly.ts';
import type { Pending, Session } from './state.ts';
import { audit, clip, log, shortId } from './util.ts';
import type { Risk } from '@callmeclaude/protocol';

type Json = Record<string, any>;

/** Receives Claude Code HTTP hooks on 127.0.0.1. Never blocks a session unless it is deliberately holding it. */
export function startHookServer(hub: Hub) {
  const { cfg } = hub;
  const server = createServer(async (req, res) => {
    const send = once((body: object) => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    try {
      if (req.method === 'GET' && req.url === '/health') return void send({ ok: true });
      if (req.url?.startsWith('/control/')) {
        if (req.headers.authorization !== `Bearer ${cfg.hookToken}`) return void res.writeHead(401).end();
        const body = req.method === 'POST' ? JSON.parse(await readBody(req)) : {};
        return void send(await control(hub, req.url.slice('/control/'.length), body));
      }
      if (req.method !== 'POST' || !req.url?.startsWith('/hooks/')) return void res.writeHead(404).end();
      if (req.headers.authorization !== `Bearer ${cfg.hookToken}`) return void res.writeHead(401).end();
      const input = JSON.parse(await readBody(req)) as Json;
      if (isInternal(input)) return void send({});
      const event = req.url.slice('/hooks/'.length);
      const rawPane = String(req.headers['x-cmc-tmux-pane'] ?? '').trim();
      const pane = /^%\d+$/.test(rawPane) ? rawPane : undefined;
      await handle(hub, event, input, pane, send, res);
    } catch (e) {
      log.error('hook error', e);
      send({});
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 10_000;
  server.listen(cfg.hookPort, '127.0.0.1', () => log.info(`hook server on 127.0.0.1:${cfg.hookPort}`));
  return server;
}

/** Local control API used by the `cmc` CLI. */
async function control(hub: Hub, cmd: string, body: Json): Promise<object> {
  switch (cmd) {
    case 'status':
      return { snapshot: hub.st.snapshot(), voiceActive: !!hub.voice.active, ringing: !!hub.calls.ringing, queued: hub.calls.openCount() };
    case 'call-me': {
      const r = await hub.calls.ring([{ priority: 'P0', title: body.title ?? 'Claude', text: body.text ?? 'Test call: tell the developer that everything works and give a short status summary.' }], 1);
      return r;
    }
    case 'panic':
      await hub.controller.panic();
      return { ok: true };
    case 'permissions': {
      // OS-specific diagnostics as seen from inside the hub service (launchd / systemd --user context).
      const { platform } = await import('./platform/index.ts');
      return platform.diagnostics();
    }
    case 'do': {
      const { computerTask } = await import('./brain.ts');
      return { result: await computerTask(hub, String(body.task ?? ''), body.project) };
    }
    case 'tell': {
      // Same delivery as the voice tool reply_to_session: hold → tmux → resume → queue / headless fork.
      const s = hub.st.findSession(String(body.project ?? ''));
      const text = String(body.text ?? '').trim();
      if (!s || !text) return { error: s ? 'empty instruction' : 'session not found' };
      return { project: s.project, via: await hub.controller.instruct(s, text) };
    }
    case 'resume':
      hub.st.paused = false;
      hub.st.changed();
      return { ok: true };
    case 'mode':
      hub.setMode(body.mode);
      return { ok: true, mode: body.mode };
    default:
      return { error: 'unknown command' };
  }
}

function isIgnored(paths: string[], cwd: unknown) {
  return typeof cwd === 'string' && paths.some((p) => p && (cwd === p || cwd.startsWith(p.endsWith('/') ? p : p + '/')));
}

function isInternal(input: Json) {
  return typeof input.cwd === 'string' && input.cwd.startsWith(BRAIN_DIR);
}

async function handle(hub: Hub, event: string, input: Json, pane: string | undefined, send: (b: object) => void, res: ServerResponse) {
  const { st } = hub;
  const sid: string = input.session_id;
  const watchOnly = isIgnored(hub.cfg.ignorePaths, input.cwd);
  const base: Partial<Session> = { transcriptPath: input.transcript_path ?? '' };
  if (pane) base.tmuxPane = pane;
  if (input.agent_id) return send({}); // subagent-level events: ignore, the main thread reports

  switch (event) {
    case 'SessionStart': {
      const s = st.upsertSession(sid, input.cwd, { ...base, state: 'running', summary: 'Session opened.' });
      st.bindCallback(s);
      audit('hook', { event, sid, cwd: input.cwd, source: input.source });
      return send({});
    }
    case 'UserPromptSubmit': {
      const s = st.upsertSession(sid, input.cwd, { ...base, state: 'running', lastPrompt: String(input.prompt ?? ''), summary: 'Working.' });
      return send(withQueued(hub, s, 'UserPromptSubmit'));
    }
    case 'PreToolUse':
    case 'PostToolUse': {
      const s = st.upsertSession(sid, input.cwd, {
        ...base,
        state: 'running',
        lastToolAt: new Date().toISOString(),
        openTool: event === 'PreToolUse' ? input.tool_name : undefined,
      });
      if (s.summary === 'Session opened.' || s.summary === 'New session started.') s.summary = 'Working.';
      return send(event === 'PostToolUse' ? withQueued(hub, s, 'PostToolUse') : {});
    }
    case 'Notification': {
      const s = st.upsertSession(sid, input.cwd, base);
      if (input.notification_type === 'idle_prompt' && s.state === 'running') s.state = 'waiting_input';
      return send({});
    }
    case 'SessionEnd': {
      const s = st.upsertSession(sid, input.cwd, { ...base, state: 'ended', summary: 'Session closed.' });
      hub.controller.release(s);
      return send({});
    }
    case 'StopFailure': {
      const s = st.upsertSession(sid, input.cwd, {
        ...base,
        state: 'errored',
        summary: `Error: ${clip(input.error_details ?? input.error?.type ?? input.error ?? 'API error', 100)}`,
      });
      audit('hook', { event, sid, error: input.error });
      if (!watchOnly) hub.calls.enqueue({ priority: 'P1', title: `${s.project}: error`, text: `The ${s.project} session stopped with an API error: ${s.summary}` });
      return send({});
    }
    case 'Stop':
      if (watchOnly) {
        const msg = String(input.last_assistant_message ?? lastAssistantFromTranscript(input.transcript_path) ?? '');
        const c = quickClassify(msg);
        st.upsertSession(sid, input.cwd, { ...base, lastMessage: msg, openTool: undefined, state: c.state, summary: c.summary });
        return send({});
      }
      return onStop(hub, input, base, send, res);
    case 'PermissionRequest':
      if (watchOnly) {
        st.upsertSession(sid, input.cwd, { ...base, state: 'waiting_permission', summary: `Waiting for permission: ${describeTool(input.tool_name, input.tool_input)}` });
        return send({});
      }
      return onPermission(hub, input, base, send, res);
    default:
      return send({});
  }
}

/** Deliver instructions queued while the session was busy, as additional context. */
function withQueued(hub: Hub, s: Session, eventName: string): object {
  const q = hub.st.queued.get(s.id);
  if (!q?.length) return {};
  hub.st.queued.delete(s.id);
  hub.st.changed();
  audit('queue.delivered', { session: s.id, via: eventName, q });
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: `The developer gave these instructions by phone (via CallMeClaude): ${q.join(' / ')}`,
    },
  };
}

async function onStop(hub: Hub, input: Json, base: Partial<Session>, send: (b: object) => void, res: ServerResponse) {
  const { st, cfg } = hub;
  const lastMessage = String(input.last_assistant_message ?? lastAssistantFromTranscript(input.transcript_path) ?? '');
  const s = st.upsertSession(input.session_id, input.cwd, { ...base, lastMessage, openTool: undefined });

  const q = st.queued.get(s.id);
  if (q?.length) {
    st.queued.delete(s.id);
    s.state = 'running';
    st.changed();
    audit('queue.delivered', { session: s.id, via: 'Stop', q });
    s.lastPrompt = `New instruction by phone: ${q.join(' / ')}`;
    return send({ decision: 'block', reason: `The developer said by phone (via CallMeClaude): ${q.join(' / ')}` });
  }

  // "Call me when it's done" overrides desk/sleep mode (but never a panic pause).
  const wanted = !st.paused && st.consumeCallback(s);
  if (wanted) audit('callback.due', { session: s.id, project: s.project });

  if (!wanted && (st.paused || hub.deskQuiet() || cfg.mode === 'sleep')) {
    const c = quickClassify(lastMessage);
    Object.assign(s, { state: c.state, summary: c.summary });
    st.changed();
    if (cfg.mode === 'sleep' || st.paused) return send({});
    return send({});
  }

  const c = await classify({ project: s.project, lastMessage, lastPrompt: s.lastPrompt, model: cfg.claude.classifyModel, language: cfg.language });
  Object.assign(s, { state: c.state, summary: c.summary });
  st.changed();
  audit('stop.classified', { session: s.id, project: s.project, ...c });

  const summary = `${c.summary}${c.ask ? ' ' + c.ask : ''}`;
  const p = hold(hub, s, 'stop', summary, lastMessage, c.risk, send, res);
  hub.calls.enqueue({
    priority: wanted || c.state !== 'done' ? 'P1' : 'P2',
    title: `${s.project}: ${c.state === 'done' ? 'done' : c.state === 'blocked' ? 'blocked' : 'question'}`,
    text: `[${s.project}] ${summary}`,
    pendingId: p.id,
    requested: wanted,
  });
}

async function onPermission(hub: Hub, input: Json, base: Partial<Session>, send: (b: object) => void, res: ServerResponse) {
  const { st, cfg } = hub;
  const s = st.upsertSession(input.session_id, input.cwd, { ...base, state: 'waiting_permission' });
  const desc = describeTool(input.tool_name, input.tool_input);
  s.summary = `Waiting for permission: ${desc}`;
  st.changed();

  const rules = cfg.autoApprove[s.project] ?? [];
  const sig = toolSignature(input.tool_name, input.tool_input);
  // Default: full permission, the developer is only asked for critical actions (money, accounts, sending, wiping).
  const critical = criticalReason(input.tool_name, input.tool_input);
  const why =
    cfg.approvals !== 'ask' && !critical
      ? 'not critical'
      : cfg.autoApproveReadOnly !== false && isReadOnly(input.tool_name, input.tool_input)
        ? 'read-only'
        : rules.some((r) => sig.startsWith(r))
          ? 'rule'
          : undefined;
  if (why) {
    audit('permission.auto', { session: s.id, project: s.project, tool: input.tool_name, why, desc });
    s.state = 'running';
    s.summary = 'Working.';
    st.changed();
    return send({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  }
  // A session the developer asked to hear back from also rings for permissions, even in desk mode.
  if (st.paused || (hub.deskQuiet() && !st.hasCallback(s))) return send({});

  const p = hold(
    hub,
    s,
    'permission',
    `Asks for permission: ${desc}${critical ? ` (${critical})` : ''}`,
    JSON.stringify(input.tool_input ?? {}).slice(0, 2000),
    critical ? 'critical' : riskOf(sig),
    send,
    res,
  );
  p.toolName = input.tool_name;
  p.toolInput = input.tool_input;
  hub.calls.enqueue({ priority: 'P1', title: `${s.project}: permission`, text: `[${s.project}] Asks for permission: ${desc}`, pendingId: p.id, requested: st.hasCallback(s) });
}

function hold(hub: Hub, s: Session, kind: 'stop' | 'permission', summary: string, detail: string, risk: Risk, send: (b: object) => void, res: ServerResponse): Pending {
  const { st, cfg } = hub;
  // A session can only be in one hold at a time.
  const prev = st.holdForSession(s.id);
  if (prev) hub.controller.release(s);
  const now = Date.now();
  const p: Pending = {
    id: shortId('p_'),
    sessionId: s.id,
    project: s.project,
    kind,
    summary,
    detail,
    risk,
    createdAt: new Date(now).toISOString(),
    deadline: new Date(now + cfg.holdSeconds * 1000).toISOString(),
    status: 'open',
  };
  st.pending.set(p.id, p);
  const timer = setTimeout(() => {
    st.holds.delete(p.id);
    if (p.status === 'open') p.status = 'expired';
    audit('pending.expired', { pendingId: p.id, project: p.project });
    send({});
    st.changed();
  }, cfg.holdSeconds * 1000);
  st.holds.set(p.id, { pendingId: p.id, sessionId: s.id, kind, respond: send, timer });
  // The developer may answer at the keyboard (Esc) → Claude Code drops the connection.
  res.on('close', () => {
    if (!res.writableEnded && st.holds.has(p.id)) {
      clearTimeout(timer);
      st.holds.delete(p.id);
      p.status = 'resolved';
      audit('pending.local', { pendingId: p.id });
      st.changed();
    }
  });
  audit('pending.new', { pendingId: p.id, project: s.project, kind, summary, risk });
  st.changed();
  return p;
}

export function describeTool(name: string, input: any): string {
  if (!input) return name;
  switch (name) {
    case 'Bash':
      return `run a command: ${clip(input.description || input.command, 90)}`;
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `edit ${basename(String(input.file_path ?? input.notebook_path ?? 'a file'))}`;
    case 'WebFetch':
      try {
        return `read ${new URL(input.url).hostname}`;
      } catch {
        return 'read a web page';
      }
    default:
      return name.startsWith('mcp__') ? `use the ${name.split('__').slice(1).join(' ')} tool` : `use the ${name} tool`;
  }
}

export function toolSignature(name: string, input: any) {
  return name === 'Bash' ? `Bash(${String(input?.command ?? '')}` : name;
}

function riskOf(sig: string): Risk {
  if (/rm -rf|drop (table|database)|mkfs|--force|reset --hard/i.test(sig)) return 'critical';
  if (/git push|deploy|publish|vercel|npm publish|kubectl|terraform apply|curl .*-X (POST|DELETE)/i.test(sig)) return 'high';
  if (/^Bash\(/.test(sig)) return 'medium';
  return 'low';
}

function lastAssistantFromTranscript(path?: string): string | undefined {
  if (!path || !existsSync(path)) return;
  try {
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n').slice(-60).reverse();
    for (const l of lines) {
      const j = JSON.parse(l);
      if (j.type === 'assistant') {
        const t = (j.message?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
        if (t) return t;
      }
    }
  } catch {}
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let d = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (d += c));
    req.on('end', () => resolve(d || '{}'));
    req.on('error', reject);
  });
}

function once<T extends (...a: any[]) => void>(f: T): T {
  let done = false;
  return ((...a: any[]) => {
    if (done) return;
    done = true;
    f(...a);
  }) as T;
}
