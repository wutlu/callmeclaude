import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { EventEmitter } from 'node:events';

// Isolated hub home + ports so tests never touch the real installation.
const home = mkdtempSync(join(process.env.CMC_TEST_TMP ?? tmpdir(), 'cmc-test-'));
process.env.CMC_HOME = home;
mkdirSync(home, { recursive: true });
const HOOK = 47950;
const APP = 47951;
writeFileSync(
  join(home, 'config.json'),
  JSON.stringify({ hookPort: HOOK, appPort: APP, hookToken: 'hooktok', appToken: 'apptok', mode: 'away', holdSeconds: 20, calls: { batchSeconds: { P1: 0, P2: 0 }, minGapSeconds: 0 } }),
);
// Skip the real Claude classifier in tests unless explicitly requested.
if (!process.env.CMC_TEST_LIVE) process.env.CMC_CLASSIFY_OFFLINE = '1';

let hub: any;
const spawned: { args: string[]; cwd: string; child: EventEmitter }[] = [];
before(async () => {
  const { Hub } = await import('../src/hub.ts');
  hub = new Hub();
  // Never launch the real claude CLI from tests.
  hub.controller.spawnClaude = (args: string[], cwd: string) => {
    const child: any = Object.assign(new EventEmitter(), { pid: undefined, exitCode: null });
    spawned.push({ args, cwd, child });
    return child;
  };
  hub.start();
  await new Promise((r) => setTimeout(r, 300));
});
after(() => setTimeout(() => process.exit(0), 50));

const hook = (event: string, body: object, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${HOOK}/hooks/${event}`, {
    method: 'POST',
    headers: { authorization: 'Bearer hooktok', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).then((r) => r.json());

function phone(kind?: 'desktop'): Promise<{ ws: WebSocket; msgs: any[]; next: (type: string) => Promise<any> }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${APP}`);
    const msgs: any[] = [];
    const waiters: Array<[string, (m: any) => void]> = [];
    ws.on('message', (d, bin) => {
      if (bin) return;
      const m = JSON.parse(d.toString());
      msgs.push(m);
      const i = waiters.findIndex(([t]) => t === m.type);
      if (i >= 0) waiters.splice(i, 1)[0][1](m);
    });
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token: 'apptok', device: kind ? 'test-desktop' : 'test-phone', v: 1, ...(kind ? { kind } : {}) }));
      resolve({
        ws,
        msgs,
        next: (type) =>
          new Promise((res) => {
            const found = msgs.find((m) => m.type === type && !m.__seen);
            if (found) {
              found.__seen = true;
              return res(found);
            }
            waiters.push([type, res]);
          }),
      });
    });
  });
}

test('rejects hooks without token', async () => {
  const r = await fetch(`http://127.0.0.1:${HOOK}/hooks/Stop`, { method: 'POST', body: '{}' });
  assert.equal(r.status, 401);
});

test('phone with bad token is rejected', async () => {
  const code = await new Promise<number>((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${APP}`);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: 'nope', device: 'x', v: 1 })));
    ws.on('close', (c) => res(c));
  });
  assert.equal(code, 4003);
});

test('session lifecycle + blocked stop is held, phone rings, instruction continues the agent', async () => {
  const p = await phone();
  const hello = await p.next('hello');
  assert.equal(hello.snapshot.mode, 'away');

  await hook('SessionStart', { session_id: 's1', cwd: '/tmp/acme-web', transcript_path: '', source: 'startup' }, { 'x-cmc-tmux-pane': '$TMUX_PANE' });
  await hook('UserPromptSubmit', { session_id: 's1', cwd: '/tmp/acme-web', prompt: 'Başvuru formunu doldur ve gönder' });
  assert.equal(hub.st.sessions.get('s1').state, 'running');
  assert.equal(hub.st.sessions.get('s1').tmuxPane, undefined, 'literal $TMUX_PANE must be ignored');

  // The Stop hook is held open until the developer answers.
  const held = hook('Stop', {
    session_id: 's1',
    cwd: '/tmp/acme-web',
    stop_hook_active: false,
    last_assistant_message: "I filled in the form, but I can't submit it without your approval. Should I submit it?",
  });
  const ring = await p.next('call.incoming');
  assert.match(ring.title, /acme-web/);
  assert.equal(hub.st.openPending().length, 1);
  assert.equal(hub.st.sessions.get('s1').state, 'blocked');

  const s = hub.st.findSession('Acme Web');
  assert.ok(s, 'fuzzy project lookup');
  const via = await hub.controller.instruct(s, 'Gönder, tam yetkilisin.');
  assert.equal(via, 'hold');
  const reply: any = await held;
  assert.equal(reply.decision, 'block');
  assert.match(reply.reason, /Gönder, tam yetkilisin/);
  assert.equal(hub.st.openPending().length, 0);
  hub.calls.takeAgenda();
});

test('permission request: auto-approve rule, then held + approved', async () => {
  hub.cfg.autoApprove['api'] = ['Bash(npm test'];
  const auto: any = await hook('PermissionRequest', { session_id: 's2', cwd: '/x/api', tool_name: 'Bash', tool_input: { command: 'npm test -- --watch=false' } });
  assert.equal(auto.hookSpecificOutput.decision.behavior, 'allow');
  // Only looking (CI status, reading a file): approved without a call.
  const look: any = await hook('PermissionRequest', { session_id: 's2', cwd: '/x/api', tool_name: 'Bash', tool_input: { command: 'gh run list -L 3' } });
  assert.equal(look.hookSpecificOutput.decision.behavior, 'allow');
  assert.equal(hub.st.openPending().length, 0);

  const held = hook('PermissionRequest', { session_id: 's2', cwd: '/x/api', tool_name: 'Bash', tool_input: { command: 'git push origin main' } });
  await new Promise((r) => setTimeout(r, 100));
  const pend = hub.st.openPending()[0];
  assert.equal(pend.risk, 'high');
  assert.ok(hub.controller.permission(hub.st.sessions.get('s2'), true));
  const r: any = await held;
  assert.equal(r.hookSpecificOutput.decision.behavior, 'allow');
  hub.calls.takeAgenda();
});

test('instruction for a busy session is queued and delivered on next tool event', async () => {
  await hook('PreToolUse', { session_id: 's3', cwd: '/x/blog', tool_name: 'Bash', tool_input: {} });
  const s = hub.st.sessions.get('s3');
  assert.equal(await hub.controller.instruct(s, 'README linklerini de düzelt'), 'queue');
  const r: any = await hook('PostToolUse', { session_id: 's3', cwd: '/x/blog', tool_name: 'Bash', tool_input: {}, tool_response: {} });
  assert.match(r.hookSpecificOutput.additionalContext, /README linklerini/);
  assert.equal(hub.st.queued.has('s3'), false);
});

test('instruction for an idle session nobody can type into runs in a headless fork', async () => {
  // Stopped, hold gone (expired / hub restarted), not in tmux: queuing would wait for the keyboard.
  const s = hub.st.upsertSession('s4', '/x/site', { state: 'waiting' });
  assert.equal(await hub.controller.instruct(s, 'Vercel deploy et'), 'fork');
  const forkId = hub.controller.forks.get('s4');
  const { args, cwd } = spawned.at(-1)!;
  assert.equal(cwd, '/x/site');
  assert.deepEqual(args.slice(0, 6), ['-p', '--resume', 's4', '--fork-session', '--session-id', forkId]);
  assert.match(args.at(-1)!, /Vercel deploy et/);
  assert.equal(hub.st.queued.has('s4'), false);
  // The fork is the session the project name now resolves to, and it is running.
  assert.equal(hub.st.findSession('site').id, forkId);
  assert.equal(hub.st.sessions.get(forkId).state, 'running');
  // The apps label it as a background copy while it runs (cards and the pending it raises).
  const card = hub.st.snapshot().sessions.find((c: any) => c.id === forkId);
  assert.equal(card.background, true);
  assert.equal(hub.st.snapshot().sessions.find((c: any) => c.id === 's4')?.background, undefined);
  spawned.at(-1)!.child.emit('exit', 0);
  assert.equal(hub.st.sessions.get(forkId).background, false);
});

test('cmc tell: the control API delivers an instruction to a session by project name', async () => {
  await hook('PreToolUse', { session_id: 's_tell', cwd: '/x/shop', tool_name: 'Bash', tool_input: {} });
  const ctl = (body: object) =>
    fetch(`http://127.0.0.1:${HOOK}/control/tell`, { method: 'POST', headers: { authorization: 'Bearer hooktok', 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  assert.deepEqual(await ctl({ project: 'shop', text: 'run the tests too' }), { project: 'shop', via: 'queue' });
  assert.deepEqual(hub.st.queued.get('s_tell'), ['run the tests too']);
  assert.deepEqual(await ctl({ project: 'nope', text: 'x' }), { error: 'session not found' });
  assert.deepEqual(await ctl({ project: 'shop', text: '  ' }), { error: 'empty instruction' });
  const noAuth = await fetch(`http://127.0.0.1:${HOOK}/control/tell`, { method: 'POST', body: '{}' });
  assert.notEqual(noAuth.status, 200);
});

test('desk mode never holds', async () => {
  hub.cfg.mode = 'desk';
  const t = Date.now();
  const r = await hook('Stop', { session_id: 's4', cwd: '/x/desk', stop_hook_active: false, last_assistant_message: 'Should I continue?' });
  assert.deepEqual(r, {});
  assert.ok(Date.now() - t < 1000);
  assert.equal(hub.st.sessions.get('s4').state, 'waiting_input');
  hub.cfg.mode = 'away';
});

test('"call me when done" rings even in desk mode, once, for the session started by phone', async () => {
  hub.cfg.mode = 'desk';
  const p = await phone();
  await p.next('hello');
  // An unrelated session already open in the same folder must not consume the callback.
  await hook('SessionStart', { session_id: 'old', cwd: '/x/game', source: 'startup' });
  hub.st.addCallback({ dir: '/x/game' });
  // SessionStart never arrives over HTTP hooks: the first hook of the new session binds the callback.
  await hook('UserPromptSubmit', { session_id: 'new', cwd: '/x/game', prompt: 'redesign the lobby' });
  assert.equal(hub.st.hasCallback(hub.st.sessions.get('new')), true);
  assert.equal(hub.st.hasCallback(hub.st.sessions.get('old')), false);
  const quiet = await hook('Stop', { session_id: 'old', cwd: '/x/game', stop_hook_active: false, last_assistant_message: 'Done.' });
  assert.deepEqual(quiet, {}, 'other session in desk mode stays quiet');

  const held = hook('Stop', { session_id: 'new', cwd: '/x/game', stop_hook_active: false, last_assistant_message: 'Done: the lobby is redesigned and tests pass.' });
  const ring = await p.next('call.incoming');
  assert.match(ring.title, /game/);
  assert.equal(hub.st.hasCallback(hub.st.sessions.get('new')), false, 'callback is used up');
  hub.controller.release(hub.st.sessions.get('new'));
  await held;
  hub.calls.ringing && clearTimeout(hub.calls.ringing.timer);
  hub.calls.ringing = undefined;
  hub.calls.takeAgenda();
  p.ws.close();
  hub.cfg.mode = 'away';
});

test('start_session refuses to open a second session where one is already open', async () => {
  const { runTool } = await import('../src/voice/tools.ts');
  hub.cfg.projectRoots = ['/x'];
  await hook('SessionStart', { session_id: 'plat', cwd: '/x/platform', source: 'startup' });
  hub.controller.findProjectDir = () => '/x/platform';
  const r: any = await runTool(hub, 'start_session', { project: 'platform', task: 'improve the lobby', confirmed: true }, { endCall() {} });
  assert.match(r.error, /already open/);
  assert.equal(r.open_session, 'platform');
});

test('hold expires and releases the session', async () => {
  hub.cfg.holdSeconds = 1;
  const r = await hook('Stop', { session_id: 's5', cwd: '/x/exp', stop_hook_active: false, last_assistant_message: 'Done. All tests pass.' });
  assert.deepEqual(r, {});
  hub.cfg.holdSeconds = 20;
  hub.calls.takeAgenda();
});

test('panic interrupts held sessions and pauses', async () => {
  const held = hook('Stop', { session_id: 's6', cwd: '/x/p', stop_hook_active: false, last_assistant_message: 'Shall I deploy?' });
  await new Promise((r) => setTimeout(r, 100));
  await hub.controller.panic();
  const r: any = await held;
  assert.equal(r.continue, false);
  assert.equal(hub.st.paused, true);
  const r2 = await hook('Stop', { session_id: 's6', cwd: '/x/p', stop_hook_active: false, last_assistant_message: 'Shall I deploy?' });
  assert.deepEqual(r2, {}, 'paused hub never holds');
  hub.st.paused = false;
});

test('watch-only folders are tracked and reported but never held', async () => {
  hub.cfg.ignorePaths = ['/x/private'];
  const r = await hook('Stop', { session_id: 's7', cwd: '/x/private/app', stop_hook_active: false, last_assistant_message: 'Should I deploy?' });
  assert.deepEqual(r, {});
  assert.equal(hub.st.sessions.get('s7').state, 'waiting_input');
  assert.equal(hub.st.openPending().filter((p: any) => p.sessionId === 's7').length, 0);
  assert.ok(hub.st.findSession('app'), 'visible to the voice agent');
  hub.cfg.ignorePaths = [];
});

test('phone instruction becomes the latest prompt for the classifier', async () => {
  await hook('SessionStart', { session_id: 's8', cwd: '/x/lp', source: 'startup' });
  const held = hook('Stop', { session_id: 's8', cwd: '/x/lp', stop_hook_active: false, last_assistant_message: 'Shall I also add tests?' });
  await new Promise((r) => setTimeout(r, 100));
  await hub.controller.instruct(hub.st.sessions.get('s8'), 'Evet, testleri de ekle');
  await held;
  assert.match(hub.st.sessions.get('s8').lastPrompt, /New instruction by phone: Evet, testleri de ekle/);
  hub.calls.takeAgenda();
});

test('call survives a phone reconnect: same callId re-attaches, late close of old socket is ignored', async () => {
  // Stub the voice layer: no Gemini in tests.
  const { VoiceCall } = await import('../src/voice/call.ts');
  const realStart = VoiceCall.prototype.start;
  VoiceCall.prototype.start = async function () {};
  try {
    const a = await phone();
    await a.next('hello');
    a.ws.send(JSON.stringify({ type: 'call.start', callId: 'c_test1', direction: 'inbound' }));
    await a.next('call.ready');
    assert.equal(hub.voice.active.callId, 'c_test1');

    const b = await phone();
    await b.next('hello');
    b.ws.send(JSON.stringify({ type: 'call.start', callId: 'c_test1', direction: 'inbound' }));
    await b.next('call.ready');
    a.ws.close(); // old socket closes late
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(hub.voice.active?.callId, 'c_test1', 'call still alive');
    assert.equal(hub.voice.active.sinkId !== undefined, true);

    b.ws.send(JSON.stringify({ type: 'call.end', callId: 'c_test1' }));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(hub.voice.active, undefined);
    b.ws.close();
  } finally {
    VoiceCall.prototype.start = realStart;
  }
});

test('ring target: the desktop app rings instead of the phone, falls back to the phone, or nobody rings', async () => {
  const mode = hub.cfg.mode;
  hub.cfg.mode = 'away';
  const p = await phone();
  const d = await phone('desktop');
  await p.next('hello');
  await d.next('hello');
  const incoming = (c: { msgs: any[] }) => c.msgs.filter((m) => m.type === 'call.incoming').length;

  // Computer: only the desktop app rings, and the snapshot shows it (the tray turns green).
  d.ws.send(JSON.stringify({ type: 'ring.set', target: 'computer' }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(hub.cfg.ringTarget, 'computer');
  let r = await hub.calls.ring([{ priority: 'P1', title: 'a', text: 'a' }], 1);
  assert.equal(r.viaSocket, true);
  await d.next('call.incoming');
  assert.equal(incoming(p), 0);
  assert.deepEqual(hub.st.snapshot().call, { callId: r.callId, state: 'ringing', on: 'desktop', title: 'a' });
  hub.calls.takeAgenda();
  // Desk mode means "don't call my phone": with the desktop app as the target it still rings here.
  hub.cfg.mode = 'desk';
  assert.equal(hub.deskQuiet(), false);
  assert.equal(hub.calls.allowed('P1'), true);
  assert.equal(hub.st.snapshot().call, undefined);

  // Computer, but the desktop app is closed: the phone rings rather than nobody.
  d.ws.close();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(hub.deskQuiet(), true);
  hub.cfg.mode = 'away';
  r = await hub.calls.ring([{ priority: 'P1', title: 'b', text: 'b' }], 1);
  await p.next('call.incoming');
  assert.equal(hub.st.snapshot().call.on, 'phone');
  hub.calls.takeAgenda();

  // Off: nothing rings; the update waits for the next conversation, and rings once calls are back on.
  hub.setRingTarget('off');
  hub.calls.enqueue({ priority: 'P1', title: 'c', text: 'c', requested: true });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(hub.calls.ringing, undefined);
  assert.equal(incoming(p), 1);
  hub.setRingTarget('phone');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(incoming(p), 2);
  assert.equal(hub.calls.takeAgenda()[0].title, 'c');
  p.ws.close();
  hub.cfg.mode = mode;
});

test('on a call, a second decision waits until the first is answered', async () => {
  const { VoiceCall } = await import('../src/voice/call.ts');
  const sink = { id: 'x', audio() {}, json() {} };
  const call: any = new VoiceCall(hub, 'c_q', 'outbound', [], sink, () => {});
  const said: string[] = [];
  call.send = (t: string) => said.push(t);
  hub.st.on('changed', call.onState);
  const mk = (id: string) => {
    hub.st.pending.set(id, { id, sessionId: 's_q', project: 'api', kind: 'permission', summary: id, detail: '', risk: 'medium', createdAt: '', deadline: '', status: 'open' });
  };
  mk('p_q1');
  mk('p_q2');
  call.inject('first?', 'now', 'p_q1');
  call.inject('second?', 'now', 'p_q2');
  assert.equal(said.length, 1);
  assert.match(said[0], /first\?/);
  hub.st.pending.get('p_q1').status = 'resolved';
  hub.st.changed();
  assert.equal(said.length, 2);
  assert.match(said[1], /second\?/);
  hub.st.off('changed', call.onState);
  hub.st.pending.delete('p_q1');
  hub.st.pending.delete('p_q2');
});

test('background sessions are found from running claude -p processes (also ones started before a restart)', async () => {
  const { headlessIds } = await import('../src/controller.ts');
  const ps = [
    'COMMAND',
    'claude -p --resume aaa --fork-session --session-id bbb-1 --permission-mode acceptEdits The developer said',
    '/usr/local/bin/claude -p --resume ccc --permission-mode acceptEdits hi',
    'claude --allow-dangerously-skip-permissions --chrome',
    'claude --resume ddd',
    'grep claude -p --session-id zzz',
  ].join('\n');
  assert.deepEqual([...headlessIds(ps)].sort(), ['bbb-1', 'ccc']);
});
