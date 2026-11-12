import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mdnsReport, resolvedAnswersMdns, speechReport, speechTool } from '../src/platform/linux.ts';
import { doctorLine } from '../src/cliTexts.ts';

const has = (...bins: string[]) => (b: string) => bins.includes(b);

test('speech: speech-dispatcher first, then espeak-ng, then espeak', () => {
  assert.equal(speechTool(has('espeak', 'espeak-ng', 'spd-say')), 'spd-say');
  assert.equal(speechTool(has('espeak', 'espeak-ng')), 'espeak-ng');
  assert.equal(speechTool(has('espeak')), 'espeak');
  assert.equal(speechTool(has()), undefined);
});

test('speech doctor line: which tool speaks, or a note with the install hint', () => {
  assert.equal(doctorLine('Spoken alerts on this computer', speechReport('spd-say', 'pacman')), '✅ Spoken alerts on this computer: speech-dispatcher (spd-say)');
  assert.match(doctorLine('S', speechReport('espeak-ng', 'apt')), /^✅ S: espeak-ng \(sounds robotic; .*sudo apt install speech-dispatcher\)$/);
  const none = doctorLine('S', speechReport(undefined, 'pacman'));
  assert.match(none, /^ℹ️  S: nothing can speak/);
  assert.match(none, /sudo pacman -S speech-dispatcher espeak-ng$/);
  assert.match(doctorLine('S', speechReport(undefined, 'dnf')), /sudo dnf install speech-dispatcher espeak-ng$/);
  assert.match(doctorLine('S', speechReport(undefined, undefined)), /install with your package manager: speech-dispatcher espeak-ng$/);
});

const RESOLVED_ON = `Global
           Protocols: +LLMNR +mDNS -DNSOverTLS DNSSEC=no/unsupported
    resolv.conf mode: stub

Link 2 (wlan0)
    Current Scopes: DNS LLMNR/IPv4 mDNS/IPv4
         Protocols: +DefaultRoute +LLMNR +mDNS -DNSOverTLS DNSSEC=no/unsupported
`;

test('systemd-resolved answers mDNS only with MulticastDNS on globally and on a link', () => {
  assert.equal(resolvedAnswersMdns(RESOLVED_ON), true);
  assert.equal(resolvedAnswersMdns(RESOLVED_ON.replace('Protocols: +LLMNR +mDNS -DNSOverTLS', 'Protocols: +LLMNR -mDNS -DNSOverTLS')), false);
  assert.equal(resolvedAnswersMdns(RESOLVED_ON.replace('+DefaultRoute +LLMNR +mDNS', '+DefaultRoute +LLMNR mDNS/resolve')), false, 'resolve-only does not answer');
  assert.equal(resolvedAnswersMdns('Global\n  MulticastDNS setting: yes\nLink 2 (eth0)\n  MulticastDNS setting: yes\n'), true, 'older systemd');
  assert.equal(resolvedAnswersMdns(''), false);
});

test('mDNS doctor line: who answers the .local name, or a note with the install hint (no changes made)', () => {
  assert.equal(doctorLine('Bonjour name (mDNS)', mdnsReport('box.local', { avahi: true, resolved: false }, 'apt')), '✅ Bonjour name (mDNS): box.local (avahi-daemon)');
  assert.equal(doctorLine('M', mdnsReport('box.local', { avahi: false, resolved: true }, 'apt')), '✅ M: box.local (systemd-resolved)');
  const off = doctorLine('M', mdnsReport('box.local', { avahi: false, resolved: false }, 'pacman'));
  assert.match(off, /^ℹ️  M: the phone gets box\.local, but nothing here answers it/);
  assert.match(off, /sudo pacman -S avahi && sudo systemctl enable --now avahi-daemon$/);
  assert.match(doctorLine('M', mdnsReport('box.local', { avahi: false, resolved: false }, 'apt')), /sudo apt install avahi-daemon &&/);
  assert.match(doctorLine('M', mdnsReport(undefined, { avahi: false, resolved: false }, 'apt')), /^ℹ️  M: no \.local name/);
});
