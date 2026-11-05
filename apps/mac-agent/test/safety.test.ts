import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CMC_HOME ??= mkdtempSync(join(tmpdir(), 'cmc-safety-'));

const { guard } = await import('../src/brain.ts');
const { runTool } = await import('../src/voice/tools.ts');

const deny = async (tool: string, input: object) => (await guard('test')(tool, input as any, {} as any))!.behavior === 'deny';

test('.env files are protected however they are referenced', async () => {
  for (const input of [
    { file_path: '/p/.env' },
    { command: 'cat .env' },
    { command: 'cat ./.env.local' },
    { command: 'grep KEY .env.production | head' },
    { command: 'source .env && npm start' },
    { file_path: '/p/apps/web/.env.development.local' },
  ])
    assert.ok(await deny(input.file_path ? 'Read' : 'Bash', input), JSON.stringify(input));
});

test('harmless look-alikes of .env are not blocked', async () => {
  for (const input of [{ command: 'cat .envrc' }, { file_path: '/p/.env.example' }, { command: 'echo $NODE_ENV' }, { file_path: '/p/src/environment.ts' }])
    assert.equal(await deny(input.file_path ? 'Read' : 'Bash', input), false, JSON.stringify(input));
});

function fakeHub() {
  const calls: string[] = [];
  return {
    calls,
    hub: { st: { paused: false, activeSessions: () => [], findSession: () => undefined }, controller: { panic: async (src: string) => void calls.push('panic:' + src) } } as any,
  };
}

test('stop all (panic) by voice needs an explicit confirmation', async () => {
  const { hub, calls } = fakeHub();
  const r: any = await runTool(hub, 'stop', { target: 'all' }, { endCall() {} });
  assert.equal(r.needs_confirmation, true);
  assert.deepEqual(calls, []);
  await runTool(hub, 'stop', { target: 'all', confirmed: true }, { endCall() {} });
  assert.deepEqual(calls, ['panic:voice']);
});

test('a locked phone can ask but not change anything', async () => {
  const { hub } = fakeHub();
  const locked = { endCall() {}, locked: () => true };
  for (const [name, args] of [
    ['reply_to_session', { project: 'x', instruction: 'deploy' }],
    ['computer_task', { task: 't', goal: 'g', confirmed: true }],
    ['start_session', { project: 'x', task: 't', confirmed: true }],
    ['answer_permission', { project: 'x', approve: true }],
    ['auto_approve', { project: 'x', rule: 'npm', confirmed: true }],
    ['resume_hub', { confirmed: true }],
  ] as const)
    assert.equal(((await runTool(hub, name, args, locked)) as any).error, 'phone_locked', name);
  // Denying a permission and the emergency stop still work; unlocked phones are unaffected.
  assert.notEqual(((await runTool(hub, 'answer_permission', { project: 'x', approve: false }, locked)) as any).error, 'phone_locked');
  assert.notEqual(((await runTool(hub, 'reply_to_session', { project: 'x', instruction: 'go' }, { endCall() {}, locked: () => false })) as any).error, 'phone_locked');
  assert.equal(((await runTool(hub, 'stop', { target: 'all', confirmed: true }, locked)) as any).ok, true);
});
