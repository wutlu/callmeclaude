// Spoken "task complete" alerts: when a Claude Code session finishes a turn, say "<project>: task complete."
// in the configured language, out loud on this computer (the OS voice) or on the phone (the app's own voice).
import type { DoneAlertTarget } from '@callmeclaude/protocol';
import type { Hub } from './hub.ts';
import { platform, type Platform } from './platform/index.ts';
import type { Session } from './state.ts';
import { audit, log } from './util.ts';

/** "{p}" = the project name. Keyed by the language part of the BCP-47 code; unknown languages use English. */
const DONE_TEXTS: Record<string, string> = {
  en: '{p}: task complete.',
  tr: '{p} projesi görevi tamamlandı.',
  de: '{p}: Aufgabe erledigt.',
  fr: '{p} : tâche terminée.',
  es: '{p}: tarea completada.',
  it: '{p}: attività completata.',
  pt: '{p}: tarefa concluída.',
  nl: '{p}: taak voltooid.',
  pl: '{p}: zadanie ukończone.',
  ru: '{p}: задача выполнена.',
  ar: '{p}: اكتملت المهمة.',
  hi: '{p}: काम पूरा हो गया।',
  ja: '{p}のタスクが完了しました。',
  ko: '{p} 작업이 완료되었습니다.',
  zh: '{p} 的任务已完成。',
};

/** Folder names read better as words: "claude-alert" → "claude alert", "runime.com" → "runime com". */
export function speakableProject(name: string): string {
  return name.replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Claude';
}

export function doneText(project: string, language: string): string {
  const t = DONE_TEXTS[language.split('-')[0].toLowerCase()] ?? DONE_TEXTS.en;
  return t.replace('{p}', speakableProject(project));
}

/**
 * Should a finished turn be announced? (pure, for tests) Not when alerts are off, in sleep mode, during a call
 * on the device that would speak, or for a short turn: the developer was probably still watching it.
 * A turn with no known start (the hub restarted mid-turn) counts as long.
 */
export function shouldAnnounce(o: {
  target: DoneAlertTarget;
  mode: string;
  callOn?: 'phone' | 'desktop';
  turnAt?: string;
  now: number;
  minSeconds: number;
}): boolean {
  if (o.target === 'off' || o.mode === 'sleep') return false;
  if (o.callOn && (o.target === 'phone') === (o.callOn === 'phone')) return false;
  const started = o.turnAt ? Date.parse(o.turnAt) : NaN;
  return !(isFinite(started) && o.now - started < o.minSeconds * 1000);
}

export class Announcer {
  /** One announcement at a time on this computer: sessions that finish together are read one after another. */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private hub: Hub,
    private os: Pick<Platform, 'speak'> = platform,
  ) {}

  /** A session finished its turn (Stop hook). */
  done(s: Session) {
    const { cfg, st } = this.hub;
    const target = cfg.doneAlert.target;
    const now = Date.now();
    const go = shouldAnnounce({ target, mode: cfg.mode, callOn: st.call?.on, turnAt: s.turnAt, now, minSeconds: cfg.doneAlert.minSeconds });
    // A held Stop the developer answers continues without a new prompt: time that next turn from here.
    s.turnAt = new Date(now).toISOString();
    if (!go) return;
    this.say(doneText(s.project, cfg.language), target, s.project);
  }

  /** Say it now on `target` (also a sample when the setting changes, so the developer hears where it goes). */
  say(text: string, target: DoneAlertTarget, project = '') {
    const language = this.hub.cfg.language;
    if (target === 'phone') {
      const ok = this.hub.app.broadcast({ type: 'announce', text, language }, 'phone');
      audit('announce', { project, target, delivered: ok });
      if (!ok) log.info('announce: no phone app connected', project);
      return;
    }
    if (target !== 'computer') return;
    audit('announce', { project, target });
    this.chain = this.chain.then(() =>
      this.os.speak(text, language).catch((e) => {
        log.warn('announce: could not speak', (e as Error).message);
        audit('announce.failed', { project, error: (e as Error).message });
      }),
    );
  }
}
