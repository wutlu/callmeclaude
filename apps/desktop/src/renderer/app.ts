// The panel: hub link, call handling, and the same controls as the phone app.
import type { AppToHub, HubToApp, PendingCard, SessionCard, Snapshot } from '@callmeclaude/protocol';
import { PROTOCOL_VERSION } from '@callmeclaude/protocol';
import { LANGUAGES, MODES, RING_TARGETS, stateLabel, type HubConfig, type View } from '../shared.ts';
import { CallAudio, Ringer } from './audio.ts';
import { trayIcons } from './icons.ts';

interface Bridge {
  hubConfig(): Promise<HubConfig | null>;
  view(v: View): void;
  icons(list: unknown): void;
  show(): void;
  hide(): void;
  openRepo(): void;
  loginItem(on?: boolean): Promise<boolean>;
  micAccess(): Promise<boolean>;
  platform(): Promise<string>;
  onCommand(cb: (c: any) => void): void;
}
const cmc = (window as any).cmc as Bridge;

let ws: WebSocket | undefined;
let link: View['link'] = 'offline';
let snapshot: Snapshot | undefined;
let local: View['local'];
let lines: Array<{ role: string; text: string; final: boolean }> = [];
let callStarted = 0;
let notice = '';
let confirmPanic = false;
let loginItem = false;
let lastMessageAt = 0;
let platform = '';
const ringer = new Ringer();
const audio = new CallAudio((pcm) => ws?.readyState === WebSocket.OPEN && ws.send(pcm));

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function send(m: AppToHub) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

// ---------- hub link ----------

async function connect() {
  const cfg = await cmc.hubConfig();
  if (!cfg) {
    setLink('setup');
    return setTimeout(connect, 5000);
  }
  const sock = new WebSocket(`ws://127.0.0.1:${cfg.appPort}`);
  sock.binaryType = 'arraybuffer';
  ws = sock;
  sock.onopen = () => {
    lastMessageAt = Date.now();
    sock.send(JSON.stringify({ type: 'auth', token: cfg.appToken, device: 'Desktop', v: PROTOCOL_VERSION, kind: 'desktop' } satisfies AppToHub));
  };
  sock.onmessage = (e) => {
    lastMessageAt = Date.now();
    if (e.data instanceof ArrayBuffer) {
      if (local?.state === 'active' || local?.state === 'connecting') audio.play(e.data);
      return;
    }
    try {
      onMessage(JSON.parse(e.data) as HubToApp);
    } catch {}
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = undefined;
    if (local && local.state !== 'ringing') endLocal('The connection to the hub dropped.');
    setLink('offline');
    setTimeout(connect, 2000);
  };
}

// The hub sends a heartbeat every 15 s; a silent socket is a dead one (sleep/wake, network change).
setInterval(() => {
  if (ws?.readyState === WebSocket.OPEN && Date.now() - lastMessageAt > 40_000) ws.close();
}, 10_000);

function setLink(l: View['link']) {
  link = l;
  if (l !== 'online') snapshot = undefined;
  update();
}

function onMessage(m: HubToApp) {
  switch (m.type) {
    case 'hello':
      link = 'online';
      snapshot = m.snapshot;
      break;
    case 'snapshot':
      snapshot = m.snapshot;
      // It stopped ringing elsewhere (timed out, answered on the phone, nothing left to say).
      if (local?.state === 'ringing' && snapshot.call?.callId !== local.callId) {
        ringer.stop();
        local = undefined;
      }
      break;
    case 'call.incoming':
      if (!local) {
        local = { callId: m.callId, state: 'ringing', muted: false };
        ringer.start();
      }
      break;
    case 'call.ready':
      if (local?.callId === m.callId) {
        local.state = 'active';
        callStarted = Date.now();
      }
      break;
    case 'call.ended':
      if (local?.callId === m.callId) endLocal();
      break;
    case 'audio.flush':
      audio.flush();
      break;
    case 'transcript': {
      const last = lines[lines.length - 1];
      if (last && !last.final && last.role === m.role) Object.assign(last, { text: m.text, final: m.final });
      else lines.push({ role: m.role, text: m.text, final: m.final });
      lines = lines.slice(-30);
      break;
    }
    case 'error':
      notice = m.message;
      break;
  }
  update();
}

// ---------- calls ----------

function newCallId() {
  return 'c_' + Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join('');
}

async function startAudio(): Promise<boolean> {
  try {
    if (!(await cmc.micAccess())) throw new Error('Microphone access is off. Allow it in System Settings → Privacy & Security → Microphone.');
    await audio.start();
    return true;
  } catch (e) {
    notice = (e as Error).message || 'Could not open the microphone.';
    return false;
  }
}

async function answer() {
  if (local?.state !== 'ringing') return;
  ringer.stop();
  local.state = 'connecting';
  lines = [];
  update();
  if (!(await startAudio())) return decline();
  send({ type: 'call.start', callId: local.callId, direction: 'outbound' });
}

function decline() {
  if (!local) return;
  ringer.stop();
  send({ type: 'call.end', callId: local.callId });
  local = undefined;
  update();
}

async function talk() {
  if (local || link !== 'online' || snapshot?.call) return;
  local = { callId: newCallId(), state: 'connecting', muted: false };
  lines = [];
  update();
  if (!(await startAudio())) {
    local = undefined;
    return update();
  }
  send({ type: 'call.start', callId: local.callId, direction: 'inbound' });
}

function hangup() {
  if (!local) return;
  send({ type: 'call.end', callId: local.callId });
  endLocal();
}

function endLocal(why = '') {
  ringer.stop();
  audio.stop();
  local = undefined;
  if (why) notice = why;
  update();
}

function toggleMute() {
  if (!local || local.state === 'ringing') return;
  local.muted = audio.muted = !local.muted;
  update();
}

cmc.onCommand((c) => {
  switch (c.type) {
    case 'answer':
      return void answer();
    case 'decline':
      return decline();
    case 'talk':
      cmc.show();
      return void talk();
    case 'hangup':
      return hangup();
    case 'mute':
      return toggleMute();
    case 'ring.set':
    case 'mode.set':
    case 'pending.resolve':
    case 'resume':
      return send(c);
  }
});

// ---------- rendering ----------

function update() {
  cmc.view({ link, snapshot, local: local && { ...local } });
  render();
}

function relative(iso: string) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!isFinite(s)) return '';
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)} min. ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr. ago`;
  return `${Math.floor(s / 86400)} days ago`;
}

function clock(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function callCard(): string {
  if (local?.state === 'ringing') {
    return `<section class="card call ringing">
      <div class="pulse"></div>
      <h2>Claude is calling</h2>
      <p class="muted">${esc(snapshot?.call?.title ?? 'An update from your sessions')}</p>
      <div class="row">
        <button class="btn green" data-a="answer">Answer</button>
        <button class="btn red" data-a="decline">Decline</button>
      </div>
    </section>`;
  }
  if (local) {
    const talkLines = lines
      .filter((l) => l.role !== 'system' && l.text.trim())
      .slice(-6)
      .map((l) => `<p class="line ${l.role}"><b>${l.role === 'user' ? 'You' : 'Claude'}</b> ${esc(l.text)}</p>`)
      .join('');
    return `<section class="card call active">
      <div class="row between"><h2>${local.state === 'connecting' ? 'Connecting…' : 'On a call'}</h2><span class="muted" id="clock">${local.state === 'active' ? clock(Date.now() - callStarted) : ''}</span></div>
      <div class="transcript">${talkLines || '<p class="muted">Say hello.</p>'}</div>
      <div class="row">
        <button class="btn" data-a="mute">${local.muted ? 'Unmute' : 'Mute'}</button>
        <button class="btn red" data-a="hangup">Hang up</button>
      </div>
    </section>`;
  }
  if (snapshot?.call) {
    const where = snapshot.call.on === 'phone' ? 'on your phone' : 'on another computer';
    return `<section class="card call elsewhere"><h2>${snapshot.call.state === 'ringing' ? 'Claude is calling' : 'On a call'} ${where}</h2>
      <p class="muted">${esc(snapshot.call.title)}</p></section>`;
  }
  return `<button class="btn talk" data-a="talk" ${link === 'online' ? '' : 'disabled'}>Talk to Claude</button>`;
}

function offlineCard(): string {
  if (platform === 'win32' && link !== 'online') {
    return `<section class="card warn"><h3>The hub does not run on Windows yet</h3>
      <p>CallMeClaude's hub (the part that watches Claude Code and calls you) runs on macOS and Linux today. Windows support is coming; this app connects as soon as a hub runs on this computer.</p></section>`;
  }
  if (link === 'setup') {
    return `<section class="card warn"><h3>Set up the hub first</h3>
      <p>CallMeClaude's hub runs in the background on this computer and watches your Claude Code sessions. Install it once:</p>
      <pre>git clone https://github.com/wutlu/callmeclaude
cd callmeclaude && pnpm install
cmc setup --gemini-key &lt;KEY&gt;</pre>
      <p class="muted">This window connects as soon as it is running.</p></section>`;
  }
  return `<section class="card warn"><h3>The hub is not running</h3>
    <p>Start it in a terminal with <code>cmc restart</code>. This window reconnects by itself.</p></section>`;
}

function pendingCard(p: PendingCard): string {
  return `<section class="card pending risk-${p.risk}">
    <div class="row between"><h3>${esc(p.project)}</h3><span class="tag">${p.kind === 'permission' ? 'Permission' : 'Waiting'}</span></div>
    <p>${esc(p.summary)}</p>
    <div class="row">
      <button class="btn small green" data-a="resolve" data-id="${esc(p.id)}" data-d="approve">Approve</button>
      <button class="btn small" data-a="resolve" data-id="${esc(p.id)}" data-d="deny">Deny</button>
      <button class="btn small" data-a="resolve" data-id="${esc(p.id)}" data-d="release">Let it stop</button>
    </div></section>`;
}

function sessionRow(s: SessionCard): string {
  return `<li class="session"><span class="dot st-${s.state}"></span>
    <div class="grow"><div class="row between"><b>${esc(s.project)}</b><span class="st st-${s.state}">${stateLabel(s.state)}</span></div>
    <p class="muted clip">${esc(s.summary)}</p><span class="time">${relative(s.updatedAt)}</span></div></li>`;
}

function segmented<T extends string>(name: string, opts: Array<{ id: T; label: string; hint: string }>, current: T | undefined, enabled: boolean) {
  const cur = opts.find((o) => o.id === current);
  return `<div class="seg">${opts
    .map((o) => `<button class="${o.id === current ? 'on' : ''}" data-a="${name}" data-v="${o.id}" ${enabled ? '' : 'disabled'}>${esc(o.label)}</button>`)
    .join('')}</div><p class="hint">${cur ? esc(cur.hint) : ''}</p>`;
}

function render() {
  const s = snapshot;
  const online = link === 'online' && !!s;
  const closeBtn = platform === 'linux' ? '' : '<button class="icon" data-a="hide" title="Close">✕</button>';
  $('#app').innerHTML = `
    <header class="row between">
      <h1>CallMeClaude</h1>
      <div class="row"><span class="pill ${online ? 'on' : 'off'}">${online ? 'Connected' : link === 'setup' ? 'Not set up' : 'Offline'}</span>${closeBtn}</div>
    </header>
    <main>
      ${notice ? `<div class="notice">${esc(notice)} <button class="link" data-a="dismiss">OK</button></div>` : ''}
      ${online ? '' : offlineCard()}
      ${callCard()}
      <h4>When Claude needs you</h4>
      ${segmented('ring', RING_TARGETS, s?.ringTarget, online)}
      ${s?.paused ? `<section class="card warn row between"><div><h3>Automation paused</h3><p class="muted">Sessions run; nothing is held or called.</p></div><button class="btn" data-a="resume">Resume</button></section>` : ''}
      ${s?.pending.map(pendingCard).join('') ?? ''}
      <h4>Mode</h4>
      ${segmented('mode', MODES, s?.mode, online)}
      <h4>Sessions${s ? ` · ${s.sessions.length}` : ''}</h4>
      ${s?.sessions.length ? `<ul class="sessions">${s.sessions.map(sessionRow).join('')}</ul>` : `<p class="muted">${online ? 'No open Claude Code sessions.' : '—'}</p>`}
      <h4>Settings</h4>
      <label class="row between setting">Voice language
        <select data-a="language" ${online ? '' : 'disabled'}>${LANGUAGES.map(([c, n]) => `<option value="${c}" ${s?.language === c ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
      </label>
      <label class="row between setting">Start at login <input type="checkbox" data-a="login" ${loginItem ? 'checked' : ''}></label>
      <button class="btn red wide" data-a="panic" ${online && !s?.paused ? '' : 'disabled'}>${confirmPanic ? 'Click again: interrupt all sessions and pause' : 'Stop everything'}</button>
      <p class="foot"><button class="link" data-a="repo">Source code (MIT)</button>${s ? ` · hub ${esc(s.hubVersion)}` : ''}</p>
    </main>`;
}

document.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest('[data-a]') as HTMLElement | null;
  if (!el || (el as HTMLButtonElement).disabled) return;
  const a = el.dataset.a!;
  if (a !== 'panic') confirmPanic = false;
  switch (a) {
    case 'answer':
      return void answer();
    case 'decline':
      return decline();
    case 'talk':
      return void talk();
    case 'hangup':
      return hangup();
    case 'mute':
      return toggleMute();
    case 'ring':
      return send({ type: 'ring.set', target: el.dataset.v as any });
    case 'mode':
      return send({ type: 'mode.set', mode: el.dataset.v as any });
    case 'resolve':
      return send({ type: 'pending.resolve', pendingId: el.dataset.id!, decision: el.dataset.d as any });
    case 'resume':
      return send({ type: 'resume' });
    case 'panic':
      if (!confirmPanic) {
        confirmPanic = true;
        return render();
      }
      confirmPanic = false;
      send({ type: 'panic' });
      return render();
    case 'dismiss':
      notice = '';
      return render();
    case 'hide':
      return cmc.hide();
    case 'repo':
      return cmc.openRepo();
  }
});

document.addEventListener('change', async (e) => {
  const el = e.target as HTMLInputElement | HTMLSelectElement;
  if (el.dataset.a === 'language') send({ type: 'language.set', language: el.value });
  if (el.dataset.a === 'login') {
    loginItem = await cmc.loginItem((el as HTMLInputElement).checked);
    render();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !local) cmc.hide();
});

// The call clock and "x min. ago" labels.
setInterval(() => {
  const c = document.getElementById('clock');
  if (c && local?.state === 'active') c.textContent = clock(Date.now() - callStarted);
}, 1000);
setInterval(() => !local && render(), 30_000);

void (async () => {
  platform = await cmc.platform();
  document.body.classList.add(`os-${platform}`);
  cmc.icons(trayIcons(platform));
  loginItem = await cmc.loginItem();
  update();
  void connect();
})();
