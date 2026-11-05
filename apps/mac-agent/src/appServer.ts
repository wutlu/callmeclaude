import { WebSocketServer, WebSocket } from 'ws';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { AppToHub, HubToApp } from '@callmeclaude/protocol';
import { PROTOCOL_VERSION } from '@callmeclaude/protocol';
import { DATA_DIR, LOG_DIR, saveConfig, writeAtomic, type Mode } from './config.ts';
import type { Hub } from './hub.ts';
import { audit, log, shortId } from './util.ts';

const DEVICES_PATH = join(DATA_DIR, 'devices.json');

interface Device {
  name: string;
  voipToken?: string;
  lastSeen: string;
}

interface Client {
  id: string;
  ws: WebSocket;
  device: string;
  callId?: string;
  /** Last lock state the phone reported; while locked the voice agent may not change anything. */
  locked?: boolean;
}

/** Phone-facing WebSocket server (bind on all interfaces; reach it via Tailscale on the road). */
export class AppServer {
  private wss?: WebSocketServer;
  private clients = new Set<Client>();
  private devices: Record<string, Device> = {};
  private snapTimer?: NodeJS.Timeout;

  constructor(private hub: Hub) {
    if (existsSync(DEVICES_PATH)) {
      try {
        this.devices = JSON.parse(readFileSync(DEVICES_PATH, 'utf8'));
      } catch {}
    }
  }

  start() {
    this.wss = new WebSocketServer({ port: this.hub.cfg.appPort, host: '0.0.0.0', maxPayload: 1 << 20 });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req.socket.remoteAddress ?? '?'));
    this.wss.on('listening', () => log.info(`app server on 0.0.0.0:${this.hub.cfg.appPort}`));
    setInterval(() => this.broadcast({ type: 'heartbeat', ts: new Date().toISOString() }), 15_000);
    this.hub.st.on('changed', () => {
      clearTimeout(this.snapTimer);
      this.snapTimer = setTimeout(() => this.broadcast({ type: 'snapshot', snapshot: this.hub.st.snapshot() }), 300);
    });
  }

  voipToken(): string | undefined {
    return Object.values(this.devices)
      .filter((d) => d.voipToken)
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))[0]?.voipToken;
  }

  /** Returns true if at least one authenticated phone received it. */
  broadcast(msg: HubToApp): boolean {
    const data = JSON.stringify(msg);
    let n = 0;
    for (const c of this.clients) {
      if (c.ws.readyState === WebSocket.OPEN) {
        c.ws.send(data);
        n++;
      }
    }
    return n > 0;
  }

  private saveDevices() {
    writeAtomic(DEVICES_PATH, JSON.stringify(this.devices, null, 1));
  }

  private onConnection(ws: WebSocket, addr: string) {
    let client: Client | undefined;
    const authTimer = setTimeout(() => !client && ws.close(4001, 'auth timeout'), 5000);
    const send = (m: HubToApp) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));

    ws.on('message', async (data, isBinary) => {
      if (isBinary) {
        const call = this.hub.voice.active;
        if (client && call && call.sinkId === client.id) call.pushAudio(data as Buffer);
        return;
      }
      let msg: AppToHub;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!client) {
        if (msg.type !== 'auth' || !safeEq(msg.token, this.hub.cfg.appToken)) {
          audit('app.auth.fail', { addr });
          return ws.close(4003, 'bad token');
        }
        clearTimeout(authTimer);
        client = { id: shortId('ws_'), ws, device: msg.device || 'phone' };
        this.clients.add(client);
        this.touch(client.device);
        audit('app.connect', { addr, device: client.device });
        send({ type: 'hello', v: PROTOCOL_VERSION, snapshot: this.hub.st.snapshot() });
        // A call may be ringing while the app just woke up from the push.
        if (this.hub.calls.ringing) send({ type: 'call.incoming', callId: this.hub.calls.ringing.callId, title: 'Claude' });
        return;
      }
      this.touch(client.device);
      try {
        await this.onMessage(client, msg, send);
      } catch (e) {
        log.error('app message failed', e);
        send({ type: 'error', message: (e as Error).message });
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      if (client) {
        this.clients.delete(client);
        // Only the socket currently carrying the call may suspend it (a late close of an old socket must not).
        const call = this.hub.voice.active;
        if (call && call.sinkId === client.id) call.detach();
      }
    });
    ws.on('error', () => {});
  }

  private touch(device: string) {
    const d = (this.devices[device] ??= { name: device, lastSeen: '' });
    d.lastSeen = new Date().toISOString();
  }

  private async onMessage(c: Client, msg: AppToHub, send: (m: HubToApp) => void) {
    switch (msg.type) {
      case 'ping':
        return send({ type: 'heartbeat', ts: new Date().toISOString() });
      case 'log': {
        const lines = (msg as any).lines as string[];
        if (Array.isArray(lines) && lines.length) {
          appendFileSync(join(LOG_DIR, `app-${new Date().toISOString().slice(0, 10)}.log`), lines.map((l) => `[${c.device}] ${String(l).slice(0, 2000)}`).join('\n') + '\n');
        }
        return;
      }
      case 'push.register':
        this.devices[c.device] = { name: c.device, voipToken: msg.token, lastSeen: new Date().toISOString() };
        this.saveDevices();
        audit('app.push.register', { device: c.device });
        return;
      case 'call.start': {
        const callId = msg.callId ?? shortId('c_');
        c.callId = callId;
        audit('app.call.start', { callId, direction: msg.direction, device: c.device });
        const resumed = this.hub.voice.active?.callId === callId;
        await this.hub.voice.start(callId, msg.direction, {
          id: c.id,
          audio: (pcm) => c.ws.readyState === WebSocket.OPEN && c.ws.send(pcm, { binary: true }),
          json: (m) => send(m),
          locked: () => c.locked === true,
        });
        if (!resumed) send({ type: 'call.ready', callId });
        return;
      }
      case 'device.lock': {
        const was = c.locked === true;
        c.locked = msg.locked === true;
        if (was !== c.locked) audit('app.lock', { device: c.device, locked: c.locked });
        // Unlocked mid-call: an action refused while locked can go ahead now.
        if (was && !c.locked && this.hub.voice.active?.sinkId === c.id)
          this.hub.voice.active.inject('The phone is unlocked now: an action that was refused because the phone was locked can be done if the developer still wants it (ask them to confirm again).', 'now');
        return;
      }
      case 'call.end':
        if (this.hub.voice.active?.callId === msg.callId) this.hub.voice.active.end('phone-hangup');
        else this.hub.calls.declined(msg.callId);
        c.callId = undefined;
        return;
      case 'mode.set':
        this.hub.cfg.mode = msg.mode as Mode;
        this.hub.st.mode = msg.mode;
        saveConfig(this.hub.cfg);
        this.hub.st.changed();
        audit('mode', { mode: msg.mode, via: 'app' });
        return;
      case 'language.set':
        if (typeof msg.language === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(msg.language)) {
          this.hub.cfg.language = msg.language;
          this.hub.st.language = msg.language;
          saveConfig(this.hub.cfg);
          this.hub.st.changed();
          audit('language', { language: msg.language, via: 'app' });
        }
        return;
      case 'panic':
        return this.hub.controller.panic('app');
      case 'resume':
        this.hub.st.paused = false;
        this.hub.st.changed();
        audit('resume', { via: 'app' });
        return;
      case 'pending.resolve': {
        const p = this.hub.st.pending.get(msg.pendingId);
        const s = p && this.hub.st.sessions.get(p.sessionId);
        if (!p || !s) return;
        if (msg.decision === 'release') this.hub.controller.release(s);
        else if (p.kind === 'permission') this.hub.controller.permission(s, msg.decision === 'approve', msg.note);
        else if (msg.decision === 'approve') await this.hub.controller.instruct(s, msg.note || 'Approved, go ahead.');
        else this.hub.controller.release(s);
        return;
      }
    }
  }
}

function safeEq(a: string, b: string) {
  const x = Buffer.from(a ?? '');
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
