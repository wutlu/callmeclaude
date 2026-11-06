import {
  EndSensitivity,
  FunctionResponseScheduling,
  GoogleGenAI,
  Modality,
  type LiveServerMessage,
  type Session as LiveSession,
} from '@google/genai';
import type { HubToApp } from '@callmeclaude/protocol';
import type { Hub } from '../hub.ts';
import type { CallItem } from '../calls.ts';
import { geminiKeyProblem, getSecret } from '../secrets.ts';
import { audit, clip, log, redact } from '../util.ts';
import { briefing, systemPrompt } from './prompt.ts';
import { declarations, LONG_TOOLS, runTool } from './tools.ts';

export interface CallSink {
  /** Identifies the phone socket currently carrying this call. */
  id: string;
  audio(pcm24k: Buffer): void;
  json(msg: HubToApp): void;
  /** Which app carries the call (absent = phone). */
  kind?: 'phone' | 'desktop';
  /** True while the phone is on its lock screen: no actions that change anything. */
  locked?(): boolean;
}

/**
 * One phone conversation, bridged to Gemini Live (speech-to-speech).
 * The voice model is the fast "receptionist"; real work goes through hub tools → Claude.
 */
export class VoiceCall {
  private live?: LiveSession;
  private handle?: string;
  private speaking = false;
  private ended = false;
  private idleQueue: string[] = [];
  /** The decision the developer was last asked about; later questions wait until it is answered. */
  private asking?: string;
  private questions: Array<{ text: string; pendingId: string }> = [];
  private onState = () => this.nextQuestion();
  private lastActivity = Date.now();
  private silencePrompted = false;
  private watchdog?: NodeJS.Timeout;
  private reconnects = 0;
  private userText = '';
  private botText = '';
  private ending = false;
  /** When the phone will finish playing the audio sent so far (24 kHz PCM16 mono = 48 000 bytes/s). */
  private playUntil = 0;
  /** Last time a microphone frame arrived; the phone streams continuously during a call. */
  private lastAudioAt = 0;
  private stats = { micBytes: 0, outBytes: 0, startedAt: Date.now(), firstMicMs: -1, firstOutMs: -1, reattached: 0 };
  private detachTimer?: NodeJS.Timeout;
  transcript: Array<{ role: string; text: string }> = [];

  constructor(
    private hub: Hub,
    readonly callId: string,
    private direction: 'inbound' | 'outbound',
    private agenda: CallItem[],
    private sink: CallSink,
    private onEnded: (reason: string) => void,
  ) {}

  async start() {
    await this.connect();
    const opening =
      this.direction === 'outbound'
        ? `[SYSTEM] YOU called the developer and they picked up. Greet briefly (e.g. "Hi, it's Claude."), then go through the first agenda item and ask.`
        : `[SYSTEM] The developer called you. Greet briefly, sum up the state in one sentence (how many sessions, anything pending) and ask what they want to do.`;
    const lock = this.sink.locked?.() ? '\n\nTHE PHONE IS LOCKED: you can report status and answer questions, but anything that changes something needs the developer to unlock the phone first.' : '';
    this.send(`${opening}\n\nCURRENT STATE:\n${briefing(this.hub, this.agenda)}${lock}`);
    this.watchdog = setInterval(() => this.checkSilence(), 2000);
    this.hub.st.on('changed', this.onState);
  }

  private async connect() {
    const apiKey = getSecret('gemini-api-key');
    if (!apiKey) throw new Error(geminiKeyProblem());
    const ai = new GoogleGenAI({ apiKey });
    const v = this.hub.cfg.voice;
    this.live = await ai.live.connect({
      model: v.model,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: systemPrompt(this.hub, undefined, this.sink.kind === 'desktop' ? 'desktop' : 'phone'),
        tools: [{ functionDeclarations: declarations }],
        speechConfig: { languageCode: this.hub.cfg.language, voiceConfig: { prebuiltVoiceConfig: { voiceName: v.voiceName } } },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        sessionResumption: this.handle ? { handle: this.handle } : {},
        contextWindowCompression: { slidingWindow: {} },
        realtimeInputConfig: {
          // Helmet + wind: be conservative about deciding the developer finished speaking.
          automaticActivityDetection: { endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW, silenceDurationMs: 700 },
        },
      },
      callbacks: {
        onmessage: (m) => this.onMessage(m),
        onerror: (e) => log.warn('gemini live error', (e as any)?.message ?? e),
        onclose: (e) => this.onClose(e as any),
      },
    });
  }

  private onClose(e: { code?: number; reason?: string }) {
    if (this.ended) return;
    log.warn('gemini live closed', e?.code, e?.reason);
    if (this.reconnects++ < 3) {
      this.connect().catch((err) => {
        log.error('gemini reconnect failed', err);
        this.end('voice-error');
      });
    } else this.end('voice-error');
  }

  /** Phone reconnected (same callId): route audio/messages to the new socket. */
  attach(sink: CallSink) {
    clearTimeout(this.detachTimer);
    this.detachTimer = undefined;
    const moved = (sink.kind ?? 'phone') !== (this.sink.kind ?? 'phone');
    this.sink = sink;
    if (moved)
      this.send(
        sink.kind === 'desktop'
          ? '[SYSTEM] The call moved to the computer: the developer now talks through the computer and can see the screen. Carry on, no need to mention it.'
          : '[SYSTEM] The call moved to the phone: the developer may be away from the screen now. Carry on, no need to mention it.',
      );
    this.lastAudioAt = Date.now();
    this.stats.reattached++;
    log.info('call re-attached', this.callId);
  }

  /** Phone socket closed mid-call: keep the conversation alive briefly for a reconnect. */
  get sinkId() {
    return this.sink.id;
  }

  detach() {
    if (this.ended || this.detachTimer) return;
    log.info('call detached, waiting for phone', this.callId);
    this.detachTimer = setTimeout(() => this.end('phone-disconnected'), 20_000);
  }

  pushAudio(pcm16k: Buffer) {
    this.lastAudioAt = Date.now();
    this.stats.micBytes += pcm16k.length;
    if (this.stats.firstMicMs < 0) this.stats.firstMicMs = Date.now() - this.stats.startedAt;
    if (this.ended || !this.live) return;
    this.live.sendRealtimeInput({ audio: { data: pcm16k.toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
  }

  /**
   * Tell the developer something mid-call. 'idle' waits until the assistant stops talking.
   * A new decision (pendingId) waits until the previous one is answered: one question at a time.
   */
  inject(text: string, when: 'now' | 'idle', pendingId?: string) {
    if (pendingId) {
      if (this.isOpen(this.asking) && this.asking !== pendingId) {
        if (!this.questions.some((q) => q.pendingId === pendingId)) this.questions.push({ text, pendingId });
        return;
      }
      this.asking = pendingId;
    }
    if (when === 'idle' && this.speaking) this.idleQueue.push(text);
    else this.send(`[SYSTEM] New update, relay it briefly at a good moment: ${text}`);
  }

  private isOpen(pendingId?: string) {
    return !!pendingId && this.hub.st.pending.get(pendingId)?.status === 'open';
  }

  /** The last decision was answered (or went away): bring up the next one still open. */
  private nextQuestion() {
    if (this.ended || this.isOpen(this.asking)) return;
    this.asking = undefined;
    let q;
    while ((q = this.questions.shift()) && !this.isOpen(q.pendingId));
    if (q) this.inject(q.text, 'idle', q.pendingId);
  }

  private send(text: string) {
    this.live?.sendClientContent({ turns: [{ role: 'user', parts: [{ text: redact(text) }] }], turnComplete: true });
  }

  private onMessage(m: LiveServerMessage) {
    if (m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate.newHandle) this.handle = m.sessionResumptionUpdate.newHandle;
    if (m.goAway) {
      log.info('gemini goAway, reconnecting with handle');
      this.reconnects = 0;
      try {
        this.live?.close();
      } catch {}
      return;
    }
    const sc = m.serverContent;
    if (sc) {
      for (const p of sc.modelTurn?.parts ?? []) {
        if (p.inlineData?.data && p.inlineData.mimeType?.startsWith('audio/')) {
          this.speaking = true;
          const b = Buffer.from(p.inlineData.data, 'base64');
          this.stats.outBytes += b.length;
          if (this.stats.firstOutMs < 0) this.stats.firstOutMs = Date.now() - this.stats.startedAt;
          this.sink.audio(b);
          this.playUntil = Math.max(this.playUntil, Date.now()) + (b.length / 48_000) * 1000;
        }
      }
      if (sc.inputTranscription?.text) {
        this.userText += sc.inputTranscription.text;
        this.lastActivity = Date.now();
        this.silencePrompted = false;
        this.sink.json({ type: 'transcript', role: 'user', text: this.userText, final: false });
      }
      if (sc.outputTranscription?.text) {
        this.botText += sc.outputTranscription.text;
        this.sink.json({ type: 'transcript', role: 'assistant', text: this.botText, final: false });
      }
      if (sc.interrupted) {
        this.speaking = false;
        this.playUntil = 0;
        this.sink.json({ type: 'audio.flush' });
      }
      if (sc.turnComplete) {
        this.speaking = false;
        this.lastActivity = Date.now();
        this.flushTurnText();
        // Hang up only after the goodbye has finished playing on the phone.
        if (this.ending) return void setTimeout(() => this.end('assistant-ended'), Math.max(0, this.playUntil - Date.now()) + 700);
        const next = this.idleQueue.shift();
        if (next) this.inject(next, 'now');
      }
    }
    if (m.toolCall?.functionCalls) {
      for (const fc of m.toolCall.functionCalls) void this.handleTool(fc.id!, fc.name!, fc.args ?? {});
    }
  }

  private flushTurnText() {
    if (this.userText) {
      this.transcript.push({ role: 'user', text: this.userText });
      this.sink.json({ type: 'transcript', role: 'user', text: this.userText, final: true });
    }
    if (this.botText) {
      this.transcript.push({ role: 'assistant', text: this.botText });
      this.sink.json({ type: 'transcript', role: 'assistant', text: this.botText, final: true });
    }
    this.userText = '';
    this.botText = '';
  }

  private async handleTool(id: string, name: string, args: Record<string, unknown>) {
    this.lastActivity = Date.now();
    let response: Record<string, unknown>;
    try {
      response = await runTool(this.hub, name, args, { endCall: () => (this.ending = true), locked: () => this.sink.locked?.() ?? false });
    } catch (e) {
      response = { error: (e as Error).message };
    }
    if (this.ended) return this.afterCall(name, args, response);
    this.lastActivity = Date.now();
    const long = LONG_TOOLS.has(name);
    this.live?.sendToolResponse({
      functionResponses: [
        {
          id,
          name,
          response: JSON.parse(redact(JSON.stringify(response))),
          ...(long ? { scheduling: FunctionResponseScheduling.WHEN_IDLE } : {}),
        },
      ],
    });
  }

  /** A computer task finished after the call ended: its result must not be lost, so call the developer back with it. */
  private afterCall(name: string, args: Record<string, unknown>, response: Record<string, unknown>) {
    if (name !== 'computer_task' || response.needs_confirmation || response.error) return;
    const goal = args.goal ? ` The developer's whole request was: "${String(args.goal)}". Tell them the result and continue with the remaining steps (ask before starting anything).` : ' Tell the developer the result and ask what to do next.';
    this.hub.calls.enqueue({
      priority: 'P1',
      title: 'Computer task done',
      text: `The computer task "${String(args.task ?? '')}" finished after the last call. Result: ${clip(String(response.result ?? ''), 1500)}.${goal}`,
      requested: true,
    });
  }

  private checkSilence() {
    if (this.ended) return;
    // Phone hung up or the link dropped without a call.end (cellular/intercom drop-outs).
    if (!this.detachTimer && this.lastAudioAt && Date.now() - this.lastAudioAt > 20_000) return this.end('phone-lost');
    if (this.detachTimer) return;
    if (this.speaking) return;
    const quiet = Date.now() - this.lastActivity;
    if (quiet > 25_000 && !this.silencePrompted) {
      this.silencePrompted = true;
      this.send('[SYSTEM] The developer has been silent for a while. Briefly ask whether they are still there.');
    } else if (quiet > 50_000 && this.silencePrompted) {
      this.end('silence');
    }
  }

  end(reason: string) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.watchdog);
    this.hub.st.off('changed', this.onState);
    clearTimeout(this.detachTimer);
    const st = {
      ...this.stats,
      micSeconds: +(this.stats.micBytes / 32000).toFixed(1),
      outSeconds: +(this.stats.outBytes / 48000).toFixed(1),
      durationSeconds: Math.round((Date.now() - this.stats.startedAt) / 1000),
    };
    log.info('call stats', this.callId, reason, JSON.stringify(st));
    audit('call.stats', { callId: this.callId, reason, ...st });
    this.flushTurnText();
    try {
      this.live?.close();
    } catch {}
    audit('call.end', { callId: this.callId, reason, transcript: this.transcript });
    this.sink.json({ type: 'call.ended', callId: this.callId, reason });
    this.onEnded(reason);
  }
}
