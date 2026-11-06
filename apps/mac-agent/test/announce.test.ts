import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Announcer, doneText, shouldAnnounce, speakableProject } from '../src/announce.ts';
import { pickSayVoice } from '../src/platform/darwin.ts';

test('the alert is in the configured language, unknown languages fall back to English', () => {
  assert.equal(doneText('claude-alert', 'tr-TR'), 'claude alert projesi görevi tamamlandı.');
  assert.equal(doneText('acme_web', 'de-DE'), 'acme web: Aufgabe erledigt.');
  assert.equal(doneText('acme', 'en-GB'), 'acme: task complete.');
  assert.equal(doneText('acme', 'sw-KE'), 'acme: task complete.');
  assert.equal(speakableProject('runime.com'), 'runime com');
  assert.equal(speakableProject('---'), 'Claude');
});

test('short turns, sleep mode, "off" and a call on the same device stay silent', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  const base = { target: 'computer' as const, mode: 'away', now, minSeconds: 20, turnAt: '2026-11-07T11:59:00Z' };
  assert.equal(shouldAnnounce(base), true);
  assert.equal(shouldAnnounce({ ...base, turnAt: '2026-11-07T11:59:50Z' }), false);
  assert.equal(shouldAnnounce({ ...base, turnAt: undefined }), true, 'unknown start (hub restarted) counts as long');
  assert.equal(shouldAnnounce({ ...base, target: 'off' }), false);
  assert.equal(shouldAnnounce({ ...base, mode: 'sleep' }), false);
  assert.equal(shouldAnnounce({ ...base, mode: 'desk' }), true);
  assert.equal(shouldAnnounce({ ...base, callOn: 'desktop' }), false);
  assert.equal(shouldAnnounce({ ...base, callOn: 'phone' }), true);
  assert.equal(shouldAnnounce({ ...base, target: 'phone', callOn: 'phone' }), false);
  assert.equal(shouldAnnounce({ ...base, target: 'phone', callOn: 'desktop' }), true);
});

test('macOS picks a real voice for the language, not a novelty one', () => {
  const listing = [
    'Albert              en_US    # Hello! My name is Albert.',
    'Bad News            en_US    # Hello! My name is Bad News.',
    'Samantha            en_US    # Hello! My name is Samantha.',
    'Daniel              en_GB    # Hello! My name is Daniel.',
    'Cem                 tr_TR    # Merhaba, benim adım Cem.',
    'Yelda               tr_TR    # Merhaba, benim adım Yelda.',
    'Eddy (German (Germany)) de_DE    # Hallo! Ich heiße Eddy.',
  ].join('\n');
  assert.equal(pickSayVoice(listing, 'en-US'), 'Samantha');
  assert.equal(pickSayVoice(listing, 'en-GB'), 'Daniel');
  assert.equal(pickSayVoice(listing, 'en-AU'), 'Samantha', 'same language when the region is missing');
  assert.equal(pickSayVoice(listing, 'tr-TR'), 'Yelda');
  assert.equal(pickSayVoice(listing, 'de-DE'), 'Eddy (German (Germany))');
  assert.equal(pickSayVoice(listing, 'ja-JP'), undefined);
});

function fakeHub(target: 'off' | 'computer' | 'phone', phoneConnected = true) {
  const sent: unknown[] = [];
  const spoken: string[] = [];
  const hub: any = {
    cfg: { mode: 'away', language: 'tr-TR', doneAlert: { target, minSeconds: 20 } },
    st: {},
    app: { broadcast: (m: unknown, kind: string) => (sent.push({ m, kind }), phoneConnected) },
  };
  const a = new Announcer(hub, { speak: async (t: string) => void spoken.push(t) });
  return { a, sent, spoken };
}

test('a finished turn is spoken on the computer, once, and the next turn is timed from that Stop', async () => {
  const { a, spoken } = fakeHub('computer');
  const s: any = { project: 'acme', turnAt: new Date(Date.now() - 60_000).toISOString() };
  a.done(s);
  a.done(s); // Stop again right away (a continued turn that was short): silent
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(spoken, ['acme projesi görevi tamamlandı.']);
});

test('with "phone" the text goes to the phone apps only', () => {
  const { a, sent, spoken } = fakeHub('phone');
  a.done({ project: 'acme' } as any);
  assert.deepEqual(sent, [{ m: { type: 'announce', text: 'acme projesi görevi tamamlandı.', language: 'tr-TR' }, kind: 'phone' }]);
  assert.deepEqual(spoken, []);
});
