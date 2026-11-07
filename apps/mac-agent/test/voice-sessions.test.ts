import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, inProjectRoots, parseVoiceSessionsAnswer, planVoiceSessions, sessionPermissionMode, voiceSessionMode } from '../src/config.ts';
import { applySessionPermissions } from '../src/install.ts';
import { headlessStartArgs } from '../src/controller.ts';

const plan = (os: NodeJS.Platform, flags: Record<string, unknown>, interactive = false, tmuxInstalled = true) =>
  planVoiceSessions({ os, flags, interactive, tmuxInstalled });

test('default config has no voiceSessions key (macOS config.json stays the same)', () => {
  assert.equal('voiceSessions' in defaultConfig(), false);
  assert.ok(!JSON.stringify(defaultConfig()).includes('voiceSessions'));
});

test('setup on macOS never writes voiceSessions, flags or not', () => {
  for (const flags of [{}, { tmux: true }, { 'no-tmux': true }, { tmux: true, 'no-tmux': true }])
    for (const interactive of [true, false]) for (const t of [true, false]) assert.equal(plan('darwin', flags, interactive, t), undefined);
});

test('setup on Linux: flags win, then the question, then tmux if installed', () => {
  assert.equal(plan('linux', { tmux: true }, true, false), 'tmux');
  assert.equal(plan('linux', { 'no-tmux': true }, true, true), 'headless');
  assert.throws(() => plan('linux', { tmux: true, 'no-tmux': true }), /either --tmux or --no-tmux/);
  assert.equal(plan('linux', {}, true, true), 'ask');
  assert.equal(plan('linux', {}, true, false), 'ask');
  assert.equal(plan('linux', {}, false, true), 'tmux');
  assert.equal(plan('linux', {}, false, false), 'headless');
});

test('voice session mode: headless only on Linux with the opt-out; missing key = tmux', () => {
  assert.equal(voiceSessionMode({ voiceSessions: 'headless' }, 'linux'), 'headless');
  assert.equal(voiceSessionMode({ voiceSessions: 'tmux' }, 'linux'), 'tmux');
  assert.equal(voiceSessionMode({}, 'linux'), 'tmux');
  assert.equal(voiceSessionMode({ voiceSessions: 'headless' }, 'darwin'), 'tmux');
});

test('headless start argv: print mode, fixed session id, full permission, task as the prompt', () => {
  assert.deepEqual(headlessStartArgs('11111111-2222-3333-4444-555555555555', 'fix the tests'), [
    '-p',
    '--session-id',
    '11111111-2222-3333-4444-555555555555',
    '--permission-mode',
    'bypassPermissions',
    'fix the tests',
  ]);
  assert.equal(headlessStartArgs('id', 't', 'acceptEdits')[4], 'acceptEdits');
});

test('session permissions: bypass unless the config says keep', () => {
  assert.equal(sessionPermissionMode({}), 'bypassPermissions');
  assert.equal(sessionPermissionMode({ sessionPermissions: 'bypass' }), 'bypassPermissions');
  assert.equal(sessionPermissionMode({ sessionPermissions: 'keep' }), 'acceptEdits');
});

test('setup makes bypassPermissions Claude Code\'s default mode; keep / uninstall put the old mode back', () => {
  const cfg: any = {};
  const settings: any = { permissions: { defaultMode: 'auto', allow: ['Bash(ls)'] } };
  applySessionPermissions(settings, cfg);
  assert.equal(settings.permissions.defaultMode, 'bypassPermissions');
  assert.deepEqual(settings.permissions.allow, ['Bash(ls)']);
  assert.equal(settings.skipDangerousModePermissionPrompt, true);
  assert.equal(cfg.claudeDefaultModeBefore, 'auto');
  // Running setup again does not forget the original mode.
  applySessionPermissions(settings, cfg);
  assert.equal(cfg.claudeDefaultModeBefore, 'auto');
  cfg.sessionPermissions = 'keep';
  applySessionPermissions(settings, cfg);
  assert.equal(settings.permissions.defaultMode, 'auto');
  assert.equal(cfg.claudeDefaultModeBefore, undefined);

  const fresh: any = {};
  const cfg2: any = {};
  applySessionPermissions(fresh, cfg2);
  assert.equal(cfg2.claudeDefaultModeBefore, null);
  cfg2.sessionPermissions = 'keep';
  applySessionPermissions(fresh, cfg2);
  assert.equal(fresh.permissions, undefined);
});

test('project roots: the root itself and folders inside it, not look-alike siblings', () => {
  const roots = ['/home/u/code'];
  assert.ok(inProjectRoots(roots, '/home/u/code'));
  assert.ok(inProjectRoots(roots, '/home/u/code/app'));
  assert.ok(!inProjectRoots(roots, '/home/u/code-old/app'));
  assert.ok(!inProjectRoots(roots, '/etc'));
  assert.ok(!inProjectRoots([], '/home/u/code'));
});

test('setup question on Linux: empty = default, 1/2 or the names, anything else asks again', () => {
  const p = parseVoiceSessionsAnswer;
  // tmux installed: 1) tmux (default) 2) headless
  assert.equal(p('', true), 'tmux');
  assert.equal(p('  ', true), 'tmux');
  assert.equal(p('1', true), 'tmux');
  assert.equal(p('2', true), 'headless');
  // tmux missing: 1) headless (default) 2) tmux
  assert.equal(p('', false), 'headless');
  assert.equal(p('1', false), 'headless');
  assert.equal(p('2', false), 'tmux');
  assert.equal(p('TMUX', false), 'tmux');
  assert.equal(p(' headless ', true), 'headless');
  for (const bad of ['3', '0', 'y', 'yes', '12', '1 2', 'x']) assert.equal(p(bad, true), undefined, bad);
});
