// CallMeClaude Hub <-> App protocol. See docs/protocol.md.
// Text frames carry JSON control messages; binary frames carry audio:
//   App -> Hub: PCM16 LE mono 16 kHz (microphone)
//   Hub -> App: PCM16 LE mono 24 kHz (assistant voice)

export const PROTOCOL_VERSION = 1 as const;
export const MIC_SAMPLE_RATE = 16000;
export const SPEAKER_SAMPLE_RATE = 24000;

export type SessionState =
  | 'running'
  | 'waiting_permission'
  | 'waiting_input'
  | 'blocked'
  | 'done'
  | 'errored'
  | 'stale'
  | 'ended';

export type Mode = 'desk' | 'away' | 'ride' | 'sleep';
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export type Risk = 'low' | 'medium' | 'high' | 'critical';
/** Where the hub rings: the desktop app on this computer, the phone, or nowhere (updates wait for the next conversation). */
export type RingTarget = 'computer' | 'phone' | 'off';
/** Where the hub says "<project>: task complete." when a Claude Code session finishes a turn: out loud on this computer, on the phone, or not at all. */
export type DoneAlertTarget = 'off' | 'computer' | 'phone';
/** Which kind of app is connected. Absent in auth = phone (older apps). */
export type ClientKind = 'phone' | 'desktop';

/** The call right now, so every app can show it (the desktop tray turns green while the phone talks). */
export interface CallInfo {
  callId: string;
  state: 'ringing' | 'active';
  /** Where it rings / where it is being talked on. */
  on: ClientKind;
  title: string;
}

export type SubagentState = 'running' | 'done';

export interface SubagentCard {
  id: string;
  /** Agent type from Claude Code, e.g. "Explore" or a custom agent name. */
  type: string;
  state: SubagentState;
  /** What the subagent reported when it finished. */
  summary?: string;
}

export interface SessionCard {
  id: string;
  project: string;
  cwd: string;
  state: SessionState;
  /** Phone-friendly one-liner, in the configured language. */
  summary: string;
  updatedAt: string;
  controllable: Array<'hold' | 'tmux' | 'resume' | 'queue'>;
  /** Runs headless with no window (a background copy or a resumed session): nobody can type into it. */
  background?: boolean;
  /** Subagents this session has spawned, running first. Absent when there are none. */
  subagents?: SubagentCard[];
}

export interface PendingCard {
  id: string;
  sessionId: string;
  project: string;
  kind: 'permission' | 'stop';
  summary: string;
  risk: Risk;
  createdAt: string;
  deadline: string;
  /** Asked by a session running in the background (see SessionCard.background). */
  background?: boolean;
}

export interface Snapshot {
  mode: Mode;
  /** Voice/summary language, BCP-47 (e.g. en-US, tr-TR). */
  language: string;
  sessions: SessionCard[];
  pending: PendingCard[];
  hubVersion: string;
  paused: boolean;
  ringTarget?: RingTarget;
  /** Absent from older hubs (no spoken alerts). */
  doneAlert?: DoneAlertTarget;
  call?: CallInfo;
}

export type HubToApp =
  /** urls: the hub's addresses right now; the app replaces its saved ones so a new Wi-Fi doesn't need re-pairing. */
  | { type: 'hello'; v: typeof PROTOCOL_VERSION; snapshot: Snapshot; urls?: string[] }
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'heartbeat'; ts: string }
  | { type: 'call.incoming'; callId: string; title: string }
  | { type: 'call.ready'; callId: string }
  | { type: 'call.ended'; callId: string; reason: string }
  | { type: 'audio.flush' }
  | { type: 'transcript'; role: 'user' | 'assistant' | 'system'; text: string; final: boolean }
  | { type: 'error'; message: string }
  /** Say this out loud now with the device's own voice, in `language` (BCP-47). Sent to phones when doneAlert is 'phone'. */
  | { type: 'announce'; text: string; language: string };

export type AppToHub =
  | { type: 'auth'; token: string; device: string; v: number; kind?: ClientKind }
  | { type: 'call.start'; callId?: string; direction: 'inbound' | 'outbound' }
  | { type: 'call.end'; callId: string }
  | { type: 'mode.set'; mode: Mode }
  | { type: 'language.set'; language: string }
  | { type: 'ring.set'; target: RingTarget }
  | { type: 'alert.set'; target: DoneAlertTarget }
  | { type: 'panic' }
  | { type: 'resume' }
  | { type: 'push.register'; token: string; kind: 'voip' }
  | { type: 'pending.resolve'; pendingId: string; decision: 'approve' | 'deny' | 'release'; note?: string }
  | { type: 'ping' }
  /** The phone's screen lock (secure lock screen showing). Sent on connect and on every change; absent = unknown (treated as unlocked). */
  | { type: 'device.lock'; locked: boolean }
  | { type: 'log'; lines: string[] };

/** Contents of the VoIP push. Kept minimal: details are fetched over the tailnet. */
export interface PushPayload {
  cmc: { v: typeof PROTOCOL_VERSION; callId: string; title: string; priority: Priority };
}

/** QR code contents produced by `cmc pair`. */
export interface PairingInfo {
  v: typeof PROTOCOL_VERSION;
  name: string;
  urls: string[];
  token: string;
}
