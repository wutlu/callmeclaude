import { Behavior, type FunctionDeclaration } from '@google/genai';
import type { Hub } from '../hub.ts';
import { askBrain, computerTask } from '../brain.ts';
import { briefing } from './prompt.ts';
import { audit, clip, redact } from '../util.ts';
import { saveConfig, voiceSessionMode, type Mode } from '../config.ts';
import { platform, type Platform } from '../platform/index.ts';

const str = (description: string) => ({ type: 'string', description });
const bool = (description: string) => ({ type: 'boolean', description });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });

const CONFIRMED = bool('Did the developer EXPLICITLY confirm this action by voice? false if not.');
const CALL_BACK = bool(
  'Call the developer back when this work finishes or gets stuck, even in desk mode. Default true for work given by phone; false only if the developer says not to call.',
);

/** Long-running tools run asynchronously; the model keeps talking and the result arrives later. */
export const LONG_TOOLS = new Set(['computer_task', 'ask_brain']);

/** Tool declarations for the voice model; only the computer's name depends on the platform. */
export const declarationsFor = (p: Pick<Platform, 'words'>): FunctionDeclaration[] => [
  { name: 'get_overview', description: 'Short, current summary of all Claude Code sessions and pending decisions.', parametersJsonSchema: obj({}) },
  { name: 'get_session', description: "One session's details and its last message.", parametersJsonSchema: obj({ project: str('Project name (approximate is fine)') }, ['project']) },
  {
    name: 'reply_to_session',
    description: "Pass the developer's instruction to a session (continue, do this, approved: submit it, etc.). Also resolves its pending question.",
    parametersJsonSchema: obj(
      { project: str('Project name'), instruction: str("Clear instruction for the session, capturing the developer's intent"), call_back: CALL_BACK, confirmed: CONFIRMED },
      ['project', 'instruction'],
    ),
  },
  {
    name: 'answer_permission',
    description: "Answer a session's permission request (run a command, edit a file, etc.).",
    parametersJsonSchema: obj(
      { project: str('Project name'), approve: bool('true = allow, false = deny'), note: str('Optional note for the agent when denying'), confirmed: CONFIRMED },
      ['project', 'approve'],
    ),
  },
  { name: 'release_session', description: 'Release a waiting session with no new instruction; it stops normally.', parametersJsonSchema: obj({ project: str('Project name') }, ['project']) },
  {
    name: 'start_session',
    description:
      'Start a NEW Claude Code session in a project folder. Only when no session is open for that project, or the developer explicitly asks for a new/separate session.',
    parametersJsonSchema: obj(
      {
        project: str('Project / folder name'),
        task: str('Clear task description'),
        call_back: CALL_BACK,
        new_session: bool('true only if the developer explicitly asked for a NEW session although one is already open'),
        confirmed: CONFIRMED,
      },
      ['project', 'task'],
    ),
  },
  {
    name: 'call_me_when_done',
    description: "Call the developer when a session finishes or gets stuck (\"call me when it's done\"). Works in every mode.",
    parametersJsonSchema: obj({ project: str('Project name') }, ['project']),
  },
  {
    name: 'computer_task',
    description: `Let the hub itself operate ${p.words.the}: click in the browser, submit a form, use an app. Can take a while; the result arrives later.`,
    parametersJsonSchema: obj(
      {
        task: str('Precise description of the computer part only'),
        goal: str("The developer's WHOLE request, including the steps after this computer part (e.g. then start a session in folder X and do what the message asks)"),
        project: str('Related project (optional)'),
        confirmed: CONFIRMED,
      },
      ['task', 'goal'],
    ),
    behavior: Behavior.NON_BLOCKING,
  },
  {
    name: 'ask_brain',
    description: 'Answer a question by reading session transcripts and projects (what a session did, what the error was, which files changed). Can take a while.',
    parametersJsonSchema: obj({ question: str('The question') }, ['question']),
    behavior: Behavior.NON_BLOCKING,
  },
  {
    name: 'stop',
    description:
      'Interrupt a session that is doing something wrong. target="all" is the emergency PANIC: it stops every session and pauses the hub. Never use it to end a call or a conversation.',
    parametersJsonSchema: obj(
      { target: str('Project name, or "all" only for an explicit "stop everything" emergency'), confirmed: bool('For "all": the developer explicitly asked to stop EVERYTHING') },
      ['target'],
    ),
  },
  { name: 'resume_hub', description: 'Re-enable automatic actions after a panic/pause.', parametersJsonSchema: obj({ confirmed: CONFIRMED }) },
  {
    name: 'set_mode',
    description: "Change when the hub may call: desk (I'm at the computer, no calls), away, ride (riding, extra short), sleep (emergencies only).",
    parametersJsonSchema: obj({ mode: { type: 'string', enum: ['desk', 'away', 'ride', 'sleep'] } }, ['mode']),
  },
  {
    name: 'set_language',
    description: 'Change the language you speak and write summaries in, from the next call on. Use a BCP-47 code such as en-US, tr-TR, de-DE, es-ES.',
    parametersJsonSchema: obj({ language: str('BCP-47 language code') }, ['language']),
  },
  {
    name: 'auto_approve',
    description: 'From now on, approve a specific permission in a project without asking (e.g. "npm test", "Edit").',
    parametersJsonSchema: obj({ project: str('Project name'), rule: str('Command prefix (e.g. "npm test") or tool name (e.g. "Edit")'), confirmed: CONFIRMED }, ['project', 'rule']),
  },
  { name: 'end_call', description: 'Hang up after saying goodbye.', parametersJsonSchema: obj({}) },
];

export const declarations = declarationsFor(platform);

/**
 * start_session's reply. tmux mode keeps the `tmux` field (the session's tmux name) exactly as before;
 * headless mode returns the Claude Code session id under its own name instead of pretending it is a tmux name.
 */
export function startSessionReply(mode: 'tmux' | 'headless', dir: string, started: string, callBack = true) {
  const say = callBack ? "Session started. I'll call when it's done or stuck." : 'Session started.';
  return mode === 'headless' ? { ok: true, dir, mode: 'headless', session_id: started, say } : { ok: true, dir, tmux: started, say };
}

const HIGH_RISK =
  /(deploy|publish|push|pay|payment|purchase|buy|delete|drop|remove|send .*(mail|email|message)|production|prod\b|yayınla|ödeme|öde|satın|sil|gönder.*(mail|e-posta|mesaj))/i;
/** After handing off work with a call-back, the call has done its job: wrap up instead of lingering. */
const WRAP_UP = {
  next: 'If nothing else is open, say in one short sentence that you will call back when it is done, say goodbye and call end_call in the same turn.',
};
/** Tools that change something: refused while the phone is on its lock screen (anyone holding it could talk). */
const NEEDS_UNLOCK = new Set(['reply_to_session', 'answer_permission', 'start_session', 'computer_task', 'auto_approve', 'resume_hub', 'release_session']);
const LOCKED = {
  error: 'phone_locked',
  say: 'The phone is locked. Ask the developer to unlock it (Face ID / PIN) and then say it again; nothing was done.',
};

/** Read-only and safety tools still work on the lock screen; denying a permission is always allowed. */
export function needsUnlock(name: string, args: any) {
  if (name === 'answer_permission') return !!args?.approve;
  return NEEDS_UNLOCK.has(name);
}

const needConfirm = (what: string) => ({ needs_confirmation: true, say: `Ask the developer for explicit confirmation first: ${what}` });

export async function runTool(hub: Hub, name: string, args: any, ctx: { endCall: () => void; locked?: () => boolean }): Promise<Record<string, unknown>> {
  audit('voice.tool', { name, args });
  if (ctx.locked?.() && needsUnlock(name, args)) {
    audit('voice.tool.locked', { name });
    return LOCKED;
  }
  const find = (p: string) => hub.st.findSession(p);
  const projects = () => hub.st.activeSessions().map((x) => x.project);
  switch (name) {
    case 'get_overview':
      return { overview: briefing(hub) };
    case 'get_session': {
      const s = find(args.project);
      if (!s) return { error: 'No open session with that name.', sessions: projects() };
      const p = hub.st.openPending().find((x) => x.sessionId === s.id);
      return { project: s.project, state: s.state, summary: s.summary, pending: p?.summary, last_message: redact(clip(s.lastMessage, 700)), last_instruction: clip(s.lastPrompt, 200) };
    }
    case 'reply_to_session': {
      const s = find(args.project);
      if (!s) return { error: 'Session not found.', sessions: projects() };
      const pend = hub.st.openPending().find((x) => x.sessionId === s.id);
      if ((HIGH_RISK.test(args.instruction) || pend?.risk === 'high' || pend?.risk === 'critical') && !args.confirmed) return needConfirm(args.instruction);
      const via = await hub.controller.instruct(s, args.instruction);
      const callBack = args.call_back !== false && via !== 'none';
      // A fork has its own session id; the callback follows the session that does the work.
      if (callBack) hub.st.addCallback({ sessionId: via === 'fork' ? hub.controller.forks.get(s.id) ?? s.id : s.id });
      const msg = {
        hold: 'Instruction delivered; the agent is continuing.',
        tmux: 'Instruction typed into the terminal.',
        resume: 'The session had ended; it was restarted with the instruction.',
        fork: 'The session was idle at the computer, so a background copy of it (same conversation) is doing this now. Its open window on the computer will not show this work.',
        queue: 'The session is busy; the instruction will be delivered at its next step.',
        none: 'Could not deliver the instruction.',
      }[via];
      return { ok: via !== 'none', delivered_via: via, call_back: callBack, say: callBack ? `${msg} I'll call when it's done.` : msg, ...(callBack ? WRAP_UP : {}) };
    }
    case 'answer_permission': {
      const s = find(args.project);
      if (!s) return { error: 'Session not found.' };
      const pend = hub.st.openPending().find((x) => x.sessionId === s.id && x.kind === 'permission');
      if (!pend) return { error: 'This session has no pending permission request.' };
      if (args.approve && (pend.risk === 'high' || pend.risk === 'critical') && !args.confirmed) return needConfirm(pend.summary);
      return { ok: hub.controller.permission(s, !!args.approve, args.note) };
    }
    case 'release_session': {
      const s = find(args.project);
      return { ok: s ? hub.controller.release(s) : false };
    }
    case 'start_session': {
      const dir = hub.controller.findProjectDir(args.project);
      if (!dir) return { error: 'Project folder not found.', roots: hub.cfg.projectRoots };
      const open = hub.st.activeSessions().find((x) => x.cwd === dir || x.cwd.startsWith(dir + '/'));
      if (open && !args.new_session) {
        return {
          error: `A session is already open in ${open.project}. Use reply_to_session to direct it, unless the developer explicitly wants a separate new session.`,
          open_session: open.project,
          state: open.state,
        };
      }
      if (!args.confirmed) return needConfirm(`start a new session in ${args.project}: ${args.task}`);
      const callBack = args.call_back !== false;
      const mode = voiceSessionMode(hub.cfg);
      if (callBack && mode === 'tmux') hub.st.addCallback({ dir });
      const project = dir.split('/').pop();
      const started = await hub.controller.startSession(dir, args.task, (why) =>
        hub.calls.enqueue({ priority: 'P1', title: `${project}: could not start`, text: `[${project}] The new session did not start: ${why}`, requested: callBack }),
      );
      // A headless session's id is known up front; a tmux session is bound by folder on its first hook.
      if (callBack && mode === 'headless') hub.st.addCallback({ sessionId: started });
      return { ...startSessionReply(mode, dir, started, callBack), call_back: callBack, ...(callBack ? WRAP_UP : {}) };
    }
    case 'call_me_when_done': {
      const s = find(args.project);
      if (!s) return { error: 'Session not found.', sessions: projects() };
      hub.st.addCallback({ sessionId: s.id });
      return { ok: true, say: `I'll call when ${s.project} is done or stuck.`, ...WRAP_UP };
    }
    case 'computer_task': {
      if (!args.confirmed) return needConfirm(args.task);
      if (hub.st.paused) return { error: 'The hub is paused (panic). Call resume_hub first.' };
      return { result: await computerTask(hub, args.task, args.project) };
    }
    case 'ask_brain':
      return { answer: await askBrain(hub, args.question) };
    case 'stop': {
      if (String(args.target).toLowerCase() === 'all') {
        if (!args.confirmed) return needConfirm('stop ALL sessions and pause the hub (emergency stop)');
        await hub.controller.panic('voice');
        return { ok: true, say: 'All sessions stopped; automatic actions are paused.' };
      }
      const s = find(args.target);
      if (!s) return { error: 'Session not found.' };
      await hub.controller.interrupt(s);
      return { ok: true };
    }
    case 'resume_hub':
      if (!args.confirmed) return needConfirm('re-enable automatic actions');
      hub.st.paused = false;
      hub.st.changed();
      audit('resume', {});
      return { ok: true };
    case 'set_mode':
      hub.cfg.mode = args.mode as Mode;
      hub.st.mode = hub.cfg.mode;
      saveConfig(hub.cfg);
      hub.st.changed();
      return { ok: true, mode: args.mode };
    case 'set_language': {
      const code = String(args.language ?? '');
      if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(code)) return { error: 'Not a valid BCP-47 language code.' };
      hub.cfg.language = code;
      hub.st.language = code;
      saveConfig(hub.cfg);
      hub.st.changed();
      return { ok: true, language: code, say: 'Language changed; it applies fully from the next call.' };
    }
    case 'auto_approve': {
      if (!args.confirmed) return needConfirm(`stop asking for "${args.rule}" in ${args.project}`);
      const s = find(args.project);
      const project = s?.project ?? args.project;
      const rule = /^(Bash|Edit|Write|MultiEdit|Read|WebFetch|WebSearch|mcp__)/.test(args.rule) ? args.rule : `Bash(${args.rule}`;
      (hub.cfg.autoApprove[project] ??= []).push(rule);
      saveConfig(hub.cfg);
      return { ok: true, project, rule };
    }
    case 'end_call':
      ctx.endCall();
      return { ok: true };
    default:
      return { error: `unknown tool ${name}` };
  }
}
