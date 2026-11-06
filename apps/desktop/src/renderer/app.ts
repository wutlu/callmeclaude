// The panel: hub link, call handling, and the same controls as the phone app.
import type { AppToHub, HubToApp, PendingCard, SessionCard, Snapshot } from '@callmeclaude/protocol';
import { PROTOCOL_VERSION } from '@callmeclaude/protocol';
import { LANGUAGES, MODES, RING_TARGETS, stateLabel, type HubConfig, type View } from '../shared.ts';
import { CallAudio, Ringer } from './audio.ts';
import { trayIcons } from './icons.ts';
import { icon, stateIcon } from './ui-icons.ts';

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
/** Unsent replies to waiting sessions, by pending id (the panel re-renders on every hub update). */
const drafts = new Map<string, string>();
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

const RING_ICON: Record<string, string> = { computer: 'monitor', phone: 'smartphone', off: 'bellOff' };
const MODE_ICON: Record<string, string> = { desk: 'keyboard', away: 'walk', ride: 'bike', sleep: 'moon' };

/** Claude's round avatar, as on the phone's call screen. */
const avatar = (cls = '') => `<div class="avatar ${cls}"><img src="../icon.png" alt=""></div>`;

function callCard(): string {
  if (local?.state === 'ringing') {
    return `<section class="callscreen ringing">
      ${avatar('ring')}
      <h2>Claude is calling</h2>
      <p class="muted">${esc(snapshot?.call?.title ?? 'An update from your sessions')}</p>
      <div class="keys">
        <button class="round red" data-a="decline" title="Decline">${icon('phoneOff')}</button>
        <button class="round green" data-a="answer" title="Answer">${icon('phone')}</button>
      </div>
      <div class="keylabels"><span>Decline</span><span>Answer</span></div>
    </section>`;
  }
  if (local) {
    const talkLines = lines
      .filter((l) => l.role !== 'system' && l.text.trim())
      .slice(-6)
      .map((l) => `<p class="line ${l.role}"><b>${l.role === 'user' ? 'You' : 'Claude'}</b> ${esc(l.text)}</p>`)
      .join('');
    return `<section class="callscreen active">
      ${avatar(local.state === 'connecting' ? 'ring' : 'live')}
      <h2>Claude</h2>
      <p class="muted mono" id="clock">${local.state === 'active' ? clock(Date.now() - callStarted) : 'Connecting…'}</p>
      <div class="transcript">${talkLines || '<p class="muted center">Say hello.</p>'}</div>
      <div class="keys">
        <button class="round ${local.muted ? 'lit' : 'dim'}" data-a="mute" title="${local.muted ? 'Unmute' : 'Mute'}">${icon(local.muted ? 'micOff' : 'mic')}</button>
        <button class="round red" data-a="hangup" title="Hang up">${icon('phoneOff')}</button>
      </div>
      <div class="keylabels"><span>${local.muted ? 'Unmute' : 'Mute'}</span><span>Hang up</span></div>
    </section>`;
  }
  if (snapshot?.call) {
    const where = snapshot.call.on === 'phone' ? 'on your phone' : 'on another computer';
    return `<section class="card elsewhere row">
      <span class="badge green">${icon(snapshot.call.on === 'phone' ? 'smartphone' : 'monitor')}</span>
      <div class="grow"><h3>${snapshot.call.state === 'ringing' ? 'Claude is calling' : 'On a call'} ${where}</h3>
      <p class="muted clip">${esc(snapshot.call.title)}</p></div></section>`;
  }
  const on = link === 'online';
  return `<section class="hero">
    <button class="callbtn" data-a="talk" ${on ? '' : 'disabled'} title="Talk to Claude">${icon('phone')}</button>
    <h2>Talk to Claude</h2>
    <p class="muted">${on ? "Uses this computer's microphone" : 'Waiting for the hub…'}</p>
  </section>`;
}

function offlineCard(): string {
  if (platform === 'win32' && link !== 'online') {
    return `<section class="card warn"><div class="row"><span class="badge orange">${icon('info')}</span><h3>The hub does not run on Windows yet</h3></div>
      <p>CallMeClaude's hub (the part that watches Claude Code and calls you) runs on macOS and Linux today. Windows support is coming; this app connects as soon as a hub runs on this computer.</p></section>`;
  }
  if (link === 'setup') {
    return `<section class="card warn"><div class="row"><span class="badge orange">${icon('terminal')}</span><h3>Set up the hub first</h3></div>
      <p>CallMeClaude's hub runs in the background on this computer and watches your Claude Code sessions. Install it once:</p>
      <pre>git clone https://github.com/wutlu/callmeclaude
cd callmeclaude && pnpm install
cmc setup --gemini-key &lt;KEY&gt;</pre>
      <p class="muted">This window connects as soon as it is running.</p></section>`;
  }
  return `<section class="card warn"><div class="row"><span class="badge orange">${icon('wifiOff')}</span><h3>The hub is not running</h3></div>
    <p>Start it in a terminal with <code>cmc restart</code>. This window reconnects by itself.</p></section>`;
}

/** Marks a session running without a window (a background copy the hub started), so two same-named cards are told apart. */
const BG = ` <span class="bg" title="Runs in the background with no window: a copy CallMeClaude started for a phone or panel instruction.">${icon('layers')}Background</span>`;

function pendingCard(p: PendingCard): string {
  const ask = p.kind === 'permission';
  const risky = p.risk === 'high' || p.risk === 'critical';
  const head = `<section class="card pending ${risky ? 'risky' : ''}">
    <div class="row">
      <span class="badge ${risky ? 'red' : 'orange'}">${icon(ask ? 'shield' : 'question')}</span>
      <div class="grow"><div class="row between"><h3 class="clip">${esc(p.project)}${p.background ? BG : ''}</h3>
      <span class="riskpill ${risky ? 'hot' : ''}">${ask ? esc(p.risk.toUpperCase()) : 'QUESTION'}</span></div></div>
    </div>
    <p class="summary">${esc(p.summary)}</p>`;
  // A waiting session asked something or finished: it needs words, not a yes (a bare "Approved, go ahead." answers nothing).
  if (!ask) {
    return `${head}
    <div class="replybox">
      <textarea class="reply" data-reply="${esc(p.id)}" rows="2" placeholder="Reply to Claude… (Enter sends)">${esc(drafts.get(p.id) ?? '')}</textarea>
      <button class="send" data-a="reply" data-id="${esc(p.id)}" title="Send">${icon('send')}</button>
    </div>
    <div class="row actions">
      <button class="btn small ghost" data-a="resolve" data-id="${esc(p.id)}" data-d="release">${icon('stopCircle')}Let it stop</button>
    </div></section>`;
  }
  return `${head}
    <div class="row actions">
      <button class="btn small green" data-a="resolve" data-id="${esc(p.id)}" data-d="approve">${icon('check')}Approve</button>
      <button class="btn small" data-a="resolve" data-id="${esc(p.id)}" data-d="deny">${icon('x')}Deny</button>
      <button class="btn small ghost" data-a="resolve" data-id="${esc(p.id)}" data-d="release">${icon('stopCircle')}Let it stop</button>
    </div></section>`;
}

function sessionCard(s: SessionCard): string {
  return `<section class="card session">
    <div class="row">
      <span class="sticon st-${s.state}">${stateIcon(s.state)}</span>
      <b class="grow clip">${esc(s.project)}${s.background ? BG : ''}</b>
      <span class="st st-${s.state}">${stateLabel(s.state)}</span>
    </div>
    <p class="muted summary">${esc(s.summary)}</p>
    <span class="time">${relative(s.updatedAt)}</span>
  </section>`;
}

function tiles<T extends string>(name: string, opts: Array<{ id: T; label: string; hint: string }>, icons: Record<string, string>, current: T | undefined, enabled: boolean) {
  const cur = opts.find((o) => o.id === current);
  return `<div class="tiles">${opts
    .map(
      (o) =>
        `<button class="${o.id === current ? 'on' : ''}" data-a="${name}" data-v="${o.id}" ${enabled ? '' : 'disabled'}>${icon(icons[o.id])}<span>${esc(o.label)}</span></button>`,
    )
    .join('')}</div><p class="hint">${cur ? esc(cur.hint) : ''}</p>`;
}

const section = (title: string, count?: number) =>
  `<div class="sechead"><span>${esc(title)}</span>${count ? `<span class="count">${count}</span>` : ''}</div>`;

function render() {
  // Keep the reply being typed (and the caret) across re-renders.
  const typing = document.activeElement as HTMLTextAreaElement | null;
  const typingId = typing?.dataset?.reply;
  const caret = typingId ? [typing!.selectionStart, typing!.selectionEnd] : undefined;
  // Keep the scroll position too: hub updates arrive every few seconds while sessions work.
  const top = document.querySelector('main')?.scrollTop ?? 0;
  renderPanel();
  const main = document.querySelector('main');
  if (main) main.scrollTop = top;
  if (typingId) {
    const t = document.querySelector(`textarea[data-reply="${CSS.escape(typingId)}"]`) as HTMLTextAreaElement | null;
    if (t) {
      t.focus();
      t.setSelectionRange(caret![0], caret![1]);
    }
  }
}

function sendReply(id: string) {
  const text = (drafts.get(id) ?? '').trim();
  const box = document.querySelector(`textarea[data-reply="${CSS.escape(id)}"]`) as HTMLTextAreaElement | null;
  if (!text) return box?.focus();
  drafts.delete(id);
  if (box) box.value = '';
  send({ type: 'pending.resolve', pendingId: id, decision: 'approve', note: text });
}

function renderPanel() {
  const s = snapshot;
  const online = link === 'online' && !!s;
  const closeBtn = platform === 'linux' ? '' : `<button class="icon" data-a="hide" title="Close">${icon('x')}</button>`;
  const status = online ? 'Connected' : link === 'setup' ? 'Not set up' : 'Offline';
  $('#app').innerHTML = `
    <header class="row between">
      <div class="row brand"><img class="logo" src="../icon.png" alt=""><h1>CallMeClaude</h1></div>
      <div class="row"><span class="pill ${online ? 'on' : 'off'}"><i></i>${status}</span>${closeBtn}</div>
    </header>
    <main>
      ${notice ? `<div class="notice row">${icon('info')}<span class="grow">${esc(notice)}</span><button class="link" data-a="dismiss">OK</button></div>` : ''}
      ${online ? '' : offlineCard()}
      ${callCard()}
      ${s?.paused ? `<section class="card warn row"><span class="badge orange">${icon('pause')}</span><div class="grow"><h3>Automation paused</h3><p class="muted">Nothing is approved or held automatically.</p></div><button class="btn small" data-a="resume">Resume</button></section>` : ''}
      ${s?.pending.length ? section('Needs your decision', s.pending.length) + s.pending.map(pendingCard).join('') : ''}
      ${section('When Claude needs you')}
      ${tiles('ring', RING_TARGETS, RING_ICON, s?.ringTarget, online)}
      ${section('Mode')}
      ${tiles('mode', MODES, MODE_ICON, s?.mode, online)}
      ${section('Sessions', s?.sessions.length)}
      ${s?.sessions.length ? s.sessions.map(sessionCard).join('') : `<section class="card"><p class="muted">${online ? 'No open Claude Code sessions.' : 'Waiting for the hub…'}</p></section>`}
      ${section('Settings')}
      <section class="card settings">
        <label class="row setting">${icon('globe')}<span class="grow">Voice language</span>
          <select data-a="language" ${online ? '' : 'disabled'}>${LANGUAGES.map(([c, n]) => `<option value="${c}" ${s?.language === c ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
        </label>
        <label class="row setting">${icon('power')}<span class="grow">Start at login</span><input type="checkbox" class="switch" data-a="login" ${loginItem ? 'checked' : ''}></label>
      </section>
      <button class="btn danger wide" data-a="panic" ${online && !s?.paused ? '' : 'disabled'}>${icon('octagonX')}${confirmPanic ? 'Click again: interrupt all sessions and pause' : 'Stop everything'}</button>
      <p class="foot"><button class="link" data-a="repo">${icon('code')}Source code (MIT)</button>${s ? ` · hub ${esc(s.hubVersion)}` : ''}</p>
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
    case 'reply':
      return sendReply(el.dataset.id!);
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

document.addEventListener('input', (e) => {
  const el = e.target as HTMLTextAreaElement;
  if (el.dataset?.reply) drafts.set(el.dataset.reply, el.value);
});

document.addEventListener('keydown', (e) => {
  const id = (e.target as HTMLElement).dataset?.reply;
  if (id && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    return sendReply(id);
  }
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
