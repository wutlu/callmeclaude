import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { darwin } from '../src/platform/darwin.ts';
import { linux } from '../src/platform/linux.ts';
import { systemPrompt } from '../src/voice/prompt.ts';
import { declarationsFor, startSessionReply } from '../src/voice/tools.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('macOS voice prompt and tool declarations are byte-for-byte unchanged', () => {
  for (const mode of ['away', 'ride'] as const) {
    const hub: any = { cfg: { mode, language: 'tr-TR' } };
    assert.equal(systemPrompt(hub, darwin), fixture(`darwin-voice-prompt-${mode}.txt`));
  }
  assert.equal(JSON.stringify(declarationsFor(darwin), null, 2) + '\n', fixture('darwin-voice-declarations.json'));
});

test('on the desktop app the voice knows it is the computer, not a phone call', () => {
  for (const mode of ['away', 'ride'] as const) {
    const hub: any = { cfg: { mode, language: 'tr-TR' } };
    const p = systemPrompt(hub, darwin, 'desktop');
    assert.match(p, /THIS COMPUTER's microphone/);
    assert.match(p, /can see the screen/);
    assert.ok(!p.includes('PHONE CALL') && !p.includes('helmet intercom') && !p.includes('cannot look at a screen'));
  }
});

test('Linux voice texts say "computer", not "Mac"', () => {
  const hub: any = { cfg: { mode: 'away', language: 'en-US' } };
  const p = systemPrompt(hub, linux);
  assert.ok(p.includes("running on the developer's computer."));
  assert.ok(!/\bMac\b/.test(p));
  const decl = JSON.stringify(declarationsFor(linux));
  assert.ok(decl.includes('Let the hub itself operate this computer:'));
  assert.ok(!/\bMac\b/.test(decl));
});

test('start_session reply: tmux field unchanged in tmux mode, session_id in headless mode', () => {
  assert.deepEqual(startSessionReply('tmux', '/p', 'cmc-p-ab12'), { ok: true, dir: '/p', tmux: 'cmc-p-ab12', say: "Session started. I'll call when it's done or stuck." });
  const h = startSessionReply('headless', '/p', '0b6c…uuid');
  assert.equal(h.session_id, '0b6c…uuid');
  assert.equal(h.mode, 'headless');
  assert.ok(!('tmux' in h));
});
