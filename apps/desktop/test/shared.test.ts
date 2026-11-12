import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Snapshot } from '@callmeclaude/protocol';
import { autostartEntry, floatToPcm16, hasDbusName, hubDataDir, orderSessions, panelPosition, parseHubConfig, parseSettings, pcm16ToFloat, showAtStart, timeLeft, trayLook } from '../src/shared.ts';

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  mode: 'away',
  language: 'en-US',
  sessions: [],
  pending: [],
  hubVersion: '0.1.0',
  paused: false,
  ringTarget: 'computer',
  ...over,
});

test('hub config: CMC_HOME wins, token and port are validated', () => {
  assert.equal(hubDataDir('/home/a', {}), '/home/a/.callmeclaude');
  assert.equal(hubDataDir('/home/a', { CMC_HOME: '/tmp/x' }), '/tmp/x');
  assert.deepEqual(parseHubConfig('{"appPort":47801,"appToken":"t"}'), { appPort: 47801, appToken: 't' });
  assert.deepEqual(parseHubConfig('{"appToken":"t"}'), { appPort: 47801, appToken: 't' });
  assert.equal(parseHubConfig(undefined), undefined);
  assert.equal(parseHubConfig('not json'), undefined);
  assert.equal(parseHubConfig('{"appPort":47801}'), undefined);
  assert.equal(parseHubConfig('{"appPort":99999,"appToken":"t"}'), undefined);
});

test('tray: green for any call (here or on the phone), then paused, then waiting, else idle', () => {
  assert.equal(trayLook({ link: 'setup' }).tone, 'offline');
  assert.match(trayLook({ link: 'offline' }).tooltip, /not running/);
  assert.equal(trayLook({ link: 'online', snapshot: snap() }).tone, 'idle');

  const phoneCall = trayLook({ link: 'online', snapshot: snap({ call: { callId: 'c', state: 'active', on: 'phone', title: 'x' } }) });
  assert.equal(phoneCall.tone, 'call');
  assert.match(phoneCall.tooltip, /on a call on your phone/);

  const ringingHere = trayLook({ link: 'online', snapshot: snap(), local: { callId: 'c', state: 'ringing', muted: false } });
  assert.equal(ringingHere.tone, 'call');
  assert.match(ringingHere.tooltip, /Claude is calling on this computer/);

  const pending = [{ id: 'p', sessionId: 's', project: 'api', kind: 'stop' as const, summary: 'x', risk: 'low' as const, createdAt: '', deadline: '' }];
  assert.equal(trayLook({ link: 'online', snapshot: snap({ paused: true, pending }) }).tone, 'paused');
  const waiting = trayLook({ link: 'online', snapshot: snap({ pending }) });
  assert.equal(waiting.tone, 'attention');
  assert.equal(waiting.badge, '1');
});

test('panel opens under a top menu bar and above a bottom taskbar, inside the screen', () => {
  const work = { x: 0, y: 25, width: 1440, height: 875 };
  const size = { width: 380, height: 620 };
  // macOS: icon in the menu bar near the right edge → below it, clamped to the right edge.
  assert.deepEqual(panelPosition({ x: 1400, y: 0, width: 24, height: 24 }, size, work), { x: 1440 - 380 - 4, y: 29 });
  // Windows: taskbar at the bottom → above the icon.
  const win = { x: 0, y: 0, width: 1920, height: 1040 };
  assert.deepEqual(panelPosition({ x: 1700, y: 1044, width: 24, height: 32 }, size, win), { x: 1522, y: 1040 - 620 - 4 });
});

test('linux autostart entry quotes paths with spaces and starts hidden', () => {
  assert.match(autostartEntry('/opt/CallMeClaude/callmeclaude'), /^Exec=\/opt\/CallMeClaude\/callmeclaude --hidden$/m);
  assert.match(autostartEntry('/home/a/My Apps/CallMeClaude.AppImage'), /^Exec="\/home\/a\/My Apps\/CallMeClaude.AppImage" --hidden$/m);
  assert.match(autostartEntry('/x/a"b c'), /^Exec="\/x\/a\\"b c" --hidden$/m);
});

test('PCM16 round trip clamps and keeps little-endian samples', () => {
  const pcm = floatToPcm16(new Float32Array([0, 1, -1, 2, -0.5]));
  assert.deepEqual([...pcm.slice(0, 4)], [0, 0, 0xff, 0x7f]);
  const back = pcm16ToFloat(pcm.buffer as ArrayBuffer);
  assert.equal(back.length, 5);
  assert.ok(Math.abs(back[1] - 1) < 1e-3 && back[2] === -1 && Math.abs(back[3] - 1) < 1e-3 && Math.abs(back[4] + 0.5) < 1e-3);
  assert.equal(pcm16ToFloat(new Uint8Array([1, 2, 3]).buffer).length, 1);
});

test('desktop settings: auto-answer is off unless saved as on, broken files fall back', () => {
  assert.deepEqual(parseSettings(undefined), { autoAnswer: false });
  assert.deepEqual(parseSettings('{"autoAnswer":true}'), { autoAnswer: true });
  assert.deepEqual(parseSettings('{"autoAnswer":"yes"}'), { autoAnswer: false });
  assert.deepEqual(parseSettings('null'), { autoAnswer: false });
  assert.deepEqual(parseSettings('{not json'), { autoAnswer: false });
});

test('orderSessions puts sessions that need you first and folds old finished ones', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  const at = (h: number) => new Date(now - h * 3600_000).toISOString();
  const list = [
    { id: 'old-done', state: 'done', updatedAt: at(30) },
    { id: 'run', state: 'running', updatedAt: at(0.1) },
    { id: 'done', state: 'done', updatedAt: at(1) },
    { id: 'ask', state: 'waiting_input', updatedAt: at(20) },
  ];
  const { recent, earlier } = orderSessions(list, now);
  assert.deepEqual(recent.map((s) => s.id), ['ask', 'run', 'done']);
  assert.deepEqual(earlier.map((s) => s.id), ['old-done']);
  assert.equal(timeLeft(new Date(now + 23.2 * 60_000).toISOString(), now), '24 min');
  assert.equal(timeLeft(new Date(now + 40_000).toISOString(), now), '40 s');
});

test('start hidden only when there is a tray to open the panel from', () => {
  assert.equal(showAtStart({ hidden: false, trayShown: true }), true);
  assert.equal(showAtStart({ hidden: true, trayShown: true }), false, 'login / --hidden with a tray: unchanged');
  assert.equal(showAtStart({ hidden: true, trayShown: false }), true, 'no tray (GNOME without AppIndicator): never invisible');
  assert.equal(showAtStart({ hidden: false, trayShown: false }), true);
});

test('NameHasOwner answers from dbus-send and gdbus', () => {
  assert.equal(hasDbusName('method return time=1.2 sender=org.freedesktop.DBus -> destination=:1.9 serial=3 reply_serial=2\n   boolean true\n'), true);
  assert.equal(hasDbusName('   boolean false\n'), false);
  assert.equal(hasDbusName('(true,)\n'), true);
  assert.equal(hasDbusName('(false,)\n'), false);
  assert.equal(hasDbusName('Error org.freedesktop.DBus.Error.ServiceUnknown'), undefined);
  assert.equal(hasDbusName(''), undefined);
});
