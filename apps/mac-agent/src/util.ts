import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AUDIT_DIR, LOG_DIR } from './config.ts';

export const execFileP = promisify(execFile);

const day = () => new Date().toISOString().slice(0, 10);

export const log = {
  info: (...a: unknown[]) => write('INFO', a),
  warn: (...a: unknown[]) => write('WARN', a),
  error: (...a: unknown[]) => write('ERROR', a),
  debug: (...a: unknown[]) => process.env.CMC_DEBUG && write('DEBUG', a),
};

function write(level: string, a: unknown[]) {
  const line = `${new Date().toISOString()} ${level} ${a
    .map((x) => (typeof x === 'string' ? x : x instanceof Error ? x.stack ?? x.message : JSON.stringify(x)))
    .join(' ')}`;
  console.log(line);
  try {
    appendFileSync(join(LOG_DIR, `hub-${day()}.log`), line + '\n');
  } catch {}
}

/** Append-only audit trail of everything the hub decides or does. */
export function audit(kind: string, data: Record<string, unknown>) {
  try {
    appendFileSync(
      join(AUDIT_DIR, `${day()}.jsonl`),
      JSON.stringify({ ts: new Date().toISOString(), kind, ...data }) + '\n',
      { mode: 0o600 },
    );
  } catch (e) {
    log.warn('audit write failed', e);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function shortId(prefix = '') {
  return prefix + Math.random().toString(36).slice(2, 8);
}

/** Collapse whitespace and clip, for phone-friendly snippets. */
export function clip(s: string | undefined, n = 400) {
  if (!s) return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** "tr-TR" → "Turkish", "pt-BR" → "Portuguese (Brazil)"; falls back to the code itself. */
export function languageName(code: string) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Redact obvious secrets before text leaves the machine (e.g. to a voice provider). */
export function redact(s: string) {
  return s
    .replace(/sk-[A-Za-z0-9_\-]{16,}/g, '[redacted]')
    .replace(/AIza[0-9A-Za-z_\-]{30,}/g, '[redacted]')
    .replace(/gh[pousr]_[A-Za-z0-9]{30,}/g, '[redacted]')
    .replace(/xox[abpr]-[A-Za-z0-9-]{10,}/g, '[redacted]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted key]')
    .replace(/eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}/g, '[redacted token]');
}

/** Markdown out, plain words in: for summaries shown on cards and read aloud ("**done**, see `a.ts`" → "done, see a.ts"). */
export function plainText(s: string | undefined) {
  if (!s) return '';
  return s
    .replace(/```[a-z0-9_-]*\s*/gi, '') // code fences (keep what is inside)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links and images → their text
    .replace(/(\*\*|__)(.+?)\1/g, '$2') // bold
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2') // italic
    .replace(/`([^`]*)`/g, '$1') // inline code
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(?=\S)|\d+[.)]\s+(?=\S))/gm, '') // headings, quotes, list markers
    .replace(/([:.;!?])\s+[-*+]\s+(?=\S)/g, '$1 ') // a list flattened onto one line ("Done: - a")
    .replace(/\*\*+|`+/g, '') // stray markers (a clipped "**…")
    .replace(/\s+/g, ' ')
    .trim();
}
