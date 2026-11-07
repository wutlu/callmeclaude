import type { Risk, SessionState } from '@callmeclaude/protocol';
import { oneShot, parseJsonLoose } from './claude.ts';
import { clip, languageName, log, plainText } from './util.ts';

export interface Classification {
  state: Extract<SessionState, 'done' | 'waiting_input' | 'blocked' | 'errored'>;
  reason: 'done' | 'question' | 'needs_approval' | 'missing_credential' | 'captcha' | '2fa' | 'tool_refused' | 'error';
  /** <= ~15 words, spoken on the phone. */
  summary: string;
  risk: Risk;
  /** What the developer is being asked, phrased for voice. */
  ask?: string;
}

const BLOCKED = [
  /\b(i can(?:'|no)t|i'?m (?:not able|unable)|unable to|i won'?t be able|cannot (?:submit|click|complete|proceed))\b/i,
  /\b(you(?:'ll)? need to|please (?:confirm|approve|log ?in|sign ?in|enter)|requires? (?:your|manual|human))\b/i,
  /\b(captcha|2fa|two-factor|verification code|one-time code|otp)\b/i,
  /(yapamam|yapamıyorum|gönderemem|gönderemiyorum|tıklayamam|onayın(?:ı|iz)? (?:gerek|lazım|bekli)|giriş yapman|doğrulama kodu)/i,
];
const QUESTION = [/\?\s*$/m, /\b(should i|do you want|would you like|shall i|which (?:one|option))\b/i, /(ister misin|devam edeyim mi|hangisi|onaylıyor musun)/i];

export function quickClassify(msg: string): Classification {
  const m = msg || '';
  if (BLOCKED.some((r) => r.test(m))) {
    const reason = /captcha/i.test(m) ? 'captcha' : /2fa|two-factor|verification|otp|doğrulama/i.test(m) ? '2fa' : 'needs_approval';
    return { state: 'blocked', reason, summary: clip(plainText(m), 140), risk: 'medium' };
  }
  if (QUESTION.some((r) => r.test(m.slice(-400)))) return { state: 'waiting_input', reason: 'question', summary: clip(plainText(m), 140), risk: 'low' };
  return { state: 'done', reason: 'done', summary: clip(plainText(m), 140), risk: 'low' };
}

const SYSTEM = `You triage Claude Code sessions for a developer who is away from the computer and will hear your summary over a phone call.
Return ONLY a JSON object:
{"state":"done|waiting_input|blocked|errored","reason":"done|question|needs_approval|missing_credential|captcha|2fa|tool_refused|error","summary":"...","ask":"...","risk":"low|medium|high|critical"}
- state=blocked: the agent cannot or will not continue without a human action/approval (e.g. "I can't submit this form", needs login, CAPTCHA, 2FA, refused tool).
- state=waiting_input: the agent asks a question or offers options.
- state=done: it finished and reports results (may suggest next steps).
- summary: max 15 words, in LANG, conversational, no file paths/URLs/code, numbers rounded. Start with what happened.
- ask: one short question to ask the developer in LANG (e.g. "Should I submit it?", "Shall we continue?"). For done, propose the obvious next step.
- risk: risk of the action awaiting approval (payments, deploys, deleting, sending messages externally => high).`;

export async function classify(opts: {
  project: string;
  lastMessage: string;
  lastPrompt: string;
  model: string;
  language: string;
}): Promise<Classification> {
  const quick = quickClassify(opts.lastMessage);
  if (process.env.CMC_CLASSIFY_OFFLINE) return quick;
  try {
    const out = await oneShot(
      `Project: ${opts.project}\nDeveloper's last instruction: ${clip(opts.lastPrompt, 600)}\n\nAgent's final message:\n${clip(opts.lastMessage, 3000)}`,
      { model: opts.model, system: SYSTEM.replaceAll('LANG', languageName(opts.language)), timeoutMs: 30_000 },
    );
    const j = parseJsonLoose<Classification>(out);
    if (j?.state && j.summary) return { ...quick, ...j };
  } catch (e) {
    log.warn('classify failed, using regex result', (e as Error).message);
  }
  return quick;
}
