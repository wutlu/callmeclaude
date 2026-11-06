import { chmodSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import qrcode from 'qrcode-terminal';
import QR from 'qrcode';
import type { PairingInfo } from '@callmeclaude/protocol';
import { PROTOCOL_VERSION } from '@callmeclaude/protocol';
import { CONFIG_PATH, LOG_DIR, loadConfig, parseVoiceSessionsAnswer, planVoiceSessions, saveConfig, voiceSessionMode, type Mode, type VoiceSessions } from './config.ts';
import { getSecret, setSecret } from './secrets.ts';
import { hooksInstalled, installHooks, installService, restartService, uninstallHooks, uninstallService, SERVICE } from './install.ts';
import { platform, SecretStoreError } from './platform/index.ts';
import type { DoctorResult } from './platform/types.ts';
import { onPath } from './platform/linux.ts';
import { execFileP } from './util.ts';
import { hubUrls, lanIps, mdnsName, tailscaleInfo } from './addresses.ts';
import { apnsConfigured, apnsTexts } from './apns.ts';
import { doctorLine, geminiKeySavedText, helpText, pairTexts, projectRootsResult, voipTokenTexts } from './cliTexts.ts';

const [cmd = 'help', ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);

function parseFlags(a: string[]) {
  const f: Record<string, string | true> = {};
  const pos: string[] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) {
      const k = a[i].slice(2);
      const v = a[i + 1];
      if (v !== undefined && !v.startsWith('--')) {
        f[k] = v;
        i++;
      } else f[k] = true;
    } else pos.push(a[i]);
  }
  (f as any)._ = pos;
  return f as Record<string, string | true> & { _: string[] };
}

async function api(path: string, body?: object) {
  const cfg = loadConfig();
  const r = await fetch(`http://127.0.0.1:${cfg.hookPort}/control/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${cfg.hookToken}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json() as Promise<any>;
}

/** Restart the background service (launchd / systemd --user) and wait until the hub answers. */
async function restartAndWait() {
  await restartService();
  const cfg = loadConfig();
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${cfg.hookPort}/health`)).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Store a secret; if the OS secret store is unavailable (Linux without libsecret), explain instead of crashing. */
function storeSecret(fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch (e) {
    if (!(e instanceof SecretStoreError)) throw e;
    console.log(`❌ ${e.message}`);
    process.exitCode = 1;
    return false;
  }
}

/** Linux `cmc setup`: one question — run voice-started sessions in tmux or headless (`claude -p`)? */
async function askVoiceSessions(tmuxInstalled: boolean): Promise<VoiceSessions> {
  console.log('\nSessions you start by voice can run in two ways:');
  if (tmuxInstalled) {
    console.log('  1) tmux     — a detached tmux session; watch it with `tmux attach` (default)');
    console.log('  2) headless — a background `claude -p`; no tmux needed');
  } else {
    console.log('  1) headless — a background `claude -p`; no tmux needed (default)');
    console.log('  2) tmux     — tmux is not installed: install it first (e.g. apt install tmux / dnf install tmux / pacman -S tmux),');
    console.log('                then you can watch voice-started sessions with `tmux attach`');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // stdin closed (Ctrl+D): take the default instead of hanging.
  const closed = new Promise<string>((r) => rl.once('close', () => r('')));
  try {
    for (;;) {
      const choice = parseVoiceSessionsAnswer(await Promise.race([rl.question('Choice [1]: '), closed]), tmuxInstalled);
      if (choice) return choice;
      console.log('Please answer 1 or 2 (or press Enter for 1).');
    }
  } finally {
    rl.close();
  }
}

async function main() {
  switch (cmd) {
    case 'serve': {
      const { Hub } = await import('./hub.ts');
      new Hub().start();
      return;
    }

    case 'setup': {
      const cfg = loadConfig();
      if (typeof flags['gemini-key'] === 'string' && storeSecret(() => setSecret('gemini-api-key', flags['gemini-key'] as string))) {
        const saved = geminiKeySavedText(platform.id, platform.secrets.displayName);
        if (saved) console.log(saved);
      }
      if (typeof flags['apns-key-file'] === 'string') storeSecret(() => setSecret('apns-p8', readFileSync(flags['apns-key-file'] as string, 'utf8')));
      if (typeof flags['apns-key-id'] === 'string') cfg.apns.keyId = flags['apns-key-id'];
      if (typeof flags['team-id'] === 'string') cfg.apns.teamId = flags['team-id'];
      if (typeof flags['bundle-id'] === 'string') cfg.apns.bundleId = flags['bundle-id'];
      if (typeof flags['apns-env'] === 'string') cfg.apns.environment = flags['apns-env'] as any;
      if (typeof flags.voice === 'string') cfg.voice.voiceName = flags.voice;
      if (typeof flags.model === 'string') cfg.voice.model = flags.model;
      if (typeof flags.language === 'string') cfg.language = flags.language;
      const tmuxInstalled = onPath('tmux');
      let sessions: VoiceSessions | 'ask' | undefined;
      try {
        sessions = planVoiceSessions({ os: platform.id, flags, interactive: !!(process.stdin.isTTY && process.stdout.isTTY), tmuxInstalled });
      } catch (e) {
        console.log(`❌ ${(e as Error).message}`);
        process.exitCode = 1;
        return;
      }
      if (sessions === 'ask') sessions = await askVoiceSessions(tmuxInstalled);
      if (sessions) cfg.voiceSessions = sessions;
      saveConfig(cfg);
      if (!flags['no-hooks']) {
        installHooks(cfg);
        console.log('✅ Claude Code hooks merged into ~/.claude/settings.json (backup saved).');
      }
      if (!flags['no-service']) {
        await installService();
        console.log(`✅ ${SERVICE.displayName} service installed: ${SERVICE.definitionPath}`);
      }
      if (!getSecret('gemini-api-key')) console.log('⚠️  No Gemini API key: cmc setup --gemini-key <KEY>  (https://aistudio.google.com/apikey)');
      if (!apnsConfigured(cfg)) console.log(apnsTexts(platform.id).setupMissing);
      console.log(`Voice language: ${cfg.language}  (change with --language, e.g. en-US, tr-TR, de-DE)`);
      if (sessions) {
        console.log(`Voice-started sessions: ${sessions}  (change with --tmux / --no-tmux)`);
        if (sessions === 'tmux' && !tmuxInstalled) console.log('⚠️  tmux is not installed: install it, or run cmc setup --no-tmux');
      }
      console.log('Next: cmc pair  (scan the QR code with the app)');
      return;
    }

    case 'pair': {
      const cfg = loadConfig();
      if (flags.rotate) {
        cfg.appToken = randomBytes(24).toString('base64url');
        saveConfig(cfg);
        await restartAndWait().catch(() => {});
      }
      const ts = await tailscaleInfo();
      const urls = hubUrls(cfg.appPort, ts, lanIps(), mdnsName());
      const info: PairingInfo = { v: PROTOCOL_VERSION, name: hostname().replace(/\.local$/, ''), urls, token: cfg.appToken };
      const text = JSON.stringify(info);
      qrcode.generate(text, { small: true });
      const png = join(CONFIG_PATH, '..', 'pair.png');
      // The QR holds the token: only this user may read it.
      await QR.toFile(png, text, { width: 640, margin: 2 });
      chmodSync(png, 0o600);
      if (!flags['no-open']) platform.openFile(png);
      const say = pairTexts(platform.id);
      console.log(say.scan);
      console.log(text);
      if (!ts.ip) console.log(say.noTailscale);
      return;
    }

    case 'status': {
      try {
        const r = await api('status');
        const s = r.snapshot;
        console.log(`Mode: ${s.mode}${s.paused ? ' (PAUSED)' : ''} · call: ${r.voiceActive ? 'active' : r.ringing ? 'ringing' : 'none'} · queued: ${r.queued} · language: ${s.language}`);
        for (const x of s.sessions) console.log(`  ${x.state.padEnd(18)} ${x.project.padEnd(28)} ${x.summary}`);
        if (s.pending.length) console.log('Pending decisions:');
        for (const p of s.pending) console.log(`  [${p.risk}] ${p.project}: ${p.summary}`);
      } catch {
        console.log('❌ Hub is not running. Try `cmc restart`, `cmc logs`, or `cmc setup`.');
        process.exitCode = 1;
      }
      return;
    }

    case 'call-me': {
      const r = await api('call-me', { text: typeof flags.text === 'string' ? flags.text : undefined });
      console.log(r.viaSocket || r.viaPush ? `📞 Calling (socket: ${r.viaSocket}, push: ${r.viaPush})` : '❌ Could not reach the phone (app not connected and APNs not configured).');
      return;
    }

    case 'do': {
      const task = flags._.join(' ');
      if (!task) return console.log(`usage: cmc do "<what the hub should do on ${platform.words.this}>"`);
      console.log('⏳ The hub is working on it…');
      const r = await api('do', { task, project: typeof flags.project === 'string' ? flags.project : undefined });
      return console.log(r.result);
    }

    case 'mode': {
      const m = flags._[0] as Mode;
      if (!['desk', 'away', 'ride', 'sleep'].includes(m)) return console.log('usage: cmc mode desk|away|ride|sleep');
      await api('mode', { mode: m });
      return console.log(`Mode: ${m}`);
    }

    case 'panic':
      await api('panic', {});
      return console.log('🛑 All sessions interrupted; automation paused. Undo with: cmc resume');
    case 'resume':
      await api('resume', {});
      return console.log('▶️  Automation resumed.');

    case 'run': {
      // Start an interactive Claude Code session inside tmux so the hub can type into it.
      if (platform.id === 'linux' && !onPath('tmux')) {
        console.log('❌ cmc run needs tmux, which is not installed. Install it (e.g. apt install tmux), or just run `claude` —\n   the hub still watches it, holds it and calls you; only typing into it from the phone needs tmux.');
        process.exitCode = 1;
        return;
      }
      const dir = flags._[0] ?? process.cwd();
      const task = flags._.slice(1).join(' ');
      const name = 'cmc-' + dir.split('/').filter(Boolean).pop()!.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20) + '-' + Date.now().toString(36).slice(-4);
      const args = ['new-session', '-s', name, '-c', dir, 'claude', ...(task ? [task] : [])];
      if (!process.stdout.isTTY) args.splice(1, 0, '-d');
      spawnSync('tmux', args, { stdio: 'inherit' });
      return;
    }

    case 'ignore': {
      // cmc ignore [path] | cmc ignore --remove path | cmc ignore --list
      const cfg = loadConfig();
      const target = flags._[0] ?? process.cwd();
      if (flags.list) return console.log(cfg.ignorePaths.join('\n') || '(none)');
      cfg.ignorePaths = cfg.ignorePaths.filter((p) => p !== target);
      if (!flags.remove) cfg.ignorePaths.push(target);
      saveConfig(cfg);
      await restartAndWait().catch(() => {});
      return console.log(`${flags.remove ? 'Back to normal (may hold sessions and call you)' : 'Watch-only (status is reported; never held, never calls)'}: ${target}`);
    }

    case 'doctor':
      return doctor();

    case 'logs': {
      const files = readdirSync(LOG_DIR).filter((f) => f.startsWith('hub-')).sort();
      const last = files.at(-1);
      if (!last) return console.log('no logs yet');
      spawnSync('tail', ['-n', String(flags.n ?? 80), ...(flags.f ? ['-f'] : []), join(LOG_DIR, last)], { stdio: 'inherit' });
      return;
    }

    case 'restart':
      return console.log((await restartAndWait()) ? 'Hub restarted.' : '❌ The hub did not start: cmc logs');

    case 'uninstall':
      uninstallHooks();
      await uninstallService();
      return console.log(`Hooks and service removed. Your data is still in ${CONFIG_PATH} (delete it manually if you like).`);

    case 'type-text':
      // Internal, Linux only: the computer task's agent types text with it (see platform/clipboard.ts).
      // On macOS it is an unknown command like any other and falls through to the help text.
      if (platform.id === 'linux') return typeTextCommand(process.argv.slice(3));
    // falls through
    default:
      console.log(helpText(platform.id, platform.secrets.displayName, platform.words.this));
  }
}

/** `cmc type-text [--terminal] -- text` (or the text on stdin): paste into the focused field, keep the clipboard. */
async function typeTextCommand(args: string[]) {
  const { linuxComputerDriver } = await import('./platform/linux.ts');
  const { spawnRunner, typeText } = await import('./platform/clipboard.ts');
  const { audit, sleep } = await import('./util.ts');
  const { ensureDirs } = await import('./config.ts');
  ensureDirs();
  const sep = args.indexOf('--');
  const opts = sep === -1 ? args : args.slice(0, sep);
  let text = sep === -1 ? '' : args.slice(sep + 1).join(' ');
  if (sep === -1) {
    if (process.stdin.isTTY) {
      console.log("usage: cmc type-text [--terminal] -- 'text'   (or the text on stdin)");
      process.exitCode = 2;
      return;
    }
    for await (const c of process.stdin) text += c;
  }
  const d = linuxComputerDriver(process.env);
  const r = await typeText(text, { clipboard: d.clipboard, input: d.input, session: d.env.session, terminal: opts.includes('--terminal'), run: spawnRunner, sleep });
  // Never the text itself: it may be anything the developer dictated.
  audit('computer.type', { chars: [...text].length, via: r.via, clipboard: r.clipboard, ok: r.ok });
  console.log(r.message);
  if (!r.ok) process.exitCode = 1;
}

async function doctor() {
  const cfg = loadConfig();
  const check = async (name: string, fn: () => Promise<DoctorResult>) => {
    try {
      console.log(doctorLine(name, await fn()));
    } catch (e) {
      console.log(`❌ ${name}: ${(e as Error).message}`);
    }
  };
  await check('Claude Code installed', async () => (await execFileP('claude', ['--version'])).stdout.trim());
  await check('Claude Code login (your own plan)', async () => {
    const { stdout } = await execFileP('claude', ['-p', 'Reply with just OK.', '--model', 'haiku', '--max-turns', '1'], { timeout: 60_000, env: { ...process.env, CMC_INTERNAL: '1' } });
    return stdout.trim() ? 'working' : '!empty reply';
  });
  await check('Hooks installed', async () => hooksInstalled());
  await check('Hub running', async () => {
    const r = await fetch(`http://127.0.0.1:${cfg.hookPort}/health`);
    return r.ok;
  });
  await check('Gemini API key', async () => !!getSecret('gemini-api-key'));
  const apns = apnsTexts(platform.id);
  await check(apns.doctorName, async () => (apnsConfigured(cfg) ? `${cfg.apns.environment}` : apns.doctorMissing));
  const voip = voipTokenTexts(platform.id);
  await check(voip.doctorName, async () => {
    const p = join(CONFIG_PATH, '..', 'devices.json');
    return voip.result(existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : undefined);
  });
  await check('Tailscale', async () => {
    const t = await tailscaleInfo();
    return t.ip ? `${t.dns ?? t.ip}` : '!not connected (no access on the road)';
  });
  if (platform.id === 'linux' && voiceSessionMode(cfg) === 'headless') await check('tmux', async () => 'optional (disabled)');
  else await check('tmux', async () => (await execFileP('tmux', ['-V'])).stdout.trim());
  for (const c of platform.doctorChecks()) await check(c.name, c.fn);
  await check('Mode', async () => cfg.mode);
  await check('Voice language', async () => cfg.language);
  if (platform.id === 'linux') await check('Project roots (where voice-started sessions may run)', async () => projectRootsResult(cfg.projectRoots, homedir(), CONFIG_PATH));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
