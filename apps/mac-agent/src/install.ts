import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Config } from './config.ts';
import { writeAtomic } from './config.ts';
import { platform } from './platform/index.ts';

export const CLAUDE_SETTINGS = join(homedir(), '.claude', 'settings.json');

const EVENTS: Array<[string, 'short' | 'hold' | 'tool']> = [
  ['SessionStart', 'short'],
  ['SessionEnd', 'short'],
  ['UserPromptSubmit', 'short'],
  ['Notification', 'short'],
  ['SubagentStart', 'short'],
  ['SubagentStop', 'short'],
  ['PreToolUse', 'tool'],
  ['PostToolUse', 'tool'],
  ['StopFailure', 'short'],
  ['Stop', 'hold'],
  ['PermissionRequest', 'hold'],
];

const isOurs = (h: any) => typeof h?.url === 'string' && /127\.0\.0\.1:\d+\/hooks\//.test(h.url) && h?.headers?.['X-CMC'] === '1';

/** Merge our HTTP hooks into ~/.claude/settings.json (backup first, keep everything else). */
export function installHooks(cfg: Config) {
  mkdirSync(dirname(CLAUDE_SETTINGS), { recursive: true });
  let settings: any = {};
  if (existsSync(CLAUDE_SETTINGS)) {
    const raw = readFileSync(CLAUDE_SETTINGS, 'utf8');
    settings = raw.trim() ? JSON.parse(raw) : {};
    copyFileSync(CLAUDE_SETTINGS, `${CLAUDE_SETTINGS}.cmc-backup-${Date.now()}`);
  }
  removeOurHooks(settings);
  settings.hooks ??= {};
  for (const [event, kind] of EVENTS) {
    const timeout = kind === 'hold' ? cfg.holdSeconds + 60 : kind === 'tool' ? 3 : 5;
    const hook = {
      type: 'http',
      url: `http://127.0.0.1:${cfg.hookPort}/hooks/${event}`,
      timeout,
      headers: { Authorization: `Bearer ${cfg.hookToken}`, 'X-CMC': '1', 'X-CMC-Tmux-Pane': '$TMUX_PANE' },
      allowedEnvVars: ['TMUX_PANE'],
    };
    (settings.hooks[event] ??= []).push({ hooks: [hook] });
  }
  applySessionPermissions(settings, cfg);
  writeAtomic(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + '\n');
}

/**
 * With sessionPermissions 'bypass' (the default), every Claude Code session starts like
 * `claude --dangerously-skip-permissions`, without the warning screen. The mode it had before is kept in cfg
 * so uninstall can put it back. 'keep' restores that earlier mode. Critical actions still ask: see the PreToolUse hook.
 */
export function applySessionPermissions(settings: any, cfg: Pick<Config, 'sessionPermissions' | 'claudeDefaultModeBefore'>) {
  const current = settings.permissions?.defaultMode;
  if (cfg.sessionPermissions === 'keep') return restoreSessionPermissions(settings, cfg);
  if (current !== 'bypassPermissions') cfg.claudeDefaultModeBefore = current ?? null;
  settings.permissions = { ...(settings.permissions ?? {}), defaultMode: 'bypassPermissions' };
  settings.skipDangerousModePermissionPrompt = true;
}

function restoreSessionPermissions(settings: any, cfg: Pick<Config, 'claudeDefaultModeBefore'>) {
  if (cfg.claudeDefaultModeBefore === undefined || settings.permissions?.defaultMode !== 'bypassPermissions') return;
  if (cfg.claudeDefaultModeBefore) settings.permissions.defaultMode = cfg.claudeDefaultModeBefore;
  else {
    delete settings.permissions.defaultMode;
    if (!Object.keys(settings.permissions).length) delete settings.permissions;
  }
  delete cfg.claudeDefaultModeBefore;
}

function removeOurHooks(settings: any) {
  for (const event of Object.keys(settings.hooks ?? {})) {
    const groups = (settings.hooks[event] as any[])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h: any) => !isOurs(h)) }))
      .filter((g) => g.hooks.length);
    if (groups.length) settings.hooks[event] = groups;
    else delete settings.hooks[event];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
}

export function uninstallHooks(cfg?: Pick<Config, 'claudeDefaultModeBefore'>) {
  if (!existsSync(CLAUDE_SETTINGS)) return;
  const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, 'utf8'));
  copyFileSync(CLAUDE_SETTINGS, `${CLAUDE_SETTINGS}.cmc-backup-${Date.now()}`);
  removeOurHooks(settings);
  if (cfg) restoreSessionPermissions(settings, cfg);
  writeAtomic(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + '\n');
}

export function hooksInstalled(): boolean {
  if (!existsSync(CLAUDE_SETTINGS)) return false;
  const s = JSON.parse(readFileSync(CLAUDE_SETTINGS, 'utf8'));
  return Object.values(s.hooks ?? {}).some((gs: any) => gs.some((g: any) => (g.hooks ?? []).some(isOurs)));
}

/** Background service (launchd agent on macOS, systemd --user unit on Linux): start at login, restart on crash. */
export const SERVICE = platform.service;
export const installService = () => platform.service.install();
export const uninstallService = () => platform.service.uninstall();
export const restartService = () => platform.service.restart();
